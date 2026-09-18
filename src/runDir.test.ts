import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './runDir.js';

test('slugify: латиница и диакритики', () => {
  assert.equal(slugify('Add Café module!'), 'add-cafe-module');
});

test('slugify: кириллица сохраняется, а не превращается в "task"', () => {
  assert.equal(slugify('Добавь модуль math.ts'), 'добавь-модуль-math-ts');
});

test('slugify: пустой результат заменяется на "task"', () => {
  assert.equal(slugify('!!!'), 'task');
});

test('slugify: обрезка до 40 символов без висячего дефиса', () => {
  const s = slugify(`${'a'.repeat(39)} bbb`);
  assert.equal(s, 'a'.repeat(39));
});
