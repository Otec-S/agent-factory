import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreFiles, snapshotFiles } from './fileSnapshot.js';

test('restoreFiles возвращает изменённые файлы и удаляет созданные после снимка', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'af-snapshot-'));
  try {
    writeFileSync(path.join(dir, 'a.js'), 'original');
    const snapshot = snapshotFiles(dir, ['a.js', 'sub/new.js']);

    writeFileSync(path.join(dir, 'a.js'), 'broken');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'new.js'), 'created by agent');
    writeFileSync(path.join(dir, 'new-elsewhere.js'), 'not in snapshot');
    restoreFiles(dir, snapshot);

    assert.equal(readFileSync(path.join(dir, 'a.js'), 'utf-8'), 'original');
    assert.equal(existsSync(path.join(dir, 'sub', 'new.js')), false);
    // Файлы вне снимка не трогаются — откат узкий, как и права записи.
    assert.equal(existsSync(path.join(dir, 'new-elsewhere.js')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
