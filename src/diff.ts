import { writeFileSync } from 'node:fs';
import { runDirPaths } from './runDir.js';
import { git, snapshotTree } from './git.js';
import type { WorkerResult } from './types.js';

/**
 * Замораживает diff в файл. Линзы получают путь к этому файлу, никогда
 * вставленный текст — это удерживает шум diff вне контекста оркестратора.
 *
 * Diff считается между деревом на момент bootstrap (baseTree) и текущим
 * состоянием workdir, поэтому в ревью не попадают ни результаты прошлых ранов
 * в том же workdir, ни незакоммиченные правки, сделанные до старта рана.
 */
export function freezeDiff(workdir: string, runDir: string, baseTree: string, workerResults: WorkerResult[]): void {
  const paths = runDirPaths(runDir);
  const currentTree = snapshotTree(workdir);

  writeFileSync(paths.diffPatch, git(workdir, ['diff', baseTree, currentTree]), 'utf-8');

  const fromGit = git(workdir, ['diff', '--name-only', baseTree, currentTree])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromWorkers = workerResults.flatMap((r) => r.changedFiles);
  const changedFiles = Array.from(new Set([...fromGit, ...fromWorkers])).sort();

  writeFileSync(paths.changedFilesJson, JSON.stringify(changedFiles, null, 2), 'utf-8');
}
