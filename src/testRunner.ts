import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TestRun } from './types.js';

const MAX_OUTPUT_BYTES = 8 * 1024;

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

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Запускает `node --test` со скоупом строго на один файл — никогда без аргумента,
 * иначе прогон подхватит красные тесты соседних задач.
 */
export function runTests(workdir: string, testFile: string): TestRun {
  const cmd = `node --test --test-reporter=tap ${testFile}`;
  const result = spawnSync('node', ['--test', '--test-reporter=tap', testFile], {
    cwd: workdir,
    encoding: 'utf-8',
    timeout: 60_000,
  });

  const output = truncate((result.stdout ?? '') + (result.stderr ?? ''));
  const { testsRan, testsFailed } = parseTap(result.stdout ?? '');

  return {
    cmd,
    exitCode: result.status ?? 1,
    output,
    testsRan,
    testsFailed,
    testFileSha256: sha256File(`${workdir}/${testFile}`),
    at: new Date().toISOString(),
  };
}
