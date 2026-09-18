import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isAllowedWritePath, isSafeRelativePath, normalizeRelativePath } from './pathSafety.js';

test('isSafeRelativePath принимает обычные относительные пути', () => {
  for (const p of ['a.js', 'src/a.js', './src/a.test.js', 'src/../a.js']) {
    assert.equal(isSafeRelativePath(p), true, p);
  }
});

test('isSafeRelativePath отклоняет выход за workdir и абсолютные пути', () => {
  for (const p of ['', '.', '..', '../a.js', 'src/../../a.js', '..\\a.js', '/etc/passwd', 'C:\\Windows\\a.js', 'C:/a.js', 'a\0.js']) {
    assert.equal(isSafeRelativePath(p), false, JSON.stringify(p));
  }
});

test('normalizeRelativePath сводит разные записи одного файла к одной', () => {
  assert.equal(normalizeRelativePath('./a.js'), 'a.js');
  assert.equal(normalizeRelativePath('sub/../a.js'), 'a.js');
  assert.equal(normalizeRelativePath('sub\\x.js'), 'sub/x.js');
});

const cwd = path.resolve('/work');

test('isAllowedWritePath сравнивает разрешённые пути, а не строки', () => {
  assert.equal(isAllowedWritePath(cwd, ['src/a.js'], 'src/a.js'), true);
  assert.equal(isAllowedWritePath(cwd, ['src/a.js'], './src/../src/a.js'), true);
  assert.equal(isAllowedWritePath(cwd, ['src/a.js'], path.join(cwd, 'src', 'a.js')), true);
  assert.equal(isAllowedWritePath(cwd, ['src/a.js'], 'src/b.js'), false);
  assert.equal(isAllowedWritePath(cwd, ['src/a.js'], '../work/src/b.js'), false);
});
