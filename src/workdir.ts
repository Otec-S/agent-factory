import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, snapshotTree } from './git.js';

/**
 * Готовит рабочую директорию задачи к работе: без этого ESM-импорты
 * в сгенерированном коде и git diff не заработают.
 * Возвращает baseTree — снимок workdir, от которого потом считается diff рана.
 */
export function bootstrapWorkdir(workdir: string): { baseTree: string } {
  mkdirSync(workdir, { recursive: true });

  const pkgPath = path.join(workdir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: 'agent-factory-target', type: 'module' }, null, 2) + '\n', 'utf-8');
  }

  // Проверяем именно наличие workdir/.git, а не "внутри ли мы какого-то репозитория":
  // `git rev-parse --is-inside-work-tree` вернёт true и для workdir, вложенного в
  // родительский репозиторий (например, ./scratch внутри самого agent-factory) —
  // тогда diff захватил бы файлы родительского репозитория, а не только workdir.
  if (!existsSync(path.join(workdir, '.git'))) {
    git(workdir, ['init', '-q']);
  }

  return { baseTree: snapshotTree(workdir) };
}
