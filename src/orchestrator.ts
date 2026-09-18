import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, EvidenceValidation, LensName, Task, WorkerResult } from './types.js';
import { validateEvidence } from './evidenceValidator.js';
import { runDirPaths } from './runDir.js';
import { DecisionLog } from './decisions.js';
import { makeLogger } from './logger.js';
import type { WorkerInput } from './worker.js';
import type { LensRunnerInput, LensRunnerResult } from './review/lensRunner.js';
import { LENS_NAMES } from './review/lenses.js';

const log = makeLogger('orchestrator');

const WORKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const LENS_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review', 'lensRunner.js');

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

function normalizeFailure(task: Task, summary: string, error?: string): WorkerResult {
  return { taskId: task.id, status: 'error', changedFiles: [], summary, usage: ZERO_USAGE, error };
}

/**
 * Форкает ОДИН отдельный процесс-воркер на одну задачу и ждёт его результат
 * через IPC. Никогда не бросает исключение наружу — любой сбой нормализуется
 * в WorkerResult со статусом 'error'/'timeout'.
 */
function runOneWorker(task: Task, workdir: string, runDir: string, maxAttempts: number, timeoutSec: number): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(WORKER_ENTRY, [], { stdio: 'inherit' });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        taskId: task.id,
        status: 'timeout',
        changedFiles: [],
        summary: `задача ${task.id}: таймаут воркера (${timeoutSec}s)`,
        usage: ZERO_USAGE,
      });
    }, timeoutSec * 1000);

    child.once('message', (result: WorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeFailure(task, `задача ${task.id}: процесс воркера завершился без результата (code ${code})`));
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeFailure(task, `задача ${task.id}: ошибка процесса воркера`, err.message));
    });

    const input: WorkerInput = { task, workdir, runDir, maxAttempts };
    child.send(input);
  });
}

function toWorkerResult(task: Task, settled: PromiseSettledResult<WorkerResult>): WorkerResult {
  if (settled.status === 'fulfilled') return settled.value;
  const reason = settled.reason;
  return normalizeFailure(task, `задача ${task.id}: воркер упал с необработанным исключением`, reason instanceof Error ? reason.message : String(reason));
}

export type DispatchOptions = {
  parallel: boolean;
  maxAttempts: number;
  timeoutSec: number;
};

/**
 * Диспатчит воркеров по задачам. По умолчанию последовательно — два LLM-агента
 * с write-правами в одной рабочей директории конфликтуют по файлам. Падение
 * одного воркера (Promise.allSettled, не allSettled==all) не должно ронять ран целиком.
 */
export async function dispatchWorkers(tasks: Task[], workdir: string, runDir: string, opts: DispatchOptions): Promise<WorkerResult[]> {
  if (opts.parallel) {
    log.info(`запуск ${tasks.length} воркеров параллельно`);
    const settled = await Promise.allSettled(tasks.map((t) => runOneWorker(t, workdir, runDir, opts.maxAttempts, opts.timeoutSec)));
    return settled.map((s, i) => toWorkerResult(tasks[i], s));
  }

  const results: WorkerResult[] = [];
  for (const task of tasks) {
    log.info(`запуск воркера для ${task.id}`);
    const [settled] = await Promise.allSettled([runOneWorker(task, workdir, runDir, opts.maxAttempts, opts.timeoutSec)]);
    results.push(toWorkerResult(task, settled));
  }
  return results;
}

/**
 * Детерминированная валидация TDD-дисциплины по artefact-файлам evidence/*.json.
 * Невалидная дисциплина по части задач НЕ останавливает пайплайн.
 */
export function runValidationStage(tasks: Task[], runDir: string): EvidenceValidation[] {
  const paths = runDirPaths(runDir);
  const decisions = new DecisionLog(runDir);
  const validations: EvidenceValidation[] = [];

  for (const task of tasks) {
    let evidence: Evidence;
    try {
      evidence = JSON.parse(readFileSync(paths.evidenceFile(task.id), 'utf-8')) as Evidence;
    } catch {
      const v: EvidenceValidation = { taskId: task.id, valid: false, reasons: ['evidence-файл отсутствует или повреждён'] };
      validations.push(v);
      decisions.record('tdd.validate', 'invalid', 'deterministic', { taskId: task.id, reasons: v.reasons });
      continue;
    }

    const v = validateEvidence(evidence);
    validations.push(v);
    decisions.record('tdd.validate', v.valid ? 'valid' : 'invalid', 'deterministic', { taskId: task.id, reasons: v.reasons });
  }

  return validations;
}

function runOneLens(name: LensName, workdir: string, runDir: string, tasks: Task[]): Promise<LensRunnerResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(LENS_ENTRY, [`--lens=${name}`], { stdio: 'inherit' });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    child.once('message', (result: LensRunnerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve({ lens: name, ok: false, findingsCount: 0, usage: ZERO_USAGE, error: `процесс линзы завершился без результата (code ${code})` });
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ lens: name, ok: false, findingsCount: 0, usage: ZERO_USAGE, error: err.message });
    });

    const input: LensRunnerInput = { lens: name, workdir, runDir, tasks };
    child.send(input);
  });
}

/**
 * Три линзы всегда запускаются параллельно и всегда ПОСЛЕ завершения всех
 * воркеров — они read-only, гонок нет, а diff.patch уже заморожен.
 */
export async function dispatchLenses(tasks: Task[], workdir: string, runDir: string): Promise<LensRunnerResult[]> {
  log.info(`запуск ${LENS_NAMES.length} линз параллельно: ${LENS_NAMES.join(', ')}`);
  const settled = await Promise.allSettled(LENS_NAMES.map((name) => runOneLens(name, workdir, runDir, tasks)));
  return settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { lens: LENS_NAMES[i], ok: false, findingsCount: 0, usage: ZERO_USAGE, error: s.reason instanceof Error ? s.reason.message : String(s.reason) },
  );
}
