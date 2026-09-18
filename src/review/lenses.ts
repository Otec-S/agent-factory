import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, LensName } from '../types.js';
import { reviewPaths } from '../runDir.js';

const AGENT_FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STANDARDS_MD_PATH = path.join(AGENT_FACTORY_ROOT, 'standards.md');

export const LENS_NAMES: LensName[] = ['blind', 'acceptance', 'standards'];

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'rationale'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

export type LensPrompt = { systemPrompt: string; prompt: string };

const BASE_SYSTEM_PROMPT = `Ты один из независимых ревьюеров (линз) в многолинзовой стадии ревью.
Пиши находки БЕЗ severity и без итогового вердикта — это работа отдельного triage-агента.
Верни только структурированный JSON по схеме, без пояснений.`;

/**
 * Каждая линза читает СВОЙ узкий набор файлов с диска и получает узкий prompt —
 * контекстная изоляция. Именно в разных входах у линз весь смысл упражнения.
 */
export function buildLensPrompt(name: LensName, runDir: string, workdir: string, tasks: Task[], round = 1): LensPrompt {
  const paths = reviewPaths(runDir, round);

  if (name === 'blind') {
    const diff = readFileSync(paths.diffPatch, 'utf-8');
    return {
      systemPrompt: `${BASE_SYSTEM_PROMPT}\nТы — скептик без знания проекта. Ищи пропущенное так же усердно, как и неверное.`,
      prompt: `Вот единственное, что тебе известно, — сырой diff. Никакого описания задачи у тебя нет.\n\n${diff}`,
    };
  }

  if (name === 'acceptance') {
    const diff = readFileSync(paths.diffPatch, 'utf-8');
    const tasksJson = JSON.stringify(tasks, null, 2);
    return {
      systemPrompt: `${BASE_SYSTEM_PROMPT}\nСверяй diff с каждым критерием приёмки по очереди.`,
      prompt: `Задачи и их критерии приёмки:\n${tasksJson}\n\nDiff, реализующий эти задачи:\n${diff}\n\nДля каждого критерия приёмки, который НЕ выполнен, заведи находку.`,
    };
  }

  // standards: НЕ открывает diff построчно — только итоговое содержимое изменённых файлов + чек-лист.
  const changedFiles: string[] = JSON.parse(readFileSync(paths.changedFilesJson, 'utf-8'));
  const standards = readFileSync(STANDARDS_MD_PATH, 'utf-8');
  const fileContents = changedFiles
    .map((f) => {
      try {
        return `### ${f}\n\`\`\`\n${readFileSync(path.join(workdir, f), 'utf-8')}\n\`\`\``;
      } catch {
        return `### ${f}\n(файл недоступен для чтения — возможно, удалён)`;
      }
    })
    .join('\n\n');

  return {
    systemPrompt: `${BASE_SYSTEM_PROMPT}\nАудируй против записанных правил проекта, а не против абстрактного вкуса.`,
    prompt: `Чек-лист правил проекта:\n${standards}\n\nИтоговое содержимое изменённых файлов:\n${fileContents}`,
  };
}
