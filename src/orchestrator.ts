import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, EvidenceValidation, LensName, Task, WorkerResult } from './types.js';
import { validateEvidence } from './evidenceValidator.js';
import { runDirPaths } from './runDir.js';
import { DecisionLog } from './decisions.js';
import { makeLogger } from './logger.js';
import { runChild } from './childProcess.js';
import { ZERO_USAGE } from './usage.js';
import type { WorkerInput } from './worker.js';
import type { LensRunnerInput, LensRunnerResult } from './review/lensRunner.js';
import { LENS_NAMES } from './review/lenses.js';

const log = makeLogger('orchestrator');

const WORKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const LENS_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review', 'lensRunner.js');

function workerFailure(task: Task, status: 'error' | 'timeout', summary: string, error?: string): WorkerResult {
  return { taskId: task.id, status, changedFiles: [], summary, usage: ZERO_USAGE, error };
}

/**
 * Форкает ОДИН отдельный процесс-воркер на одну задачу и ждёт его результат
 * через IPC. Никогда не бросает исключение наружу — любой сбой нормализуется
 * в WorkerResult со статусом 'error'/'timeout'.
 */
function runOneWorker(task: Task, workdir: string, runDir: string, maxAttempts: number, timeoutSec: number): Promise<WorkerResult> {
  return runChild<WorkerInput, WorkerResult>({
    entry: WORKER_ENTRY,
    input: { task, workdir, runDir, maxAttempts },
    timeoutSec,
    onTimeout: () => workerFailure(task, 'timeout', `задача ${task.id}: таймаут воркера (${timeoutSec}s)`),
    onFailure: (message) => workerFailure(task, 'error', `задача ${task.id}: процесс воркера упал`, message),
  });
}

/**
 * Результат пишется на диск сразу после завершения воркера: если ран упадёт
 * посреди стадии, --resume не станет заново гонять уже выполненные задачи
 * (их файлы уже существуют, и повторный red был бы не красным).
 */
async function runOrReuseWorker(task: Task, workdir: string, runDir: string, opts: DispatchOptions): Promise<WorkerResult> {
  const resultFile = runDirPaths(runDir).workerResultFile(task.id);
  if (existsSync(resultFile)) {
    log.info(`задача ${task.id} уже выполнена в этом ране — беру сохранённый результат`);
    return JSON.parse(readFileSync(resultFile, 'utf-8')) as WorkerResult;
  }
  log.info(`запуск воркера для ${task.id}`);
  const result = await runOneWorker(task, workdir, runDir, opts.maxAttempts, opts.timeoutSec);
  writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
  return result;
}

export type DispatchOptions = {
  parallel: boolean;
  maxAttempts: number;
  timeoutSec: number;
};

/**
 * Диспатчит воркеров по задачам. По умолчанию последовательно — два LLM-агента
 * с write-правами в одной рабочей директории конфликтуют по файлам. Падение
 * одного воркера не роняет ран: runChild никогда не отклоняет промис.
 */
export async function dispatchWorkers(tasks: Task[], workdir: string, runDir: string, opts: DispatchOptions): Promise<WorkerResult[]> {
  if (opts.parallel) {
    log.info(`запуск ${tasks.length} воркеров параллельно`);
    return Promise.all(tasks.map((t) => runOrReuseWorker(t, workdir, runDir, opts)));
  }

  const results: WorkerResult[] = [];
  for (const task of tasks) {
    results.push(await runOrReuseWorker(task, workdir, runDir, opts));
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

function runOneLens(name: LensName, workdir: string, runDir: string, tasks: Task[], timeoutSec: number): Promise<LensRunnerResult> {
  const failure = (error: string): LensRunnerResult => ({ lens: name, ok: false, findingsCount: 0, usage: ZERO_USAGE, error });
  return runChild<LensRunnerInput, LensRunnerResult>({
    entry: LENS_ENTRY,
    input: { lens: name, workdir, runDir, tasks },
    timeoutSec,
    onTimeout: () => failure(`таймаут линзы (${timeoutSec}s)`),
    onFailure: (message) => failure(`процесс линзы упал: ${message}`),
  });
}

/**
 * Три линзы всегда запускаются параллельно и всегда ПОСЛЕ завершения всех
 * воркеров — они read-only, гонок нет, а diff.patch уже заморожен.
 */
export async function dispatchLenses(tasks: Task[], workdir: string, runDir: string, timeoutSec: number): Promise<LensRunnerResult[]> {
  log.info(`запуск ${LENS_NAMES.length} линз параллельно: ${LENS_NAMES.join(', ')}`);
  return Promise.all(LENS_NAMES.map((name) => runOneLens(name, workdir, runDir, tasks, timeoutSec)));
}
