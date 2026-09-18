import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, buildUsage, normalizeUsage, ZERO_USAGE } from './usage.js';
import type { WorkerResult } from './types.js';

test('addUsage суммирует в том числе cache-токены', () => {
  const u = addUsage(ZERO_USAGE, { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 });
  assert.deepEqual(addUsage(u, u), { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 8 });
});

test('normalizeUsage дополняет usage из старых артефактов без cache-полей', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 5, outputTokens: 1 }), { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  assert.deepEqual(normalizeUsage(undefined), ZERO_USAGE);
});

test('buildUsage раскладывает usage по воркерам и линзам', () => {
  const worker = { taskId: 'a', usage: { ...ZERO_USAGE, inputTokens: 7 } } as WorkerResult;
  const usage = buildUsage(ZERO_USAGE, [worker], [{ lens: 'blind', ok: true, findingsCount: 0, usage: ZERO_USAGE }], ZERO_USAGE);
  assert.equal(usage.workers.a.inputTokens, 7);
  assert.deepEqual(usage.lenses.blind, ZERO_USAGE);
});
