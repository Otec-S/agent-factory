import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from './triage.js';

const finding = { title: 't', rationale: 'r', severity: 'major', sources: ['blind'] };

test('корректный вердикт разбирается целиком', () => {
  const r = parseVerdict({ summary: 's', findings: [finding] });
  assert.equal(r.valid, true);
  assert.equal(r.droppedFindings, 0);
  assert.deepEqual(r.verdict, { summary: 's', findings: [finding] });
});

test('одна битая находка (пустой sources) не обнуляет остальные', () => {
  const r = parseVerdict({ summary: 's', findings: [finding, { ...finding, sources: [] }, { ...finding, severity: 'huge' }] });
  assert.equal(r.valid, false);
  assert.equal(r.droppedFindings, 2);
  assert.deepEqual(r.verdict.findings, [finding]);
  assert.equal(r.verdict.summary, 's');
});

test('битая оболочка даёт пустой вердикт с объяснением', () => {
  const r = parseVerdict(undefined);
  assert.equal(r.valid, false);
  assert.deepEqual(r.verdict.findings, []);
  assert.match(r.verdict.summary, /невалидный вывод/);
});
