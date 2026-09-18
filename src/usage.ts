import { writeFileSync } from 'node:fs';
import type { FixupResult, WorkerResult, Usage, TokenUsage } from './types.js';
import type { LensRunnerResult } from './review/lensRunner.js';
import { runDirPaths } from './runDir.js';

export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

export function addUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadInputTokens: a.cacheReadInputTokens + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: a.cacheCreationInputTokens + (b.cacheCreationInputTokens ?? 0),
  };
}

/**
 * Приводит usage из старых артефактов (до появления cache-полей) к полному виду,
 * чтобы --resume старого рана не давал NaN в usage.json.
 */
export function normalizeUsage(u: Partial<TokenUsage> | undefined): TokenUsage {
  return addUsage(ZERO_USAGE, u ?? {});
}

function byLens(lensResults: LensRunnerResult[]): Record<string, TokenUsage> {
  const lenses: Record<string, TokenUsage> = {};
  for (const r of lensResults) lenses[r.lens] = normalizeUsage(r.usage);
  return lenses;
}

export type FixupUsageInput = {
  fixupResults: FixupResult[];
  rereview: { lensResults: LensRunnerResult[]; triageUsage: TokenUsage } | null;
};

export function buildUsage(
  plannerUsage: TokenUsage,
  workerResults: WorkerResult[],
  lensResults: LensRunnerResult[],
  triageUsage: TokenUsage,
  fixup: FixupUsageInput = { fixupResults: [], rereview: null },
): Usage {
  const workers: Usage['workers'] = {};
  for (const r of workerResults) workers[r.taskId] = normalizeUsage(r.usage);

  const fixupByTask: Usage['fixup'] = {};
  for (const r of fixup.fixupResults) fixupByTask[r.taskId] = normalizeUsage(r.usage);

  return {
    planner: normalizeUsage(plannerUsage),
    workers,
    lenses: byLens(lensResults),
    triage: normalizeUsage(triageUsage),
    fixup: fixupByTask,
    rereview: fixup.rereview && { lenses: byLens(fixup.rereview.lensResults), triage: normalizeUsage(fixup.rereview.triageUsage) },
  };
}

export function writeUsage(runDir: string, usage: Usage): void {
  writeFileSync(runDirPaths(runDir).usageJson, JSON.stringify(usage, null, 2), 'utf-8');
}
