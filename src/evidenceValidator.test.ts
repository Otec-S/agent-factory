import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence } from './evidenceValidator.js';
import type { Evidence, TestRun } from './types.js';

function run(overrides: Partial<TestRun>): TestRun {
  return {
    cmd: 'node --test t.test.js',
    exitCode: 1,
    output: '',
    testsRan: 1,
    testsFailed: 1,
    failureKind: 'assertion',
    testFileSha256: 'abc',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const goodRed = run({});
const goodGreen = run({ exitCode: 0, testsFailed: 0, failureKind: 'passed', at: '2026-01-01T00:00:01.000Z' });

function evidence(red: TestRun, green: TestRun | null): Evidence {
  return { taskId: 't1', red, green, attempts: { red: 1, green: 1 } };
}

test('валидный цикл red -> green проходит все проверки', () => {
  assert.deepEqual(validateEvidence(evidence(goodRed, goodGreen)), { taskId: 't1', valid: true, reasons: [] });
});

test('red из-за отсутствия модуля реализации — валидный red', () => {
  assert.equal(validateEvidence(evidence(run({ failureKind: 'missing-target' }), goodGreen)).valid, true);
});

test('red из-за сломанного тестового файла отклоняется, хотя счётчики TAP выглядят как падение', () => {
  const v = validateEvidence(evidence(run({ failureKind: 'load-error' }), goodGreen));
  assert.equal(v.valid, false);
  assert.match(v.reasons.join('\n'), /failureKind === "load-error"/);
});

test('red, который на самом деле прошёл, отклоняется', () => {
  const v = validateEvidence(evidence(run({ exitCode: 0, testsFailed: 0, failureKind: 'passed' }), goodGreen));
  assert.equal(v.valid, false);
  assert.equal(v.reasons.length, 3);
});

test('отсутствие green отклоняется', () => {
  const v = validateEvidence(evidence(goodRed, null));
  assert.equal(v.valid, false);
  assert.match(v.reasons[0], /green отсутствует/);
});

test('изменённый между red и green тестовый файл отклоняется', () => {
  const v = validateEvidence(evidence(goodRed, { ...goodGreen, testFileSha256: 'other' }));
  assert.equal(v.valid, false);
  assert.match(v.reasons.join('\n'), /testFileSha256/);
});

test('green не позже red отклоняется', () => {
  const v = validateEvidence(evidence(goodRed, { ...goodGreen, at: goodRed.at }));
  assert.match(v.reasons.join('\n'), /порядок red -> green/);
});

test('green без выполненных тестов отклоняется', () => {
  const v = validateEvidence(evidence(goodRed, { ...goodGreen, testsRan: 0 }));
  assert.match(v.reasons.join('\n'), /ни одного настоящего теста/);
});

test('green, где node --test насчитал только псевдотест пустого файла, отклоняется', () => {
  const v = validateEvidence(evidence(goodRed, { ...goodGreen, failureKind: 'no-tests' }));
  assert.equal(v.valid, false);
});
