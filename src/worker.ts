import { writeFileSync } from 'node:fs';
import { runTests } from './testRunner.js';
import { runDirPaths } from './runDir.js';
import { makeLogger } from './logger.js';
import { runAgentQuery } from './agentQuery.js';
import { serveChild } from './childProcess.js';
import { makeWriteGuard, makeWriteGuardHooks } from './writeGuard.js';
import { VALID_RED_KINDS } from './evidenceValidator.js';
import { addUsage, ZERO_USAGE } from './usage.js';
import type { Task, WorkerResult, Evidence, TestRun, TokenUsage } from './types.js';

export type WorkerInput = {
  task: Task;
  workdir: string;
  runDir: string;
  maxAttempts: number;
};

// Должно совпадать с тем, что создаёт bootstrapWorkdir: иначе тест на require() не загрузится вовсе.
const TARGET_PROJECT_RULES = 'Целевой проект — Node.js в режиме ESM (package.json "type": "module"): только import/export, никаких require/module.exports; тесты — на node:test и node:assert/strict.';

/** Один "ход" Agent SDK с узким набором разрешённых к записи путей. */
async function runAgentTurn(prompt: string, cwd: string, allowedWritePaths: string[], abortController: AbortController): Promise<TokenUsage> {
  const systemPrompt = `Ты инженер, реализующий одну изолированную подзадачу в общем репозитории.
Тебе разрешено СОЗДАВАТЬ и РЕДАКТИРОВАТЬ только следующие файлы: ${allowedWritePaths.join(', ')}.
Любые другие файлы в репозитории — только для чтения; попытка записи в них будет отклонена.
Работай только через инструменты для файлов, не проси подтверждения — просто делай.
${TARGET_PROJECT_RULES}`;

  const { usage } = await runAgentQuery('worker turn', prompt, {
    cwd,
    systemPrompt,
    tools: ['Read', 'Write', 'Edit', 'Glob'],
    hooks: { PreToolUse: makeWriteGuardHooks(cwd, allowedWritePaths) },
    canUseTool: makeWriteGuard(cwd, allowedWritePaths),
    maxTurns: 10,
    abortController,
  });
  return usage;
}

function summarizeTestRun(run: TestRun): string {
  return `команда: ${run.cmd}\nexitCode: ${run.exitCode}\ntestsRan: ${run.testsRan}\ntestsFailed: ${run.testsFailed}\nисход: ${run.failureKind}\nвывод:\n${run.output}`;
}

function isValidRed(run: TestRun): boolean {
  return VALID_RED_KINDS.includes(run.failureKind);
}

function redRetryPrompt(task: Task, prev: TestRun): string {
  if (prev.failureKind === 'passed') {
    return `Тест в "${task.testFile}" ПРОШЁЛ, хотя реализации ещё нет — значит, он ничего не проверяет:\n${summarizeTestRun(prev)}\n\nПерепиши тест так, чтобы он падал до реализации и проверял: ${task.testFirst}`;
  }
  return `Предыдущая попытка написать тест в "${task.testFile}" не дала настоящего падения теста (сломан сам тестовый файл или тестов нет):\n${summarizeTestRun(prev)}\n\nИсправь тестовый файл так, чтобы он корректно загружался и содержал реально падающую проверку для: ${task.testFirst}`;
}

/** Точка входа процесса-воркера: один изолированный TDD-цикл на одну задачу. */
export async function runWorker(input: WorkerInput, abortController = new AbortController()): Promise<WorkerResult> {
  const { task, workdir, runDir, maxAttempts } = input;
  const log = makeLogger(`worker:${task.id}`);
  const paths = runDirPaths(runDir);
  let usage = ZERO_USAGE;

  try {
    // Red: пишем падающий тест, пока не получим настоящее падение (проверки или отсутствия реализации).
    let red: TestRun | null = null;
    let redAttempts = 0;
    while (redAttempts < maxAttempts && !(red && isValidRed(red))) {
      redAttempts++;
      const prompt =
        red === null
          ? `Напиши тест в файле "${task.testFile}" (относительно ${workdir}), который проверяет:\n${task.testFirst}\n\nОписание задачи: ${task.description}\nКритерии приёмки:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nТест должен реально импортировать реализацию из ${task.targetFiles.join(', ')} и падать, пока эти файлы не реализованы (модулей ещё не существует). Используй node:test и node:assert/strict.`
          : redRetryPrompt(task, red);

      usage = addUsage(usage, await runAgentTurn(prompt, workdir, [task.testFile], abortController));
      red = runTests(workdir, task.testFile, task.targetFiles);
      log.info(`red attempt ${redAttempts}: exitCode=${red.exitCode} testsRan=${red.testsRan} testsFailed=${red.testsFailed} kind=${red.failureKind}`);
    }

    if (!red) throw new Error('не удалось получить red-прогон');

    // Без настоящего red нет смысла тратить попытки на green: дисциплина уже нарушена.
    let green: TestRun | null = null;
    let greenAttempts = 0;
    if (isValidRed(red)) {
      let lastRun: TestRun = red;
      while (greenAttempts < maxAttempts && green === null) {
        greenAttempts++;
        const prompt =
          greenAttempts === 1
            ? `Реализуй код в файлах ${task.targetFiles.join(', ')} так, чтобы тест "${task.testFile}" прошёл.\n\nТекущий (падающий) прогон теста:\n${summarizeTestRun(lastRun)}\n\nОписание задачи: ${task.description}\nНе изменяй файл "${task.testFile}".`
            : `Тест "${task.testFile}" всё ещё не проходит после предыдущей попытки. Текущий прогон:\n${summarizeTestRun(lastRun)}\n\nИсправь реализацию в ${task.targetFiles.join(', ')}. Не изменяй файл "${task.testFile}".`;

        usage = addUsage(usage, await runAgentTurn(prompt, workdir, task.targetFiles, abortController));
        lastRun = runTests(workdir, task.testFile, task.targetFiles);
        log.info(`green attempt ${greenAttempts}: exitCode=${lastRun.exitCode} testsRan=${lastRun.testsRan} testsFailed=${lastRun.testsFailed}`);

        if (lastRun.failureKind === 'passed') green = lastRun;
      }
    }

    const evidence: Evidence = { taskId: task.id, red, green, attempts: { red: redAttempts, green: greenAttempts } };
    writeFileSync(paths.evidenceFile(task.id), JSON.stringify(evidence, null, 2), 'utf-8');

    if (!isValidRed(red)) {
      return {
        taskId: task.id,
        status: 'no_red',
        changedFiles: [task.testFile],
        summary: `задача ${task.id}: за ${redAttempts} попыток не удалось получить настоящий падающий тест (последний исход: ${red.failureKind})`,
        usage,
      };
    }

    return {
      taskId: task.id,
      status: green ? 'green' : 'red_only',
      // targetFiles могли быть частично записаны и без green — их тоже нужно показать ревью.
      changedFiles: [task.testFile, ...task.targetFiles],
      summary: green
        ? `задача ${task.id}: red за ${redAttempts} попыт., green за ${greenAttempts} попыт.`
        : `задача ${task.id}: тест так и не прошёл после ${greenAttempts} попыток реализации`,
      usage,
    };
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

// Точка входа при запуске как форкнутый процесс.
serveChild<WorkerInput, WorkerResult>(runWorker, (r) => (r.status === 'error' ? 1 : 0));
