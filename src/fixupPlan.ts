import path from 'node:path';
import type { BlockingSeverity, FixupPlan, ReviewFinding, Task } from './types.js';
import { normalizeRelativePath } from './pathSafety.js';

export const BLOCKING_SEVERITIES: BlockingSeverity[] = ['critical', 'major'];

export function isBlocking(f: ReviewFinding): boolean {
  return (BLOCKING_SEVERITIES as string[]).includes(f.severity);
}

/**
 * Варианты написания пути из находки, приведённые к виду путей плана. Линзы видят diff,
 * поэтому пишут и "b/math.js", и абсолютный путь, и "./math.js" — все они про один файл.
 */
function candidatePaths(workdir: string, file: string): string[] {
  const raw = path.isAbsolute(file) || path.win32.isAbsolute(file) ? path.relative(workdir, file) : file;
  const normalized = normalizeRelativePath(raw);
  const withoutDiffPrefix = normalized.replace(/^[ab]\//, '');
  return withoutDiffPrefix === normalized ? [normalized] : [normalized, withoutDiffPrefix];
}

/**
 * Детерминированно раскладывает блокирующие (critical/major) находки по задачам —
 * решение "кто чинит" не отдаётся модели. Находка уходит в каждую задачу, у которой
 * её файл входит в targetFiles. Тестовые файлы в fix-up только для чтения: иначе самый
 * дешёвый способ "исправить" находку — ослабить тест.
 */
export function planFixups(findings: ReviewFinding[], tasks: Task[], workdir: string): FixupPlan {
  const byTask = new Map<string, ReviewFinding[]>();
  const unassigned: FixupPlan['unassigned'] = [];

  for (const finding of findings.filter(isBlocking)) {
    if (!finding.file) {
      unassigned.push({ finding, reason: 'no-file' });
      continue;
    }
    const candidates = candidatePaths(workdir, finding.file);
    const matches = (p: string) => candidates.includes(normalizeRelativePath(p));

    const owners = tasks.filter((t) => t.targetFiles.some(matches));
    if (owners.length > 0) {
      for (const t of owners) byTask.set(t.id, [...(byTask.get(t.id) ?? []), finding]);
    } else if (tasks.some((t) => matches(t.testFile))) {
      unassigned.push({ finding, reason: 'test-file' });
    } else {
      unassigned.push({ finding, reason: 'outside-tasks' });
    }
  }

  // Порядок задач — как в плане: fix-up идёт последовательно, и порядок должен быть воспроизводимым.
  const assignments = tasks.filter((t) => byTask.has(t.id)).map((t) => ({ taskId: t.id, findings: byTask.get(t.id)! }));
  return { assignments, unassigned };
}
