import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRunDir, runDirPaths } from './runDir.js';
import { bootstrapWorkdir } from './workdir.js';
import { StateStore } from './state.js';
import { DecisionLog } from './decisions.js';
import { canRun } from './stageGuard.js';
import { plan } from './planner.js';
import { dispatchWorkers, dispatchLenses, runValidationStage } from './orchestrator.js';
import { freezeDiff } from './diff.js';
import { triage } from './review/triage.js';
import { buildUsage, writeUsage } from './usage.js';
import { makeLogger } from './logger.js';
import type { EvidenceValidation, Task, WorkerResult, Phase } from './types.js';
import type { LensRunnerResult } from './review/lensRunner.js';

const log = makeLogger('cli');

type TokenUsage = { inputTokens: number; outputTokens: number };
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

type Args =
  | { mode: 'new'; taskDescription: string; workdir: string; parallel: boolean; maxAttempts: number; workerTimeoutSec: number }
  | { mode: 'resume'; runDir: string; parallel?: boolean; maxAttempts: number; workerTimeoutSec: number };

function getFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function parseArgs(argv: string[]): Args {
  const maxAttempts = Number(getFlag(argv, 'max-attempts') ?? '4');
  const workerTimeoutSec = Number(getFlag(argv, 'worker-timeout') ?? '300');
  const parallel = argv.includes('--parallel');

  const resume = getFlag(argv, 'resume');
  if (resume) {
    return { mode: 'resume', runDir: path.resolve(process.cwd(), resume), parallel: argv.includes('--parallel') ? true : undefined, maxAttempts, workerTimeoutSec };
  }

  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    throw new Error('нужен аргумент: путь к файлу с описанием задачи ИЛИ само описание строкой (либо --resume=<run_dir>)');
  }
  const taskArg = positional[0];
  const taskDescription = existsSync(taskArg) ? readFileSync(taskArg, 'utf-8').trim() : taskArg;

  const workdir = getFlag(argv, 'workdir');
  if (!workdir) throw new Error('обязателен флаг --workdir=<path>');

  return { mode: 'new', taskDescription, workdir: path.resolve(process.cwd(), workdir), parallel, maxAttempts, workerTimeoutSec };
}

function renderReportMd(opts: {
  taskDescription: string;
  workerResults: WorkerResult[];
  validations: EvidenceValidation[];
  runDir: string;
}): string {
  const paths = runDirPaths(opts.runDir);
  const lines = [`# Отчёт фабрики`, '', `## Задача`, '', opts.taskDescription, '', `## Задачи и TDD-дисциплина`, ''];

  for (const wr of opts.workerResults) {
    const v = opts.validations.find((x) => x.taskId === wr.taskId);
    const disciplineLine = v ? (v.valid ? 'дисциплина: valid' : `дисциплина: INVALID (${v.reasons.join('; ')})`) : 'дисциплина: не проверена';
    lines.push(`- **${wr.taskId}** — воркер: ${wr.status}; ${disciplineLine}`);
    lines.push(`  ${wr.summary}`);
  }

  lines.push('', `## Артефакты`, '');
  lines.push(`- План: \`${paths.planMd}\``);
  lines.push(`- Diff: \`${paths.diffPatch}\``);
  lines.push(`- Ревью (brief): \`${paths.reviewBrief}\``);
  lines.push(`- Usage: \`${paths.usageJson}\``);
  lines.push(`- Decisions log: \`${paths.decisionsFile}\``);

  return lines.join('\n');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Выполняет стадию только если она ещё не была завершена (важно для --resume). */
async function runStage<T>(state: StateStore, phase: Phase, startStage: string, doneStage: string, work: () => Promise<T> | T, loadPersisted: () => T): Promise<T> {
  if (state.isStageDone(phase)) {
    log.info(`стадия ${phase} уже завершена (resume) — читаю сохранённый результат`);
    return loadPersisted();
  }
  const guard = canRun(phase, state.get());
  if (!guard.allow) throw new Error(guard.reason);
  state.transition(phase, startStage);
  log.info(`стадия: ${phase}`);
  const result = await work();
  state.transition(phase, doneStage);
  state.markStageDone(phase);
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let runDir: string;
  let state: StateStore;
  let decisions: DecisionLog;

  if (args.mode === 'resume') {
    runDir = args.runDir;
    state = StateStore.load(runDir);
    decisions = new DecisionLog(runDir);
    log.info(`resume: ${runDir}, текущая фаза: ${state.get().phase}`);
  } else {
    runDir = createRunDir(args.taskDescription);
    state = StateStore.init(runDir, { parallel: args.parallel, workdir: args.workdir, taskDescription: args.taskDescription });
    decisions = new DecisionLog(runDir);
    log.info(`новый run_dir: ${runDir}`);
    bootstrapWorkdir(args.workdir);
    decisions.record('cli.bootstrap', 'ok', 'deterministic', { workdir: args.workdir });
    state.markStageDone('init');
  }

  const paths = runDirPaths(runDir);
  const { workdir, taskDescription } = state.get();
  const requestedParallel = args.mode === 'resume' ? (args.parallel ?? state.get().parallel) : args.parallel;

  const tasks = await runStage(
    state,
    'planning',
    'planner.run',
    'planner.done',
    async () => {
      const result = await plan(taskDescription, runDir);
      state.transition('planning', 'planner.done', { taskCount: result.tasks.length });
      return result.tasks;
    },
    () => readJson<Task[]>(paths.tasksJson, []),
  );

  // Пересечение testFile/targetFiles между задачами (детерминированная проверка planner.ts)
  // принудительно переводит ран в последовательный режим, даже если запрошен --parallel.
  const planMeta = readJson<{ overlapWarning: boolean }>(paths.plannerUsageJson, { overlapWarning: false });
  let parallel = requestedParallel;
  if (planMeta.overlapWarning && parallel) {
    log.warn('обнаружено пересечение testFile/targetFiles между задачами — принудительно перехожу в последовательный режим');
    parallel = false;
  }
  const dispatchOpts = { parallel, maxAttempts: args.maxAttempts, timeoutSec: args.workerTimeoutSec };

  const workerResults = await runStage(
    state,
    'implementation',
    'workers.dispatch',
    'workers.done',
    async () => {
      const results = await dispatchWorkers(tasks, workdir, runDir, dispatchOpts);
      writeFileSync(paths.workerResultsJson, JSON.stringify(results, null, 2), 'utf-8');
      return results;
    },
    () => readJson<WorkerResult[]>(paths.workerResultsJson, []),
  );

  const validations = await runStage(
    state,
    'validation',
    'evidence.validate',
    'evidence.done',
    () => {
      const result = runValidationStage(tasks, runDir);
      writeFileSync(paths.evidenceValidationsJson, JSON.stringify(result, null, 2), 'utf-8');
      return result;
    },
    () => readJson<EvidenceValidation[]>(paths.evidenceValidationsJson, []),
  );

  await runStage(
    state,
    'diff',
    'diff.freeze',
    'diff.done',
    () => freezeDiff(workdir, runDir, workerResults),
    () => undefined,
  );

  const lensResults = await runStage(
    state,
    'review',
    'lenses.dispatch',
    'lenses.done',
    async () => {
      const results = await dispatchLenses(tasks, workdir, runDir);
      writeFileSync(paths.lensResultsJson, JSON.stringify(results, null, 2), 'utf-8');
      return results;
    },
    () => readJson<LensRunnerResult[]>(paths.lensResultsJson, []),
  );

  const triageUsage = await runStage(
    state,
    'triage',
    'triage.run',
    'triage.done',
    async () => {
      const result = await triage(workdir, runDir);
      writeFileSync(paths.triageUsageJson, JSON.stringify(result.usage, null, 2), 'utf-8');
      return result.usage;
    },
    () => readJson<TokenUsage>(paths.triageUsageJson, ZERO_USAGE),
  );

  await runStage(
    state,
    'report',
    'report.write',
    'report.done',
    () => {
      const plannerMeta = readJson<{ usage: TokenUsage }>(paths.plannerUsageJson, { usage: ZERO_USAGE });
      const usage = buildUsage(plannerMeta.usage, workerResults, lensResults, triageUsage);
      writeUsage(runDir, usage);
      const reportMd = renderReportMd({ taskDescription, workerResults, validations, runDir });
      writeFileSync(paths.reportMd, reportMd, 'utf-8');
      console.log('\n' + reportMd + '\n');
      log.info(`review brief: ${paths.reviewBrief}`);
      log.info(`usage: ${paths.usageJson}`);
    },
    () => undefined,
  );

  state.transition('done', 'complete');
  state.markStageDone('done');
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
