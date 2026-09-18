import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { LensFinding, LensName, Task, TokenUsage } from '../types.js';
import { reviewPaths } from '../runDir.js';
import { buildLensPrompt, FINDINGS_JSON_SCHEMA } from './lenses.js';
import { makeLogger } from '../logger.js';
import { runAgentQuery } from '../agentQuery.js';
import { serveChild } from '../childProcess.js';
import { ZERO_USAGE } from '../usage.js';

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
  round: number;
};

export type LensRunnerResult = {
  lens: LensName;
  ok: boolean;
  findingsCount: number;
  usage: TokenUsage;
  error?: string;
};

/**
 * Точка входа процесса линзы. Read-only: линза не пишет ничего, кроме своего
 * файла находок в run_dir. Оркестратору возвращается только путь/счётчик,
 * не сами находки — контекст оркестратора остаётся чистым.
 */
export async function runLens(input: LensRunnerInput, abortController = new AbortController()): Promise<LensRunnerResult> {
  const { lens, workdir, runDir, tasks, round } = input;
  const log = makeLogger(`lens:${lens}`);
  const paths = reviewPaths(runDir, round);
  let usage = ZERO_USAGE;

  try {
    const { systemPrompt, prompt } = buildLensPrompt(lens, runDir, workdir, tasks, round);

    const result = await runAgentQuery(`lens ${lens}`, prompt, {
      systemPrompt,
      tools: [],
      maxTurns: 4,
      outputFormat: { type: 'json_schema', schema: FINDINGS_JSON_SCHEMA },
      abortController,
    });
    usage = result.usage;

    // Невалидный вывод — это сбой линзы, а не "замечаний нет": иначе отчёт выглядел бы чистым.
    const parsed = FindingsSchema.safeParse(result.structuredOutput);
    if (!parsed.success) throw new Error(`невалидный вывод модели: ${parsed.error.message}`);

    const findings: LensFinding[] = parsed.data.findings;
    writeFileSync(paths.lensFile(lens), JSON.stringify(findings, null, 2), 'utf-8');
    log.info(`найдено ${findings.length} находок`);

    return { lens, ok: true, findingsCount: findings.length, usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    writeFileSync(paths.lensFile(lens), JSON.stringify([], null, 2), 'utf-8');
    return { lens, ok: false, findingsCount: 0, usage, error: message };
  }
}

serveChild<LensRunnerInput, LensRunnerResult>(runLens, (r) => (r.ok ? 0 : 1));
