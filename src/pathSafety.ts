import path from 'node:path';

/** "./a.js", "a.js", "sub/../a.js" и "sub\..\a.js" приводятся к одному виду "a.js". */
export function normalizeRelativePath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

/**
 * Путь из плана должен быть относительным и не выходить за workdir:
 * без этого planner (т.е. модель) мог бы направить воркера писать куда угодно.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.includes('\0')) return false;
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) return false;
  const normalized = normalizeRelativePath(p);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  // Файловые системы Windows/macOS по умолчанию регистронезависимы.
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Разрешён ли `filePath` (абсолютный или относительно cwd) к записи — сравнение по разрешённым путям, не по строкам. */
export function isAllowedWritePath(cwd: string, allowedRelative: string[], filePath: string): boolean {
  const target = normalizeForCompare(path.resolve(cwd, filePath));
  return allowedRelative.some((a) => normalizeForCompare(path.resolve(cwd, a)) === target);
}

/** Совпадают ли два пути после разрешения (с учётом регистронезависимых ФС). */
export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}
