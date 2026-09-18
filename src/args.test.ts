import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs } from './args.js';

const cwd = path.resolve('/base');
const readTask = (arg: string) => `desc:${arg}`;
const parse = (argv: string[]) => parseArgs(argv, readTask, cwd);

test('форма --flag=value', () => {
  const a = parse(['task.txt', '--workdir=./scratch']);
  assert.equal(a.mode, 'new');
  assert.ok(a.mode === 'new');
  assert.equal(a.workdir, path.resolve(cwd, 'scratch'));
  assert.equal(a.taskDescription, 'desc:task.txt');
});

test('форма --flag value из README работает и значение не считается позиционным', () => {
  const a = parse(['task.txt', '--workdir', './scratch', '--max-attempts', '2']);
  assert.ok(a.mode === 'new');
  assert.equal(a.workdir, path.resolve(cwd, 'scratch'));
  assert.equal(a.maxAttempts, 2);
});

test('значения по умолчанию', () => {
  const a = parse(['t', '--workdir=w']);
  assert.ok(a.mode === 'new');
  assert.equal(a.parallel, false);
  assert.equal(a.maxAttempts, 4);
  assert.equal(a.workerTimeoutSec, 300);
  assert.equal(a.lensTimeoutSec, 600);
});

test('--parallel', () => {
  const a = parse(['t', '--workdir=w', '--parallel']);
  assert.ok(a.mode === 'new' && a.parallel);
});

test('нечисловой или неположительный таймаут — ошибка, а не NaN', () => {
  assert.throws(() => parse(['t', '--workdir=w', '--worker-timeout=abc']), /worker-timeout/);
  assert.throws(() => parse(['t', '--workdir=w', '--worker-timeout=0']), /worker-timeout/);
  assert.throws(() => parse(['t', '--workdir=w', '--max-attempts=1.5']), /max-attempts/);
});

test('флаг без значения — ошибка', () => {
  assert.throws(() => parse(['t', '--workdir']), /нужно значение/);
  assert.throws(() => parse(['t', '--workdir', '--parallel']), /нужно значение/);
});

test('неизвестный флаг — ошибка', () => {
  assert.throws(() => parse(['t', '--workdir=w', '--paralel']), /неизвестный флаг --paralel/);
});

test('нет описания задачи или workdir — ошибка', () => {
  assert.throws(() => parse(['--workdir=w']), /нужен аргумент/);
  assert.throws(() => parse(['t']), /--workdir/);
});

test('несколько позиционных аргументов — подсказка про кавычки', () => {
  assert.throws(() => parse(['добавь', 'модуль', '--workdir=w']), /кавычки/);
});

test('resume не требует workdir и описания', () => {
  const a = parse(['--resume', 'runs/x']);
  assert.deepEqual(a, { mode: 'resume', runDir: path.resolve(cwd, 'runs/x'), parallel: undefined, maxAttempts: 4, workerTimeoutSec: 300, lensTimeoutSec: 600 });
});
