import { runAgentQuery } from './agentQuery.js';
import { makeWriteGuard, makeWriteGuardHooks } from './writeGuard.js';
import type { TestRun, TokenUsage } from './types.js';

// Должно совпадать с тем, что создаёт bootstrapWorkdir: иначе тест на require() не загрузится вовсе.
const TARGET_PROJECT_RULES = 'Целевой проект — Node.js в режиме ESM (package.json "type": "module"): только import/export, никаких require/module.exports; тесты — на node:test и node:assert/strict.';

/** Один "ход" Agent SDK с узким набором разрешённых к записи путей. Общий для воркера и fix-up. */
export async function runAgentTurn(prompt: string, cwd: string, allowedWritePaths: string[], abortController: AbortController): Promise<TokenUsage> {
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

export function summarizeTestRun(run: TestRun): string {
  return `команда: ${run.cmd}\nexitCode: ${run.exitCode}\ntestsRan: ${run.testsRan}\ntestsFailed: ${run.testsFailed}\nисход: ${run.failureKind}\nвывод:\n${run.output}`;
}
