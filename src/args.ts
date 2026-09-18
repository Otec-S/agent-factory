import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Args =
  | { mode: 'new'; taskDescription: string; workdir: string; parallel: boolean; maxAttempts: number; workerTimeoutSec: number; lensTimeoutSec: number }
  | { mode: 'resume'; runDir: string; parallel?: boolean; maxAttempts: number; workerTimeoutSec: number; lensTimeoutSec: number };

const VALUE_FLAGS = new Set(['workdir', 'resume', 'max-attempts', 'worker-timeout', 'lens-timeout']);
const BOOLEAN_FLAGS = new Set(['parallel']);

export type TaskReader = (arg: string) => string;

/** Аргумент — путь к существующему файлу с описанием, иначе само описание строкой. */
const defaultTaskReader: TaskReader = (arg) => (existsSync(arg) ? readFileSync(arg, 'utf-8').trim() : arg);

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // NaN здесь опасен: setTimeout(fn, NaN) срабатывает немедленно и убил бы каждого воркера.
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} должен быть целым положительным числом, получено "${raw}"`);
  }
  return value;
}

/** Принимает и `--flag=value`, и `--flag value`. Неизвестные флаги — ошибка, а не тихое игнорирование. */
export function parseArgs(argv: string[], readTask: TaskReader = defaultTaskReader, cwd = process.cwd()): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`флаг --${name} не принимает значения`);
      booleans.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new Error(`флагу --${name} нужно значение`);
      }
      flags.set(name, value);
    } else {
      throw new Error(`неизвестный флаг --${name}`);
    }
  }

  const maxAttempts = positiveInt('max-attempts', flags.get('max-attempts'), 4);
  const workerTimeoutSec = positiveInt('worker-timeout', flags.get('worker-timeout'), 300);
  const lensTimeoutSec = positiveInt('lens-timeout', flags.get('lens-timeout'), 600);
  const parallel = booleans.has('parallel');

  const resume = flags.get('resume');
  if (resume) {
    return { mode: 'resume', runDir: path.resolve(cwd, resume), parallel: parallel ? true : undefined, maxAttempts, workerTimeoutSec, lensTimeoutSec };
  }

  if (positional.length === 0) {
    throw new Error('нужен аргумент: путь к файлу с описанием задачи ИЛИ само описание строкой (либо --resume=<run_dir>)');
  }
  if (positional.length > 1) {
    throw new Error(`ожидался один позиционный аргумент, получено ${positional.length}: описание с пробелами нужно взять в кавычки`);
  }

  const workdir = flags.get('workdir');
  if (!workdir) throw new Error('обязателен флаг --workdir=<path>');

  return { mode: 'new', taskDescription: readTask(positional[0]), workdir: path.resolve(cwd, workdir), parallel, maxAttempts, workerTimeoutSec, lensTimeoutSec };
}
