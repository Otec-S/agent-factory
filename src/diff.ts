import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runDirPaths } from './runDir.js';
import type { WorkerResult } from './types.js';

/**
 * Замораживает diff в файл. Линзы получают путь к этому файлу, никогда
 * вставленный текст — это удерживает шум diff вне контекста оркестратора.
 */
export function freezeDiff(workdir: string, runDir: string, workerResults: WorkerResult[]): void {
  const paths = runDirPaths(runDir);

  // intent-to-add: без этого новые файлы не попадут в `git diff`.
  spawnSync('git', ['add', '-A', '-N'], { cwd: workdir });

  const diff = spawnSync('git', ['diff'], { cwd: workdir, encoding: 'utf-8' });
  writeFileSync(paths.diffPatch, diff.stdout ?? '', 'utf-8');

  const nameOnly = spawnSync('git', ['diff', '--name-only'], { cwd: workdir, encoding: 'utf-8' });
  const fromGit = (nameOnly.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromWorkers = workerResults.flatMap((r) => r.changedFiles);
  const changedFiles = Array.from(new Set([...fromGit, ...fromWorkers])).sort();

  writeFileSync(paths.changedFilesJson, JSON.stringify(changedFiles, null, 2), 'utf-8');
}
