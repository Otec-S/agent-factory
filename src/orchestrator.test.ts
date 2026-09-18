import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchFixups } from './orchestrator.js';
import { runDirPaths } from './runDir.js';
import type { ReviewFinding, Task } from './types.js';

test('dispatchFixups: задача с красным тестом пропускается без запуска агента, resume берёт сохранённый результат', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'af-fixup-'));
  try {
    const workdir = path.join(root, 'work');
    const runDir = path.join(root, 'run');
    mkdirSync(workdir);
    mkdirSync(runDir);
    writeFileSync(path.join(workdir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(workdir, 'a.js'), 'export const a = () => 1;\n');
    writeFileSync(path.join(workdir, 'a.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from './a.js';\ntest('a', () => assert.equal(a(), 2));\n");

    const task: Task = { id: 't1', title: 't1', description: '', testFirst: '', testFile: 'a.test.js', targetFiles: ['a.js'], acceptanceCriteria: [] };
    const finding: ReviewFinding = { title: 'bug', file: 'a.js', rationale: 'r', severity: 'major', sources: ['blind'] };
    const plan = { assignments: [{ taskId: 't1', findings: [finding] }], unassigned: [] };
    const opts = { parallel: false, maxAttempts: 1, timeoutSec: 30 };

    const [result] = await dispatchFixups(plan, [task], workdir, runDir, opts);
    assert.equal(result.status, 'skipped');
    assert.equal(result.finalRun?.failureKind, 'assertion');
    assert.equal(readFileSync(path.join(workdir, 'a.js'), 'utf-8'), 'export const a = () => 1;\n');
    assert.ok(existsSync(runDirPaths(runDir).fixupResultFile('t1')));

    // Даже если задачу "починили" руками, resume не перезапускает уже отработавший fix-up.
    writeFileSync(path.join(workdir, 'a.js'), 'export const a = () => 2;\n');
    const [again] = await dispatchFixups(plan, [task], workdir, runDir, opts);
    assert.deepEqual(again, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
