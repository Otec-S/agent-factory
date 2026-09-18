import test from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps, PlanSchema } from './planner.js';
import type { Task } from './types.js';

function task(id: string, testFile: string, targetFiles: string[]): Task {
  return { id, title: id, description: 'd', testFirst: 'f', testFile, targetFiles, acceptanceCriteria: ['c'] };
}

test('findOverlaps: непересекающиеся задачи', () => {
  assert.deepEqual(findOverlaps([task('a', 'a.test.js', ['a.js']), task('b', 'b.test.js', ['b.js'])]), []);
});

test('findOverlaps: общий targetFile и общий testFile', () => {
  const warnings = findOverlaps([task('a', 't.test.js', ['shared.js']), task('b', 't.test.js', ['shared.js'])]);
  assert.equal(warnings.length, 2);
});

test('findOverlaps: разные записи одного пути считаются пересечением', () => {
  const warnings = findOverlaps([task('a', 'a.test.js', ['./lib/x.js']), task('b', 'b.test.js', ['lib/../lib/x.js'])]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lib\/\.\.\/lib\/x\.js/);
});

test('PlanSchema принимает корректный план', () => {
  assert.equal(PlanSchema.safeParse({ tasks: [task('task-1', 'a.test.js', ['a.js'])] }).success, true);
});

test('PlanSchema отклоняет пути за пределами workdir', () => {
  assert.equal(PlanSchema.safeParse({ tasks: [task('t', '../evil.test.js', ['a.js'])] }).success, false);
  assert.equal(PlanSchema.safeParse({ tasks: [task('t', 'a.test.js', ['/etc/passwd'])] }).success, false);
});

test('PlanSchema отклоняет дубликаты id', () => {
  const r = PlanSchema.safeParse({ tasks: [task('t', 'a.test.js', ['a.js']), task('t', 'b.test.js', ['b.js'])] });
  assert.equal(r.success, false);
  assert.match(r.error!.message, /уникальными/);
});

test('PlanSchema отклоняет небезопасный для имени файла id', () => {
  assert.equal(PlanSchema.safeParse({ tasks: [task('../x', 'a.test.js', ['a.js'])] }).success, false);
});
