import { writeFileSync } from 'node:fs';
import type { WorkerResult, Usage, TokenUsage } from './types.js';
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

export function buildUsage(plannerUsage: TokenUsage, workerResults: WorkerResult[], lensResults: LensRunnerResult[], triageUsage: TokenUsage): Usage {
  const workers: Usage['workers'] = {};
  for (const r of workerResults) workers[r.taskId] = normalizeUsage(r.usage);

  const lenses: Usage['lenses'] = {};
  for (const r of lensResults) lenses[r.lens] = normalizeUsage(r.usage);

  return { planner: normalizeUsage(plannerUsage), workers, lenses, triage: normalizeUsage(triageUsage) };
}

export function writeUsage(runDir: string, usage: Usage): void {
  writeFileSync(runDirPaths(runDir).usageJson, JSON.stringify(usage, null, 2), 'utf-8');
}
