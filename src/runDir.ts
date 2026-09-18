import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Короткий читаемый суффикс имени run_dir. Буквы любых алфавитов сохраняются (иначе кириллическое описание всегда давало бы "task"). */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '') // комбинируемые диакритики после NFKD
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

/** Вычисляется один раз в cli.ts и передаётся всем стадиям явно. */
export function createRunDir(taskDescription: string, baseDir = 'docs/agent-factory/runs'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugify(taskDescription);
  const runDir = path.resolve(process.cwd(), baseDir, `${timestamp}-${slug}`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  mkdirSync(path.join(runDir, 'workers'), { recursive: true });
  mkdirSync(path.join(runDir, 'review'), { recursive: true });
  mkdirSync(path.join(runDir, 'fixup'), { recursive: true });
  return runDir;
}

/**
 * Артефакты одного раунда ревью. Раунд 1 лежит там же, где и в v1 (review/, diff.patch в корне),
 * повторное ревью после fix-up — в review/round-<n>/, чтобы не затирать вердикт, по которому чинили.
 */
export function reviewPaths(runDir: string, round = 1) {
  const dir = round === 1 ? runDir : path.join(runDir, 'review', `round-${round}`);
  const reviewDir = round === 1 ? path.join(runDir, 'review') : dir;
  return {
    dir,
    diffPatch: path.join(dir, 'diff.patch'),
    changedFilesJson: path.join(dir, 'changed-files.json'),
    lensResultsJson: path.join(dir, 'lens-results.json'),
    triageUsageJson: path.join(dir, 'triage-usage.json'),
    lensFile: (name: string) => path.join(reviewDir, `lens-${name}.json`),
    reviewFinal: path.join(reviewDir, 'final.json'),
    reviewBrief: path.join(reviewDir, 'brief.md'),
  };
}

export function runDirPaths(runDir: string) {
  const { dir: _dir, ...round1 } = reviewPaths(runDir, 1);
  return {
    ...round1,
    stateFile: path.join(runDir, 'state.local.json'),
    decisionsFile: path.join(runDir, 'decisions.jsonl'),
    planMd: path.join(runDir, 'plan.md'),
    tasksJson: path.join(runDir, 'tasks.json'),
    plannerUsageJson: path.join(runDir, 'planner-usage.json'),
    workerResultsJson: path.join(runDir, 'worker-results.json'),
    evidenceValidationsJson: path.join(runDir, 'evidence-validations.json'),
    evidenceFile: (taskId: string) => path.join(runDir, 'evidence', `${taskId}.json`),
    // Результат каждого воркера пишется сразу по завершении — resume пропускает уже выполненные задачи.
    workerResultFile: (taskId: string) => path.join(runDir, 'workers', `${taskId}.result.json`),
    fixupPlanJson: path.join(runDir, 'fixup', 'plan.json'),
    fixupResultsJson: path.join(runDir, 'fixup', 'results.json'),
    // Как и у воркеров: resume не перезапускает уже отработавший fix-up задачи.
    fixupResultFile: (taskId: string) => path.join(runDir, 'fixup', `${taskId}.result.json`),
    rereviewJson: path.join(runDir, 'review', 'rereview.json'),
    usageJson: path.join(runDir, 'usage.json'),
    reportMd: path.join(runDir, 'report.md'),
  };
}
