import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LensFinding, LensName, ReviewFinding, ReviewVerdict } from '../types.js';
import { runDirPaths } from '../runDir.js';
import { LENS_NAMES } from './lenses.js';
import { DecisionLog } from '../decisions.js';
import { makeLogger } from '../logger.js';

const log = makeLogger('triage');

const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;

const ReviewFindingSchema = z.object({
  title: z.string().min(1),
  file: z.string().optional(),
  line: z.number().optional(),
  rationale: z.string().min(1),
  severity: z.enum(SEVERITIES),
  sources: z.array(z.enum(LENS_NAMES as [LensName, ...LensName[]])).min(1),
});
const ReviewVerdictSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  summary: z.string().min(1),
});

const REVIEW_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'rationale', 'severity', 'sources'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          rationale: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          sources: { type: 'array', items: { type: 'string', enum: [...LENS_NAMES] } },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `Ты triage-агент финальной стадии ревью.
На вход ты получаешь находки нескольких независимых линз (без severity и без вердикта) и diff.
Твоя работа по порядку:
1. Нормализуй и дедуплицируй находки, которые разные линзы описали как одну и ту же проблему — объедини их sources.
2. Проверь достижимость: используй Read/Glob по рабочей директории, чтобы убедиться, что описанная проблема реальна в текущем коде, а не выдумана линзой. Отсеивай недостижимые/ложные находки.
3. Классифицируй оставшиеся находки и присвой severity: critical (ломает функциональность/данные), major (существенный дефект), minor (стоит исправить), nit (стилистика).
4. Собери итоговый вердикт с кратким summary для человека.

Верни только структурированный JSON по схеме.`;

function readLensFindings(runDir: string): Record<LensName, LensFinding[]> {
  const paths = runDirPaths(runDir);
  const result = {} as Record<LensName, LensFinding[]>;
  for (const name of LENS_NAMES) {
    try {
      result[name] = JSON.parse(readFileSync(paths.lensFile(name), 'utf-8')) as LensFinding[];
    } catch {
      result[name] = [];
    }
  }
  return result;
}

function renderBriefMd(verdict: ReviewVerdict): string {
  const bySeverity = (sev: (typeof SEVERITIES)[number]) => verdict.findings.filter((f) => f.severity === sev);
  const lines = [`# Review brief`, '', verdict.summary, ''];
  for (const sev of SEVERITIES) {
    const findings = bySeverity(sev);
    if (findings.length === 0) continue;
    lines.push(`## ${sev} (${findings.length})`, '');
    for (const f of findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      lines.push(`- **${f.title}**${loc} — ${f.rationale} _[источники: ${f.sources.join(', ')}]_`);
    }
    lines.push('');
  }
  if (verdict.findings.length === 0) {
    lines.push('Находок нет.');
  }
  return lines.join('\n');
}

/**
 * Один вызов модели с read-доступом к исходникам в workdir — без исходников
 * triage не может проверить достижимость находок и выродится в переписывание
 * находок линз без добавленной ценности.
 */
export type TriageResult = { verdict: ReviewVerdict; usage: { inputTokens: number; outputTokens: number } };

export async function triage(workdir: string, runDir: string): Promise<TriageResult> {
  const paths = runDirPaths(runDir);
  const decisions = new DecisionLog(runDir);

  const diff = readFileSync(paths.diffPatch, 'utf-8');
  const lensFindings = readLensFindings(runDir);
  const findingsBlock = LENS_NAMES.map((name) => `### Линза "${name}"\n${JSON.stringify(lensFindings[name], null, 2)}`).join('\n\n');

  const prompt = `Diff:\n${diff}\n\nНаходки линз:\n${findingsBlock}`;

  const q = query({
    prompt,
    options: {
      cwd: workdir,
      systemPrompt: SYSTEM_PROMPT,
      tools: ['Read', 'Glob'],
      allowedTools: ['Read', 'Glob'],
      maxTurns: 40,
      outputFormat: { type: 'json_schema', schema: REVIEW_VERDICT_JSON_SCHEMA },
    },
  });

  let raw: unknown;
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        throw new Error(`triage query завершился с ошибкой: ${message.subtype}`);
      }
      raw = message.structured_output;
      for (const m of Object.values(message.modelUsage)) {
        usage = { inputTokens: usage.inputTokens + m.inputTokens, outputTokens: usage.outputTokens + m.outputTokens };
      }
    }
  }

  const parsed = ReviewVerdictSchema.safeParse(raw);
  const verdict: ReviewVerdict = parsed.success
    ? parsed.data
    : { findings: [], summary: `triage вернул невалидный вывод: ${parsed.success ? '' : parsed.error.message}` };

  if (!parsed.success) {
    log.warn(`невалидный вывод triage: ${parsed.error.message}`);
  }

  writeFileSync(paths.reviewFinal, JSON.stringify(verdict, null, 2), 'utf-8');
  writeFileSync(paths.reviewBrief, renderBriefMd(verdict), 'utf-8');
  decisions.record('review.triage', parsed.success ? 'ok' : 'invalid-output', 'llm', { findingsCount: verdict.findings.length });

  return { verdict, usage };
}
