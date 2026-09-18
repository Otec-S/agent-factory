import { mkdirSync } from 'node:fs';
import path from 'node:path';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
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
  return runDir;
}

export function runDirPaths(runDir: string) {
  return {
    root: runDir,
    stateFile: path.join(runDir, 'state.local.json'),
    decisionsFile: path.join(runDir, 'decisions.jsonl'),
    planMd: path.join(runDir, 'plan.md'),
    tasksJson: path.join(runDir, 'tasks.json'),
    plannerUsageJson: path.join(runDir, 'planner-usage.json'),
    workerResultsJson: path.join(runDir, 'worker-results.json'),
    lensResultsJson: path.join(runDir, 'lens-results.json'),
    triageUsageJson: path.join(runDir, 'triage-usage.json'),
    evidenceValidationsJson: path.join(runDir, 'evidence-validations.json'),
    evidenceDir: path.join(runDir, 'evidence'),
    evidenceFile: (taskId: string) => path.join(runDir, 'evidence', `${taskId}.json`),
    workersDir: path.join(runDir, 'workers'),
    workerLog: (taskId: string) => path.join(runDir, 'workers', `${taskId}.log`),
    diffPatch: path.join(runDir, 'diff.patch'),
    changedFilesJson: path.join(runDir, 'changed-files.json'),
    reviewDir: path.join(runDir, 'review'),
    lensFile: (name: string) => path.join(runDir, 'review', `lens-${name}.json`),
    reviewFinal: path.join(runDir, 'review', 'final.json'),
    reviewBrief: path.join(runDir, 'review', 'brief.md'),
    usageJson: path.join(runDir, 'usage.json'),
    reportMd: path.join(runDir, 'report.md'),
  };
}
