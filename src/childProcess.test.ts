import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChild } from './childProcess.js';

const CHILD_PROCESS_MODULE = pathToFileURL(path.join(import.meta.dirname, 'childProcess.js')).href;

type Out = { kind: string; value?: unknown };

function fixture(t: { after: (fn: () => void) => void }, body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'af-child-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child.mjs');
  writeFileSync(file, `import { serveChild } from ${JSON.stringify(CHILD_PROCESS_MODULE)};\n${body}\n`);
  return file;
}

const callbacks = {
  onTimeout: (): Out => ({ kind: 'timeout' }),
  onFailure: (message: string): Out => ({ kind: 'failure', value: message }),
};

test('результат доставляется, даже если процесс сразу выходит (exit после send)', async (t) => {
  // Большое сообщение: при process.exit сразу после send оно терялось бы.
  const entry = fixture(t, `serveChild(async (input) => ({ kind: 'ok', value: input.n * 2, pad: 'x'.repeat(2_000_000) }), () => 1);`);
  const r = await runChild<{ n: number }, Out>({ entry, input: { n: 21 }, timeoutSec: 30, ...callbacks });
  assert.equal(r.kind, 'ok');
  assert.equal(r.value, 42);
});

test('процесс, вышедший без результата, нормализуется в onFailure', async (t) => {
  const entry = fixture(t, `serveChild(async () => { process.exit(3); }, () => 0);`);
  const r = await runChild<object, Out>({ entry, input: {}, timeoutSec: 30, ...callbacks });
  assert.equal(r.kind, 'failure');
  assert.match(String(r.value), /code 3/);
});

test('по таймауту процесс получает abort и промис разрешается только после его выхода', async (t) => {
  const entry = fixture(
    t,
    `serveChild((_input, ac) => new Promise((resolve) => ac.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }))), () => 0);`,
  );
  const started = Date.now();
  const r = await runChild<object, Out>({ entry, input: {}, timeoutSec: 1, ...callbacks });
  assert.equal(r.kind, 'timeout');
  assert.ok(Date.now() - started < 4_000, 'процесс должен выйти по abort, не дожидаясь принудительного kill');
});

test('процесс, игнорирующий abort, убивается принудительно', async (t) => {
  const entry = fixture(t, `serveChild(() => new Promise(() => { setInterval(() => {}, 1000); }), () => 0);`);
  const r = await runChild<object, Out>({ entry, input: {}, timeoutSec: 1, ...callbacks });
  assert.equal(r.kind, 'timeout');
});

test('несуществующая точка входа — onFailure, а не исключение', async () => {
  const r = await runChild<object, Out>({ entry: path.join(os.tmpdir(), 'af-no-such-entry.mjs'), input: {}, timeoutSec: 5, ...callbacks });
  assert.equal(r.kind, 'failure');
});
