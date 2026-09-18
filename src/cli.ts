import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRunDir, reviewPaths, runDirPaths } from './runDir.js';
import { bootstrapWorkdir } from './workdir.js';
import { StateStore } from './state.js';
import { DecisionLog } from './decisions.js';
import { canRun } from './stageGuard.js';
import { plan } from './planner.js';
import { dispatchWorkers, dispatchLenses, dispatchFixups, runValidationStage } from './orchestrator.js';
import { freezeDiff } from './diff.js';
import { triage } from './review/triage.js';
import { buildUsage, writeUsage } from './usage.js';
import { isBlocking, planFixups } from './fixupPlan.js';
import { makeLogger } from './logger.js';
import { parseArgs } from './args.js';
import { loadDotEnv } from './env.js';
import type { EvidenceValidation, FixupPlan, FixupResult, Task, WorkerResult, Phase, RereviewSummary, ReviewVerdict, TokenUsage } from './types.js';
import type { LensRunnerResult } from './review/lensRunner.js';

const log = makeLogger('cli');

function renderReportMd(opts: {
  taskDescription: string;
  workerResults: WorkerResult[];
  validations: EvidenceValidation[];
  lensResults: LensRunnerResult[];
  fixup: { enabled: boolean; plan: FixupPlan; results: FixupResult[]; rereview: RereviewSummary; rereviewLensResults: LensRunnerResult[] };
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

  const failedLenses = opts.lensResults.filter((r) => !r.ok);
  if (failedLenses.length > 0) {
    lines.push('', `## Ревью неполное`, '');
    for (const r of failedLenses) lines.push(`- линза **${r.lens}** не отработала: ${r.error ?? 'причина неизвестна'}`);
  }

  lines.push('', `## Fix-up раунд`, '');
  const { fixup } = opts;
  if (!fixup.enabled) {
    lines.push('Выключен флагом `--no-fixup`.');
  } else {
    for (const r of fixup.results) lines.push(`- **${r.taskId}** — ${r.status}: ${r.summary}`);
    for (const u of fixup.plan.unassigned) lines.push(`- не назначено (${u.reason}): [${u.finding.severity}] ${u.finding.title}${u.finding.file ? ` (${u.finding.file})` : ''}`);
    if (fixup.results.length === 0 && fixup.plan.unassigned.length === 0) lines.push('Блокирующих находок нет — чинить нечего.');
    const { rereview } = fixup;
    lines.push(
      '',
      rereview.ran
        ? `Повторное ревью: блокирующих находок было ${rereview.blockingBefore}, осталось ${rereview.blockingAfter}.`
        : `Повторное ревью не запускалось: ${rereview.reason}.`,
    );
    const failedRereview = fixup.rereviewLensResults.filter((r) => !r.ok);
    for (const r of failedRereview) lines.push(`- ⚠ линза **${r.lens}** повторного ревью не отработала: ${r.error ?? 'причина неизвестна'}`);
  }

  lines.push('', `## Артефакты`, '');
  lines.push(`- План: \`${paths.planMd}\``);
  lines.push(`- Diff: \`${paths.diffPatch}\``);
  lines.push(`- Ревью (brief): \`${paths.reviewBrief}\``);
  if (opts.fixup.rereview.ran) lines.push(`- Повторное ревью (brief): \`${reviewPaths(opts.runDir, 2).reviewBrief}\``);
  lines.push(`- Usage: \`${paths.usageJson}\``);
  lines.push(`- Decisions log: \`${paths.decisionsFile}\``);

  return lines.join('\n');
}

/**
 * Читает сохранённый артефакт стадии. Отсутствующий или битый файл — ошибка:
 * тихая подмена пустым значением превратила бы resume в "0 задач, всё зелёное".
 */
function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    throw new Error(`не удалось прочитать артефакт ${file}: ${err instanceof Error ? err.message : String(err)}`);
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
  const loadedEnv = loadDotEnv(path.resolve(process.cwd(), '.env'));
  if (loadedEnv.length > 0) log.info(`.env: загружены ${loadedEnv.join(', ')}`);
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
    log.info(`новый run_dir: ${runDir}`);
    // bootstrap до init состояния: baseTree — часть состояния рана, от него считается diff.
    const { baseTree } = bootstrapWorkdir(args.workdir);
    state = StateStore.init(runDir, { parallel: args.parallel, fixup: args.fixup, workdir: args.workdir, taskDescription: args.taskDescription, baseTree });
    decisions = new DecisionLog(runDir);
    decisions.record('cli.bootstrap', 'ok', 'deterministic', { workdir: args.workdir, baseTree });
    state.markStageDone('init');
  }

  const paths = runDirPaths(runDir);
  const { workdir, taskDescription, baseTree } = state.get();
  const requestedParallel = args.mode === 'resume' ? (args.parallel ?? state.get().parallel) : args.parallel;
  const fixupEnabled = args.mode === 'resume' ? (args.fixup ?? state.get().fixup) : args.fixup;

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
    () => readJson<Task[]>(paths.tasksJson),
  );

  // Пересечение testFile/targetFiles между задачами (детерминированная проверка planner.ts)
  // принудительно переводит ран в последовательный режим, даже если запрошен --parallel.
  const planMeta = readJson<{ overlapWarning: boolean }>(paths.plannerUsageJson);
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
    () => readJson<WorkerResult[]>(paths.workerResultsJson),
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
    () => readJson<EvidenceValidation[]>(paths.evidenceValidationsJson),
  );

  await runStage(
    state,
    'diff',
    'diff.freeze',
    'diff.done',
    () => freezeDiff(workdir, runDir, baseTree, workerResults),
    () => undefined,
  );

  const lensResults = await runStage(
    state,
    'review',
    'lenses.dispatch',
    'lenses.done',
    async () => {
      const results = await dispatchLenses(tasks, workdir, runDir, args.lensTimeoutSec);
      writeFileSync(paths.lensResultsJson, JSON.stringify(results, null, 2), 'utf-8');
      return results;
    },
    () => readJson<LensRunnerResult[]>(paths.lensResultsJson),
  );

  const triageUsage = await runStage(
    state,
    'triage',
    'triage.run',
    'triage.done',
    async () => {
      const failedLenses = lensResults.filter((r) => !r.ok).map((r) => r.lens);
      const result = await triage(workdir, runDir, failedLenses);
      writeFileSync(paths.triageUsageJson, JSON.stringify(result.usage, null, 2), 'utf-8');
      return result.usage;
    },
    () => readJson<TokenUsage>(paths.triageUsageJson),
  );

  const fixupStage = await runStage(
    state,
    'fixup',
    'fixup.run',
    'fixup.done',
    async () => {
      let fixupPlan: FixupPlan = { assignments: [], unassigned: [] };
      if (fixupEnabled) {
        const verdict = readJson<ReviewVerdict>(paths.reviewFinal);
        fixupPlan = planFixups(verdict.findings, tasks, workdir);
      }
      decisions.record('fixup.plan', !fixupEnabled ? 'disabled' : fixupPlan.assignments.length > 0 ? 'fix' : 'nothing-to-fix', 'deterministic', {
        tasks: fixupPlan.assignments.map((a) => ({ taskId: a.taskId, findings: a.findings.length })),
        unassigned: fixupPlan.unassigned.map((u) => ({ title: u.finding.title, reason: u.reason })),
      });
      // run_dir, созданный до появления fix-up, не содержит fixup/.
      mkdirSync(path.dirname(paths.fixupPlanJson), { recursive: true });
      writeFileSync(paths.fixupPlanJson, JSON.stringify(fixupPlan, null, 2), 'utf-8');
      const results = await dispatchFixups(fixupPlan, tasks, workdir, runDir, dispatchOpts);
      writeFileSync(paths.fixupResultsJson, JSON.stringify(results, null, 2), 'utf-8');
      return { plan: fixupPlan, results };
    },
    () => ({ plan: readJson<FixupPlan>(paths.fixupPlanJson), results: readJson<FixupResult[]>(paths.fixupResultsJson) }),
  );

  const round2 = reviewPaths(runDir, 2);
  const rereview = await runStage(
    state,
    'rereview',
    'rereview.run',
    'rereview.done',
    async () => {
      const blockingBefore = readJson<ReviewVerdict>(paths.reviewFinal).findings.filter(isBlocking).length;
      const applied = fixupStage.results.filter((r) => r.status === 'applied').length;
      let summary: RereviewSummary;
      if (applied === 0) {
        // Код не менялся — повторное ревью дало бы тот же вердикт за те же токены.
        summary = { ran: false, reason: fixupEnabled ? 'ни одна правка fix-up не применена' : 'fix-up выключен', blockingBefore, blockingAfter: null };
      } else {
        freezeDiff(workdir, runDir, baseTree, workerResults, 2);
        const lensResults2 = await dispatchLenses(tasks, workdir, runDir, args.lensTimeoutSec, 2);
        writeFileSync(round2.lensResultsJson, JSON.stringify(lensResults2, null, 2), 'utf-8');
        const failed2 = lensResults2.filter((r) => !r.ok).map((r) => r.lens);
        const result = await triage(workdir, runDir, failed2, 2);
        writeFileSync(round2.triageUsageJson, JSON.stringify(result.usage, null, 2), 'utf-8');
        summary = { ran: true, reason: `применено правок: ${applied}`, blockingBefore, blockingAfter: result.verdict.findings.filter(isBlocking).length };
      }
      decisions.record('review.rereview', summary.ran ? 'ran' : 'skipped', 'deterministic', { ...summary });
      writeFileSync(paths.rereviewJson, JSON.stringify(summary, null, 2), 'utf-8');
      return summary;
    },
    () => readJson<RereviewSummary>(paths.rereviewJson),
  );
  const rereviewLensResults = rereview.ran ? readJson<LensRunnerResult[]>(round2.lensResultsJson) : [];

  await runStage(
    state,
    'report',
    'report.write',
    'report.done',
    () => {
      const plannerMeta = readJson<{ usage: TokenUsage }>(paths.plannerUsageJson);
      const usage = buildUsage(plannerMeta.usage, workerResults, lensResults, triageUsage, {
        fixupResults: fixupStage.results,
        rereview: rereview.ran ? { lensResults: rereviewLensResults, triageUsage: readJson<TokenUsage>(round2.triageUsageJson) } : null,
      });
      writeUsage(runDir, usage);
      const reportMd = renderReportMd({
        taskDescription,
        workerResults,
        validations,
        lensResults,
        fixup: { enabled: fixupEnabled, plan: fixupStage.plan, results: fixupStage.results, rereview, rereviewLensResults },
        runDir,
      });
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
