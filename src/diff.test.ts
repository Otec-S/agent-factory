import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapWorkdir } from './workdir.js';
import { freezeDiff } from './diff.js';
import { git } from './git.js';
import { runDirPaths } from './runDir.js';

function tempDirs(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'af-diff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  const runDir = path.join(root, 'run');
  mkdirSync(runDir, { recursive: true });
  return { workdir, runDir };
}

test('diff содержит только изменения после bootstrap, а не файлы, существовавшие до рана', (t) => {
  const { workdir, runDir } = tempDirs(t);
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, 'old.js'), 'export const old = 1;\n'); // "прошлый ран" / чужие правки

  const { baseTree } = bootstrapWorkdir(workdir);
  writeFileSync(path.join(workdir, 'new.js'), 'export const fresh = 1;\n');
  writeFileSync(path.join(workdir, 'old.js'), 'export const old = 2;\n');

  freezeDiff(workdir, runDir, baseTree, []);

  const paths = runDirPaths(runDir);
  assert.deepEqual(JSON.parse(readFileSync(paths.changedFilesJson, 'utf-8')), ['new.js', 'old.js']);
  const patch = readFileSync(paths.diffPatch, 'utf-8');
  assert.match(patch, /\+export const fresh = 1;/);
  assert.match(patch, /-export const old = 1;/);
  assert.doesNotMatch(patch, /package\.json/); // создан bootstrap'ом, т.е. входит в базу
});

test('снимки не трогают индекс пользователя', (t) => {
  const { workdir, runDir } = tempDirs(t);
  const { baseTree } = bootstrapWorkdir(workdir);
  writeFileSync(path.join(workdir, 'a.js'), 'x\n');
  freezeDiff(workdir, runDir, baseTree, []);
  assert.equal(git(workdir, ['status', '--porcelain']).includes('A '), false);
  assert.equal(git(workdir, ['ls-files']).trim(), '');
});

test('changed-files объединяет git и заявленные воркерами файлы', (t) => {
  const { workdir, runDir } = tempDirs(t);
  const { baseTree } = bootstrapWorkdir(workdir);
  writeFileSync(path.join(workdir, 'a.js'), 'x\n');
  freezeDiff(workdir, runDir, baseTree, [{ taskId: 't', status: 'green', changedFiles: ['a.js', 'b.js'], summary: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }]);
  assert.deepEqual(JSON.parse(readFileSync(runDirPaths(runDir).changedFilesJson, 'utf-8')), ['a.js', 'b.js']);
});

test('ошибка git не превращается молча в пустой diff', (t) => {
  const { workdir, runDir } = tempDirs(t);
  bootstrapWorkdir(workdir);
  assert.throws(() => freezeDiff(workdir, runDir, 'deadbeef'.repeat(5), []), /git diff/);
});
