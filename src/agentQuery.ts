import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { TokenUsage } from './types.js';
import { addUsage, ZERO_USAGE } from './usage.js';

export type AgentQueryResult = { structuredOutput: unknown; usage: TokenUsage };

/**
 * Изоляция от окружения пользователя. Без settingSources: [] SDK (с 0.3) загружает
 * ~/.claude/settings.json, .claude/settings*.json и CLAUDE.md: чужие правила allow или
 * defaultMode могли бы одобрить запись в обход гейтов, а CLAUDE.md — попасть в контекст
 * агентов, у которых по замыслу строго узкий вход.
 */
const ISOLATION: Partial<Options> = {
  settingSources: [],
  permissionMode: 'default',
};

/**
 * Единая обёртка над query(): дочитывает поток до result-сообщения, суммирует
 * usage по всем моделям (включая cache-токены) и бросает исключение на любой
 * неуспешный исход — вызывающему не нужно дублировать этот цикл.
 */
export async function runAgentQuery(label: string, prompt: string, options: Options): Promise<AgentQueryResult> {
  let result: AgentQueryResult | null = null;
  for await (const message of query({ prompt, options: { ...ISOLATION, ...options } })) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      const details = message.errors.length > 0 ? `: ${message.errors.join('; ')}` : '';
      throw new Error(`${label}: query завершился с ошибкой ${message.subtype}${details}`);
    }
    // success с is_error — например, ошибка API, пришедшая текстом результата.
    if (message.is_error) {
      throw new Error(`${label}: query вернул ошибку${message.api_error_status ? ` (HTTP ${message.api_error_status})` : ''}: ${message.result}`);
    }
    let usage = ZERO_USAGE;
    for (const m of Object.values(message.modelUsage)) usage = addUsage(usage, m);
    result = { structuredOutput: message.structured_output, usage };
  }
  if (!result) throw new Error(`${label}: query завершился без result-сообщения`);
  return result;
}
