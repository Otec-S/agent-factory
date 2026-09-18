import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv } from './env.js';

function envFile(t: { after: (fn: () => void) => void }, content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'af-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  writeFileSync(file, content);
  return file;
}

test('загружает значения из .env', (t) => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadDotEnv(envFile(t, 'ANTHROPIC_API_KEY=sk-test\nOTHER="x y"\n'), env), ['ANTHROPIC_API_KEY', 'OTHER']);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
  assert.equal(env.OTHER, 'x y');
});

test('не перетирает заданные переменные окружения', (t) => {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-shell' };
  loadDotEnv(envFile(t, 'ANTHROPIC_API_KEY=from-file\n'), env);
  assert.equal(env.ANTHROPIC_API_KEY, 'from-shell');
});

test('пустое значение из .env.example не задаёт пустой ключ', (t) => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadDotEnv(envFile(t, 'ANTHROPIC_API_KEY=\n'), env), []);
  assert.equal('ANTHROPIC_API_KEY' in env, false);
});

test('отсутствующий файл — не ошибка', () => {
  assert.deepEqual(loadDotEnv(path.join(os.tmpdir(), 'af-no-such.env'), {}), []);
});
