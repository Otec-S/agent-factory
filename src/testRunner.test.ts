import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTap, runTests } from './testRunner.js';

test('parseTap читает итоговую сводку', () => {
  assert.deepEqual(parseTap('ok 1\n# tests 3\n# pass 1\n# fail 2\n'), { testsRan: 3, testsFailed: 2 });
  assert.deepEqual(parseTap('garbage'), { testsRan: 0, testsFailed: 0 });
});

// Реальные прогоны node --test: классификация опирается на формат вывода Node,
// поэтому проверяется на настоящем выводе, а не на выдуманных строках.
function workdir(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'af-testrunner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const HEADER = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";

test('нет модуля из targetFiles — ожидаемый red (missing-target)', (t) => {
  const dir = workdir(t, { 'test/math.test.js': `${HEADER}import { add } from '../src/math.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n` });
  const r = runTests(dir, 'test/math.test.js', ['src/math.js']);
  assert.equal(r.failureKind, 'missing-target');
  assert.equal(r.testsRan, 1); // именно поэтому счётчиков TAP недостаточно
  assert.equal(r.testsFailed, 1);
  assert.match(r.testFileSha256, /^[0-9a-f]{64}$/);
});

test('нет экспорта в существующем модуле из targetFiles — тоже missing-target', (t) => {
  const dir = workdir(t, {
    'math.js': 'export const other = 1;\n',
    'math.test.js': `${HEADER}import { add } from './math.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n`,
  });
  assert.equal(runTests(dir, 'math.test.js', ['math.js']).failureKind, 'missing-target');
});

test('импорт модуля НЕ из targetFiles — ошибка загрузки теста', (t) => {
  const dir = workdir(t, { 'math.test.js': `${HEADER}import { helper } from './helper.js';\ntest('x', () => assert.ok(helper));\n` });
  assert.equal(runTests(dir, 'math.test.js', ['math.js']).failureKind, 'load-error');
});

test('синтаксическая ошибка в тесте — load-error', (t) => {
  const dir = workdir(t, { 'bad.test.js': `${HEADER}test('x', () => {\n` });
  const r = runTests(dir, 'bad.test.js', ['a.js']);
  assert.equal(r.failureKind, 'load-error');
  assert.equal(r.testsFailed, 1);
});

// Регрессия из живого рана: Node вставляет пояснение между строкой ошибки и стеком,
// и прежняя эвристика по стеку принимала это за валидный red.
test('require в ESM-пакете — load-error, а не assertion', (t) => {
  const dir = workdir(t, { 'math/add.test.js': "const test = require('node:test');\nconst { add } = require('../math/add.js');\ntest('x', () => {});\n" });
  assert.equal(runTests(dir, 'math/add.test.js', ['math/add.js']).failureKind, 'load-error');
});

test('исключение на верхнем уровне тестового файла — load-error', (t) => {
  const dir = workdir(t, { 'a.test.js': `${HEADER}throw new Error('boom');\n` });
  assert.equal(runTests(dir, 'a.test.js', ['a.js']).failureKind, 'load-error');
});

test('упавшая проверка — assertion', (t) => {
  const dir = workdir(t, { 'a.test.js': `${HEADER}test('x', () => assert.equal(1, 2));\n` });
  const r = runTests(dir, 'a.test.js', ['a.js']);
  assert.equal(r.failureKind, 'assertion');
  assert.notEqual(r.exitCode, 0);
});

test('брошенное в теле теста исключение — тоже падение теста, а не ошибка загрузки', (t) => {
  const dir = workdir(t, { 'a.test.js': `${HEADER}test('x', () => { throw new TypeError('boom'); });\n` });
  assert.equal(runTests(dir, 'a.test.js', ['a.js']).failureKind, 'assertion');
});

test('проходящий тест — passed', (t) => {
  const dir = workdir(t, { 'a.test.js': `${HEADER}test('x', () => assert.equal(1, 1));\n` });
  const r = runTests(dir, 'a.test.js', ['a.js']);
  assert.equal(r.failureKind, 'passed');
  assert.equal(r.exitCode, 0);
});

test('файл без тестов — no-tests', (t) => {
  const dir = workdir(t, { 'a.test.js': 'export {};\n' });
  assert.equal(runTests(dir, 'a.test.js', ['a.js']).failureKind, 'no-tests');
});

test('файл без тестов во вложенной директории — тоже no-tests, а не passed', (t) => {
  const dir = workdir(t, { 'sub/a.test.js': 'export {};\n' });
  assert.equal(runTests(dir, 'sub/a.test.js', ['a.js']).failureKind, 'no-tests');
});

test('отсутствующий тестовый файл не бросает исключение, а даёт load-error', (t) => {
  const dir = workdir(t, {});
  const r = runTests(dir, 'nope.test.js', ['a.js']);
  assert.equal(r.failureKind, 'load-error');
  assert.equal(r.testFileSha256, '');
});
