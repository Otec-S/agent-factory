import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Task, TokenUsage } from './types.js';
import { runDirPaths } from './runDir.js';
import { DecisionLog } from './decisions.js';
import { makeLogger } from './logger.js';
import { runAgentQuery } from './agentQuery.js';
import { isSafeRelativePath, normalizeRelativePath } from './pathSafety.js';
import { addUsage } from './usage.js';

const log = makeLogger('planner');

const SafePath = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, 'путь должен быть относительным и не выходить за пределы workdir');

const TaskSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'id должен быть безопасен для имени файла (только a-z0-9-)'),
  title: z.string().min(1),
  description: z.string().min(1),
  testFirst: z.string().min(1),
  testFile: SafePath,
  targetFiles: z.array(SafePath).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const PlanSchema = z.object({
  // id — имя evidence-файла и ключ в usage.json: дубликат молча перезаписал бы чужой результат.
  tasks: z
    .array(TaskSchema)
    .min(1)
    .refine((tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length, 'id подзадач должны быть уникальными'),
});

// Ручная JSON Schema для outputFormat — держим синхронно с TaskSchema выше.
const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'testFirst', 'testFile', 'targetFiles', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]+$' },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          testFirst: {
            type: 'string',
            minLength: 1,
            description: 'Что именно должно упасть первым как красный тест',
          },
          testFile: {
            type: 'string',
            minLength: 1,
            description: 'Уникальный путь к тестовому файлу этой задачи, относительно workdir',
          },
          targetFiles: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `Ты технический лид в духе superpowers:writing-plans.
Разбей задачу пользователя на независимые подзадачи для параллельных исполнителей.

Правила:
- Целевой проект — Node.js в режиме ESM (package.json "type": "module"): только import/export, никаких require/module.exports; тесты — на node:test и node:assert/strict.
- Каждая подзадача не должна пересекаться с другими по testFile и targetFiles — исполнители работают параллельно и не координируются между собой.
- Для каждой подзадачи testFirst описывает, что именно должно упасть как красный тест ДО реализации кода (test-first, TDD).
- testFile — уникальный относительный путь (например "math/add.test.js"), обязательно с валидным расширением для node --test.
- targetFiles — файлы с реализацией, которые создаст/изменит исполнитель этой подзадачи.
- Все пути — относительные, без ".." и без абсолютных путей: исполнитель физически не сможет писать вне workdir.
- acceptanceCriteria — конкретные, проверяемые критерии приёмки.
- id — короткий kebab-case идентификатор ("task-1", "add-function").

Верни только структурированный JSON по схеме, без пояснений.`;

export type PlanResult = {
  tasks: Task[];
  overlapWarning: boolean;
  usage: TokenUsage;
};

export function findOverlaps(tasks: Task[]): string[] {
  const seenTestFiles = new Map<string, string>();
  const seenTargetFiles = new Map<string, string>();
  const warnings: string[] = [];

  for (const task of tasks) {
    const testFile = normalizeRelativePath(task.testFile);
    const prevTestOwner = seenTestFiles.get(testFile);
    if (prevTestOwner) {
      warnings.push(`testFile "${task.testFile}" используется и в "${prevTestOwner}", и в "${task.id}"`);
    } else {
      seenTestFiles.set(testFile, task.id);
    }

    for (const rawFile of task.targetFiles) {
      const file = normalizeRelativePath(rawFile);
      const prevTargetOwner = seenTargetFiles.get(file);
      if (prevTargetOwner) {
        warnings.push(`targetFile "${rawFile}" используется и в "${prevTargetOwner}", и в "${task.id}"`);
      } else {
        seenTargetFiles.set(file, task.id);
      }
    }
  }

  return warnings;
}

async function runPlannerQuery(prompt: string) {
  const { structuredOutput, usage } = await runAgentQuery('planner', prompt, {
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    maxTurns: 4,
    outputFormat: { type: 'json_schema', schema: PLAN_JSON_SCHEMA },
  });
  return { output: structuredOutput, usage };
}

function renderPlanMd(taskDescription: string, tasks: Task[]): string {
  const lines = [`# План`, '', `## Исходная задача`, '', taskDescription, '', `## Подзадачи`, ''];
  for (const task of tasks) {
    lines.push(`### ${task.id}: ${task.title}`);
    lines.push('');
    lines.push(task.description);
    lines.push('');
    lines.push(`**Test-first:** ${task.testFirst}`);
    lines.push(`**Тестовый файл:** \`${task.testFile}\``);
    lines.push(`**Целевые файлы:** ${task.targetFiles.map((f) => `\`${f}\``).join(', ')}`);
    lines.push('');
    lines.push('**Критерии приёмки:**');
    for (const c of task.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Один вызов Agent SDK: описание задачи -> plan.md (человекочитаемый) + Task[] (машинный).
 * Пересечения testFile/targetFiles между задачами проверяются детерминированно, без модели.
 */
export async function plan(taskDescription: string, runDir: string): Promise<PlanResult> {
  const paths = runDirPaths(runDir);
  const decisions = new DecisionLog(runDir);

  const first = await runPlannerQuery(taskDescription);
  let usage = first.usage;
  let parsed = PlanSchema.safeParse(first.output);

  if (!parsed.success) {
    log.warn('первый ответ планировщика не прошёл валидацию, делаю один ретрай');
    const retryPrompt = `${taskDescription}\n\nПредыдущий ответ не прошёл валидацию схемы:\n${parsed.error.message}\n\nИсправь и верни снова корректный JSON.`;
    const retry = await runPlannerQuery(retryPrompt);
    usage = addUsage(usage, retry.usage);
    parsed = PlanSchema.safeParse(retry.output);
  }

  if (!parsed.success) {
    decisions.record('plan.created', 'failed', 'llm', { error: parsed.error.message });
    throw new Error(`planner: невалидный вывод после ретрая: ${parsed.error.message}`);
  }

  const tasks = parsed.data.tasks;
  const overlaps = findOverlaps(tasks);
  if (overlaps.length > 0) {
    for (const w of overlaps) log.warn(w);
    decisions.record('plan.overlap-check', 'overlap-detected', 'deterministic', { overlaps });
  } else {
    decisions.record('plan.overlap-check', 'ok', 'deterministic', {});
  }

  writeFileSync(paths.tasksJson, JSON.stringify(tasks, null, 2), 'utf-8');
  writeFileSync(paths.planMd, renderPlanMd(taskDescription, tasks), 'utf-8');
  writeFileSync(paths.plannerUsageJson, JSON.stringify({ usage, overlapWarning: overlaps.length > 0 }, null, 2), 'utf-8');
  decisions.record('plan.created', 'ok', 'llm', { taskCount: tasks.length });

  return { tasks, overlapWarning: overlaps.length > 0, usage };
}
