import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Запускает git и бросает исключение на любой сбой — пустой вывод от упавшего git не должен выглядеть как "изменений нет". */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} завершился с кодом ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Снимок текущего содержимого workdir (с учётом .gitignore) в виде git-дерева.
 * Используется временный индекс, поэтому ни индекс, ни HEAD пользователя не меняются,
 * а коммит (и настроенный user.name/email) не нужен.
 */
export function snapshotTree(workdir: string): string {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agent-factory-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmpDir, 'index') };
    git(workdir, ['add', '-A', '.'], env);
    return git(workdir, ['write-tree'], env).trim();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
