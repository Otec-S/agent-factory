import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Содержимое файлов на момент снимка; null — файла не было. */
export type FileSnapshot = Map<string, Buffer | null>;

export function snapshotFiles(workdir: string, files: string[]): FileSnapshot {
  const snapshot: FileSnapshot = new Map();
  for (const f of files) {
    const abs = path.join(workdir, f);
    snapshot.set(f, existsSync(abs) ? readFileSync(abs) : null);
  }
  return snapshot;
}

/**
 * Возвращает файлы в состояние снимка: перезаписывает изменённые и удаляет созданные после снимка.
 * Откат делает оркестратор, а не сам процесс fix-up: процесс, убитый по таймауту посреди правки,
 * откатить себя уже не сможет.
 */
export function restoreFiles(workdir: string, snapshot: FileSnapshot): void {
  for (const [f, content] of snapshot) {
    const abs = path.join(workdir, f);
    if (content === null) {
      rmSync(abs, { force: true });
    } else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
}
