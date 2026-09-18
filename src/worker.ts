import { writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runTests } from './testRunner.js';
import { runDirPaths } from './runDir.js';
import { makeLogger } from './logger.js';
import type { Task, WorkerResult, Evidence, TestRun } from './types.js';

export type WorkerInput = {
  task: Task;
  workdir: string;
  runDir: string;
  maxAttempts: number;
};

type TurnUsage = { inputTokens: number; outputTokens: number };

const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/**
 * Один "ход" Agent SDK с узким набором разрешённых к записи путей.
 * Воркеру запрещено трогать чужие файлы — это перечислено прямо в system-промпте.
 */
async function runAgentTurn(prompt: string, cwd: string, allowedWritePaths: string[]): Promise<TurnUsage> {
  const systemPrompt = `Ты инженер, реализующий одну изолированную подзадачу в общем репозитории.
Тебе разрешено СОЗДАВАТЬ и РЕДАКТИРОВАТЬ только следующие файлы: ${allowedWritePaths.join(', ')}.
Любые другие файлы в репозитории — только для чтения, не трогай их, даже если кажется, что так было бы проще.
Работай только через инструменты для файлов, не проси подтверждения — просто делай.`;

  const q = query({
    prompt,
    options: {
      cwd,
      systemPrompt,
      tools: ['Read', 'Write', 'Edit', 'Glob'],
      allowedTools: ['Read', 'Write', 'Edit', 'Glob'],
      maxTurns: 10,
    },
  });

  let usage: TurnUsage = ZERO_USAGE;
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        throw new Error(`agent turn завершился с ошибкой: ${message.subtype}`);
      }
      for (const modelUsage of Object.values(message.modelUsage)) {
        usage = addUsage(usage, { inputTokens: modelUsage.inputTokens, outputTokens: modelUsage.outputTokens });
      }
    }
  }
  return usage;
}

function summarizeTestRun(run: TestRun): string {
  return `команда: ${run.cmd}\nexitCode: ${run.exitCode}\ntestsRan: ${run.testsRan}\ntestsFailed: ${run.testsFailed}\nвывод:\n${run.output}`;
}

/** Точка входа процесса-воркера: один изолированный TDD-цикл на одну задачу. */
export async function runWorker(input: WorkerInput): Promise<WorkerResult> {
  const { task, workdir, runDir, maxAttempts } = input;
  const log = makeLogger(`worker:${task.id}`);
  const paths = runDirPaths(runDir);
  let usage: TurnUsage = ZERO_USAGE;

  try {
    // Шаг 1-3: пишем падающий тест, при ошибке загрузки модуля — чиним и повторяем.
    let red: TestRun | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? `Напиши тест в файле "${task.testFile}" (относительно ${workdir}), который проверяет:\n${task.testFirst}\n\nОписание задачи: ${task.description}\nКритерии приёмки:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nТест должен реально импортировать реализацию из ${task.targetFiles.join(', ')} и падать, пока эти файлы не реализованы (модулей ещё не существует). Используй node:test и node:assert/strict.`
          : `Предыдущая попытка написать тест в "${task.testFile}" привела к ошибке загрузки, а не к падению реального теста:\n${summarizeTestRun(red!)}\n\nИсправь тестовый файл так, чтобы он синтаксически корректно импортировался и содержал реально падающую проверку для: ${task.testFirst}`;

      usage = addUsage(usage, await runAgentTurn(prompt, workdir, [task.testFile]));
      red = runTests(workdir, task.testFile);
      log.info(`red attempt ${attempt}: exitCode=${red.exitCode} testsRan=${red.testsRan} testsFailed=${red.testsFailed}`);

      if (red.testsRan > 0) break; // реальный прогон состоялся, ошибка загрузки исправлена (или её не было)
    }

    if (!red) throw new Error('не удалось получить red-прогон');

    // Шаг 4-5: реализуем код до прохождения теста, не более maxAttempts итераций.
    let green: TestRun | null = null;
    let lastRun: TestRun = red;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? `Реализуй код в файлах ${task.targetFiles.join(', ')} так, чтобы тест "${task.testFile}" прошёл.\n\nТекущий (падающий) прогон теста:\n${summarizeTestRun(lastRun)}\n\nОписание задачи: ${task.description}\nНе изменяй файл "${task.testFile}".`
          : `Тест "${task.testFile}" всё ещё не проходит после предыдущей попытки. Текущий прогон:\n${summarizeTestRun(lastRun)}\n\nИсправь реализацию в ${task.targetFiles.join(', ')}. Не изменяй файл "${task.testFile}".`;

      usage = addUsage(usage, await runAgentTurn(prompt, workdir, task.targetFiles));
      lastRun = runTests(workdir, task.testFile);
      log.info(`green attempt ${attempt}: exitCode=${lastRun.exitCode} testsRan=${lastRun.testsRan} testsFailed=${lastRun.testsFailed}`);

      if (lastRun.exitCode === 0 && lastRun.testsRan > 0) {
        green = lastRun;
        break;
      }
    }

    const evidence: Evidence = { taskId: task.id, red, green, attempts: maxAttempts };
    writeFileSync(paths.evidenceFile(task.id), JSON.stringify(evidence, null, 2), 'utf-8');

    const result: WorkerResult = {
      taskId: task.id,
      status: green ? 'green' : 'red_only',
      changedFiles: green ? [task.testFile, ...task.targetFiles] : [task.testFile],
      summary: green
        ? `задача ${task.id}: тест прошёл после ${evidence.attempts} попыток`
        : `задача ${task.id}: тест так и не прошёл после ${maxAttempts} попыток`,
      usage,
    };
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    return {
      taskId: task.id,
      status: 'error',
      changedFiles: [],
      summary: `задача ${task.id}: ошибка воркера`,
      usage,
      error: message,
    };
  }
}

// Точка входа при запуске как форкнутый процесс: ждём одно IPC-сообщение с WorkerInput,
// выполняем задачу и отправляем WorkerResult обратно.
if (typeof process.send === 'function') {
  process.once('message', async (input: WorkerInput) => {
    const result = await runWorker(input);
    process.send!(result);
    process.exit(result.status === 'error' ? 1 : 0);
  });
}
