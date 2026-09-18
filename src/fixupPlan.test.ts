import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planFixups } from './fixupPlan.js';
import type { ReviewFinding, Task } from './types.js';

const WORKDIR = path.resolve('/w');

function task(id: string, targetFiles: string[], testFile = `${id}.test.js`): Task {
  return { id, title: id, description: '', testFirst: '', testFile, targetFiles, acceptanceCriteria: [] };
}

function finding(severity: ReviewFinding['severity'], file?: string): ReviewFinding {
  return { title: `${severity} ${file ?? '-'}`, file, rationale: 'r', severity, sources: ['blind'] };
}

test('в fix-up попадают только critical и major', () => {
  const plan = planFixups([finding('critical', 'a.js'), finding('major', 'a.js'), finding('minor', 'a.js'), finding('nit', 'a.js')], [task('t1', ['a.js'])], WORKDIR);
  assert.equal(plan.assignments.length, 1);
  assert.deepEqual(
    plan.assignments[0].findings.map((f) => f.severity),
    ['critical', 'major'],
  );
  assert.deepEqual(plan.unassigned, []);
});

test('находка привязывается к задаче по targetFiles с учётом разных написаний пути', () => {
  const tasks = [task('t1', ['src/a.js']), task('t2', ['src/b.js'])];
  const plan = planFixups(
    [finding('major', 'b/src/b.js'), finding('major', './src/a.js'), finding('major', path.join(WORKDIR, 'src', 'b.js')), finding('major', 'src\\a.js')],
    tasks,
    WORKDIR,
  );
  assert.deepEqual(
    plan.assignments.map((a) => [a.taskId, a.findings.length]),
    [
      ['t1', 2],
      ['t2', 2],
    ],
  );
});

test('находка по файлу, общему для нескольких задач, уходит в каждую', () => {
  const plan = planFixups([finding('critical', 'shared.js')], [task('t1', ['shared.js']), task('t2', ['shared.js'])], WORKDIR);
  assert.deepEqual(
    plan.assignments.map((a) => a.taskId),
    ['t1', 't2'],
  );
});

test('тестовые файлы, находки без файла и вне задач не назначаются', () => {
  const plan = planFixups([finding('major'), finding('major', 't1.test.js'), finding('critical', 'other.js')], [task('t1', ['a.js'])], WORKDIR);
  assert.deepEqual(plan.assignments, []);
  assert.deepEqual(
    plan.unassigned.map((u) => u.reason),
    ['no-file', 'test-file', 'outside-tasks'],
  );
});
