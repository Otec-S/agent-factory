import test from 'node:test';
import assert from 'node:assert/strict';
import { canRun } from './stageGuard.js';
import type { FactoryState, Phase } from './types.js';

function state(phase: Phase): FactoryState {
  return {
    phase,
    stage: 'x',
    updatedAt: '',
    taskCount: 0,
    implMode: 'subagent-per-task',
    parallel: false,
    fixup: true,
    workdir: '/w',
    taskDescription: '',
    baseTree: 'tree',
    completedStages: [],
  };
}

test('разрешает переход на следующую стадию', () => {
  assert.deepEqual(canRun('planning', state('init')), { allow: true });
  assert.deepEqual(canRun('review', state('diff')), { allow: true });
});

test('разрешает повтор текущей стадии (resume после падения посреди стадии)', () => {
  assert.deepEqual(canRun('implementation', state('implementation')), { allow: true });
});

test('запрещает перепрыгивать стадии', () => {
  const r = canRun('review', state('planning'));
  assert.equal(r.allow, false);
});

test('запрещает возврат назад', () => {
  const r = canRun('planning', state('review'));
  assert.equal(r.allow, false);
});

test('сообщает о повреждённом состоянии', () => {
  const r = canRun('planning', state('bogus' as Phase));
  assert.equal(r.allow, false);
  assert.ok(!r.allow && /повреждено/.test(r.reason));
});

test('fix-up и повторное ревью идут строго между triage и report', () => {
  assert.deepEqual(canRun('fixup', state('triage')), { allow: true });
  assert.deepEqual(canRun('rereview', state('fixup')), { allow: true });
  assert.deepEqual(canRun('report', state('rereview')), { allow: true });
  assert.equal(canRun('report', state('triage')).allow, false);
});
