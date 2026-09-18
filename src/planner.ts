import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Task } from './types.js';
import { runDirPaths } from './runDir.js';
import { DecisionLog } from './decisions.js';
import { makeLogger } from './logger.js';

const log = makeLogger('planner');

const TaskSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'id должен быть безопасен для имени файла (только a-z0-9-)'),
  title: z.string().min(1),
  description: z.string().min(1),
  testFirst: z.string().min(1),
  testFile: z.string().min(1),
  targetFiles: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const PlanSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
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
          title: { type: 'string' },
          description: { type: 'string' },
          testFirst: {
            type: 'string',
            description: 'Что именно должно упасть первым как красный тест',
          },
          testFile: {
            type: 'string',
            description: 'Уникальный путь к тестовому файлу этой задачи, относительно workdir',
          },
          targetFiles: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
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
- Каждая подзадача не должна пересекаться с другими по testFile и targetFiles — исполнители работают параллельно и не координируются между собой.
- Для каждой подзадачи testFirst описывает, что именно должно упасть как красный тест ДО реализации кода (test-first, TDD).
- testFile — уникальный относительный путь (например "math/add.test.js"), обязательно с валидным расширением для node --test.
- targetFiles — файлы с реализацией, которые создаст/изменит исполнитель этой подзадачи.
- acceptanceCriteria — конкретные, проверяемые критерии приёмки.
- id — короткий kebab-case идентификатор ("task-1", "add-function").

Верни только структурированный JSON по схеме, без пояснений.`;

export type PlanResult = {
  tasks: Task[];
  overlapWarning: boolean;
  usage: { inputTokens: number; outputTokens: number };
};

function findOverlaps(tasks: Task[]): string[] {
  const seenTestFiles = new Map<string, string>();
  const seenTargetFiles = new Map<string, string>();
  const warnings: string[] = [];

  for (const task of tasks) {
    const prevTestOwner = seenTestFiles.get(task.testFile);
    if (prevTestOwner) {
      warnings.push(`testFile "${task.testFile}" используется и в "${prevTestOwner}", и в "${task.id}"`);
    } else {
      seenTestFiles.set(task.testFile, task.id);
    }

    for (const file of task.targetFiles) {
      const prevTargetOwner = seenTargetFiles.get(file);
      if (prevTargetOwner) {
        warnings.push(`targetFile "${file}" используется и в "${prevTargetOwner}", и в "${task.id}"`);
      } else {
        seenTargetFiles.set(file, task.id);
      }
    }
  }

  return warnings;
}

type PlannerQueryResult = { output: unknown; usage: { inputTokens: number; outputTokens: number } };

async function runPlannerQuery(prompt: string): Promise<PlannerQueryResult> {
  const q = query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxTurns: 4,
      outputFormat: { type: 'json_schema', schema: PLAN_JSON_SCHEMA },
    },
  });

  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        throw new Error(`planner query завершился с ошибкой: ${message.subtype}`);
      }
      for (const m of Object.values(message.modelUsage)) {
        usage = { inputTokens: usage.inputTokens + m.inputTokens, outputTokens: usage.outputTokens + m.outputTokens };
      }
      return { output: message.structured_output, usage };
    }
  }
  throw new Error('planner query завершился без result-сообщения');
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

let { output: raw, usage } = await runPlannerQuery(taskDescription);
  let parsed = PlanSchema.safeParse(raw);

  if (!parsed.success) {
    log.warn('первый ответ планировщика не прошёл валидацию, делаю один ретрай');
    const retryPrompt = `${taskDescription}\n\nПредыдущий ответ не прошёл валидацию схемы:\n${parsed.error.message}\n\nИсправь и верни снова корректный JSON.`;
    const retry = await runPlannerQuery(retryPrompt);
    raw = retry.output;
    usage = { inputTokens: usage.inputTokens + retry.usage.inputTokens, outputTokens: usage.outputTokens + retry.usage.outputTokens };
    parsed = PlanSchema.safeParse(raw);
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
