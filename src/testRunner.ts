import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FailureKind, TestRun } from './types.js';
import { normalizeRelativePath, samePath } from './pathSafety.js';

const MAX_OUTPUT_BYTES = 8 * 1024;
const TEST_TIMEOUT_MS = 60_000;

function truncate(text: string): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= MAX_OUTPUT_BYTES) return text;
  return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8') + '\n…(truncated)';
}

/** Парсит итоговую сводку TAP: "# tests N" и "# fail N". */
export function parseTap(output: string): { testsRan: number; testsFailed: number } {
  const testsMatch = output.match(/^# tests (\d+)/m);
  const failMatch = output.match(/^# fail (\d+)/m);
  return {
    testsRan: testsMatch ? Number(testsMatch[1]) : 0,
    testsFailed: failMatch ? Number(failMatch[1]) : 0,
  };
}

export type ClassifyInput = {
  exitCode: number;
  output: string; // полный stdout (TAP): stderr упавшего при загрузке файла node --test кладёт туда же комментариями
  testsRan: number;
  testsFailed: number;
  workdir: string;
  testFile: string;
  targetFiles: string[];
};

/**
 * node --test считает ошибку загрузки файла обычным упавшим тестом ("# tests 1 / # fail 1"),
 * поэтому по счётчикам нельзя отличить настоящий red от сломанного теста. Разбираем вывод:
 * отсутствие модуля/экспорта ИЗ targetFiles — это ожидаемый red (реализации ещё нет),
 * любая другая ошибка загрузки — проблема самого тестового файла.
 */
/**
 * Итог псевдотеста уровня файла, если он есть. node --test заводит его, когда в файле
 * нет ни одного test() ("ok") или файл не удалось загрузить/выполнить ("not ok"); он назван
 * путём к самому файлу в формате ОС с TAP-экранированием ("sub\\a.test.js"). У настоящих
 * тестов имена свои, поэтому это надёжнее, чем разбирать текст стека ошибки.
 */
function filePseudoTest(output: string, testFile: string): 'ok' | 'not ok' | null {
  const target = normalizeRelativePath(testFile);
  for (const m of output.matchAll(/^(ok|not ok) \d+ - (.+?)\r?$/gm)) {
    if (normalizeRelativePath(m[2].replace(/\\(.)/g, '$1')) === target) return m[1] as 'ok' | 'not ok';
  }
  return null;
}

export function classifyRun(input: ClassifyInput): FailureKind {
  const { exitCode, output, testsRan, testsFailed, workdir, testFile, targetFiles } = input;
  const fileLevel = filePseudoTest(output, testFile);

  if (exitCode === 0) {
    const onlyFilePseudoTest = testsRan === 1 && fileLevel === 'ok';
    return testsRan > 0 && !onlyFilePseudoTest ? 'passed' : 'no-tests';
  }

  const isTarget = (absPath: string) => targetFiles.some((t) => samePath(path.resolve(workdir, t), absPath));

  const missingModule = output.match(/ERR_MODULE_NOT_FOUND[\s\S]*?url: '(file:[^']+)'/);
  if (missingModule) {
    return isTarget(fileURLToPath(missingModule[1])) ? 'missing-target' : 'load-error';
  }

  const missingExport = output.match(/The requested module '([^']+)' does not provide an export named/);
  if (missingExport) {
    const resolved = path.resolve(workdir, path.dirname(testFile), missingExport[1]);
    return isTarget(resolved) ? 'missing-target' : 'load-error';
  }

  // Упал сам файл (синтаксис, require в ESM-пакете, исключение на верхнем уровне), а не проверка в test().
  if (fileLevel === 'not ok') return 'load-error';

  if (testsFailed > 0) return 'assertion';
  if (testsRan === 0) return 'no-tests';
  return 'load-error'; // exitCode != 0 без упавших тестов: таймаут, отмена, крах раннера
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Запускает `node --test` со скоупом строго на один файл — никогда без аргумента,
 * иначе прогон подхватит красные тесты соседних задач.
 */
export function runTests(workdir: string, testFile: string, targetFiles: string[]): TestRun {
  const cmd = `node --test --test-reporter=tap ${testFile}`;
  const testFilePath = path.join(workdir, testFile);
  const at = new Date().toISOString();

  // Агент мог не создать файл вовсе — это повод для ещё одной попытки, а не падение воркера.
  if (!existsSync(testFilePath)) {
    return { cmd, exitCode: 1, output: `тестовый файл ${testFile} не существует`, testsRan: 0, testsFailed: 0, failureKind: 'load-error', testFileSha256: '', at };
  }

  // Если фабрика сама запущена под node --test, унаследованный NODE_TEST_CONTEXT переключает
  // дочерний раннер на внутренний протокол вместо TAP — и сводка "# tests N" пропадает.
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    cwd: workdir,
    encoding: 'utf-8',
    timeout: TEST_TIMEOUT_MS,
    env,
  });

  const stdout = result.stdout ?? '';
  const spawnError = result.error ? `\n[runner] ${result.error.message}` : '';
  const exitCode = result.status ?? 1;
  const { testsRan, testsFailed } = parseTap(stdout);
  const failureKind = result.error
    ? 'load-error'
    : classifyRun({ exitCode, output: stdout, testsRan, testsFailed, workdir, testFile, targetFiles });

  return {
    cmd,
    exitCode,
    output: truncate(stdout + (result.stderr ?? '') + spawnError),
    testsRan,
    testsFailed,
    failureKind,
    testFileSha256: sha256File(testFilePath),
    at,
  };
}
