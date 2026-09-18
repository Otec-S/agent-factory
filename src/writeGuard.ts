import type { CanUseTool, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { isAllowedWritePath } from './pathSafety.js';

const WRITE_TOOLS = new Set(['Write', 'Edit']);

export type WriteDecision = { allow: true } | { allow: false; reason: string };

/**
 * Детерминированный гейт на запись: Write/Edit разрешены только в перечисленные файлы.
 * Промпт лишь объясняет правило модели, а соблюдение обеспечивает эта функция.
 */
export function decideWrite(cwd: string, allowedWritePaths: string[], toolName: string, input: unknown): WriteDecision {
  if (!WRITE_TOOLS.has(toolName)) {
    return { allow: false, reason: `инструмент ${toolName} недоступен воркеру` };
  }
  const rawPath = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).file_path : undefined;
  const filePath = typeof rawPath === 'string' ? rawPath : '';
  if (!isAllowedWritePath(cwd, allowedWritePaths, filePath)) {
    return { allow: false, reason: `запись в "${filePath}" запрещена: в этой фазе разрешены только ${allowedWritePaths.join(', ')}` };
  }
  return { allow: true };
}

/**
 * Слой 1 — PreToolUse-хук. Хук вызывается на каждый вызов инструмента независимо от
 * режима прав и правил allow, поэтому запрет здесь нельзя обойти настройками.
 * Разрешённую запись хук не одобряет сам, а передаёт дальше — в canUseTool.
 */
export function makeWriteGuardHooks(cwd: string, allowedWritePaths: string[]): HookCallbackMatcher[] {
  return [
    {
      matcher: 'Write|Edit',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const decision = decideWrite(cwd, allowedWritePaths, input.tool_name, input.tool_input);
          if (decision.allow) return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: decision.reason,
            },
          };
        },
      ],
    },
  ];
}

/**
 * Слой 2 — canUseTool: вызывается для инструментов, не одобренных заранее.
 * Поэтому Write/Edit намеренно НЕ входят в allowedTools.
 */
export function makeWriteGuard(cwd: string, allowedWritePaths: string[]): CanUseTool {
  return async (toolName, input) => {
    const decision = decideWrite(cwd, allowedWritePaths, toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
  };
}
