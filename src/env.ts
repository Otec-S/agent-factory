import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Подхватывает .env (README предлагает положить туда ANTHROPIC_API_KEY).
 * Уже заданные переменные окружения не перетираются, а пустые значения из файла
 * пропускаются: `ANTHROPIC_API_KEY=` из .env.example иначе "задал" бы пустой ключ
 * и сломал бы авторизацию через вход в Claude Code.
 */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf-8')))) {
    if (value === undefined || value === '' || env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
