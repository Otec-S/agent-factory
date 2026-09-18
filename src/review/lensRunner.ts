import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LensFinding, LensName, Task } from '../types.js';
import { runDirPaths } from '../runDir.js';
import { buildLensPrompt, FINDINGS_JSON_SCHEMA } from './lenses.js';
import { makeLogger } from '../logger.js';

const FindingSchema = z.object({
  title: z.string().min(1),
  file: z.string().optional(),
  line: z.number().optional(),
  rationale: z.string().min(1),
});
const FindingsSchema = z.object({ findings: z.array(FindingSchema) });

export type LensRunnerInput = {
  lens: LensName;
  workdir: string;
  runDir: string;
  tasks: Task[];
};

export type LensRunnerResult = {
  lens: LensName;
  ok: boolean;
  findingsCount: number;
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
};

/**
 * Точка входа процесса линзы. Read-only: линза не пишет ничего, кроме своего
 * файла находок в run_dir. Оркестратору возвращается только путь/счётчик,
 * не сами находки — контекст оркестратора остаётся чистым.
 */
export async function runLens(input: LensRunnerInput): Promise<LensRunnerResult> {
  const { lens, workdir, runDir, tasks } = input;
  const log = makeLogger(`lens:${lens}`);
  const paths = runDirPaths(runDir);

  try {
    const { systemPrompt, prompt } = buildLensPrompt(lens, runDir, workdir, tasks);

    const q = query({
      prompt,
      options: {
        systemPrompt,
        tools: [],
        maxTurns: 4,
        outputFormat: { type: 'json_schema', schema: FINDINGS_JSON_SCHEMA },
      },
    });

    let raw: unknown;
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`lens query завершился с ошибкой: ${message.subtype}`);
        }
        raw = message.structured_output;
        for (const m of Object.values(message.modelUsage)) {
          usage = { inputTokens: usage.inputTokens + m.inputTokens, outputTokens: usage.outputTokens + m.outputTokens };
        }
      }
    }

    const parsed = FindingsSchema.safeParse(raw);
    const findings: LensFinding[] = parsed.success ? parsed.data.findings : [];
    if (!parsed.success) {
      log.warn(`невалидный вывод модели, считаю находки пустыми: ${parsed.error.message}`);
    }

    writeFileSync(paths.lensFile(lens), JSON.stringify(findings, null, 2), 'utf-8');
    log.info(`найдено ${findings.length} находок`);

    return { lens, ok: true, findingsCount: findings.length, usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    writeFileSync(paths.lensFile(lens), JSON.stringify([], null, 2), 'utf-8');
    return { lens, ok: false, findingsCount: 0, usage: { inputTokens: 0, outputTokens: 0 }, error: message };
  }
}

if (typeof process.send === 'function') {
  process.once('message', async (input: LensRunnerInput) => {
    const result = await runLens(input);
    process.send!(result);
    process.exit(result.ok ? 0 : 1);
  });
}
