import { writeFileSync } from 'node:fs';
import type { WorkerResult, Usage } from './types.js';
import type { LensRunnerResult } from './review/lensRunner.js';
import { runDirPaths } from './runDir.js';

export function buildUsage(
  plannerUsage: { inputTokens: number; outputTokens: number },
  workerResults: WorkerResult[],
  lensResults: LensRunnerResult[],
  triageUsage: { inputTokens: number; outputTokens: number },
): Usage {
  const workers: Usage['workers'] = {};
  for (const r of workerResults) workers[r.taskId] = r.usage;

  const lenses: Usage['lenses'] = {};
  for (const r of lensResults) lenses[r.lens] = r.usage;

  return { planner: plannerUsage, workers, lenses, triage: triageUsage };
}

export function writeUsage(runDir: string, usage: Usage): void {
  writeFileSync(runDirPaths(runDir).usageJson, JSON.stringify(usage, null, 2), 'utf-8');
}
