import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { LensFinding, LensName, ReviewFinding, ReviewVerdict, TokenUsage } from '../types.js';
import { runDirPaths } from '../runDir.js';
import { LENS_NAMES } from './lenses.js';
import { DecisionLog } from '../decisions.js';
import { makeLogger } from '../logger.js';
import { runAgentQuery } from '../agentQuery.js';

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
// Внешняя оболочка разбирается отдельно от находок: одна битая находка не должна обнулять весь вердикт.
const VerdictEnvelopeSchema = z.object({
  findings: z.array(z.unknown()),
  summary: z.string().min(1),
});

const REVIEW_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'rationale', 'severity', 'sources'],
        properties: {
          title: { type: 'string', minLength: 1 },
          file: { type: 'string' },
          line: { type: 'number' },
          rationale: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: [...SEVERITIES] },
          // держим синхронно с ReviewFindingSchema: без minItems модель может вернуть [], и находка отбросится
          sources: { type: 'array', minItems: 1, items: { type: 'string', enum: [...LENS_NAMES] } },
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

export type ParsedVerdict = { verdict: ReviewVerdict; valid: boolean; droppedFindings: number };

/**
 * Разбирает вывод triage. Если сломана вся оболочка — вердикт пустой с пометкой в summary;
 * если сломаны отдельные находки — отбрасываются только они (с подсчётом), остальные сохраняются.
 */
export function parseVerdict(raw: unknown): ParsedVerdict {
  const envelope = VerdictEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { verdict: { findings: [], summary: `triage вернул невалидный вывод: ${envelope.error.message}` }, valid: false, droppedFindings: 0 };
  }
  const findings: ReviewFinding[] = [];
  let droppedFindings = 0;
  for (const f of envelope.data.findings) {
    const parsed = ReviewFindingSchema.safeParse(f);
    if (parsed.success) findings.push(parsed.data);
    else droppedFindings++;
  }
  return { verdict: { findings, summary: envelope.data.summary }, valid: droppedFindings === 0, droppedFindings };
}

function renderBriefMd(verdict: ReviewVerdict, failedLenses: LensName[], droppedFindings: number): string {
  const bySeverity = (sev: (typeof SEVERITIES)[number]) => verdict.findings.filter((f) => f.severity === sev);
  const lines = [`# Review brief`, '', verdict.summary, ''];
  if (failedLenses.length > 0) {
    lines.push(`> ⚠ Линзы не отработали: ${failedLenses.join(', ')} — ревью неполное.`, '');
  }
  if (droppedFindings > 0) {
    lines.push(`> ⚠ Отброшено невалидных находок triage: ${droppedFindings}.`, '');
  }
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

export type TriageResult = { verdict: ReviewVerdict; usage: TokenUsage };

/**
 * Один вызов модели с read-доступом к исходникам в workdir — без исходников
 * triage не может проверить достижимость находок и выродится в переписывание
 * находок линз без добавленной ценности.
 */
export async function triage(workdir: string, runDir: string, failedLenses: LensName[]): Promise<TriageResult> {
  const paths = runDirPaths(runDir);
  const decisions = new DecisionLog(runDir);

  const diff = readFileSync(paths.diffPatch, 'utf-8');
  const lensFindings = readLensFindings(runDir);
  const findingsBlock = LENS_NAMES.map((name) =>
    failedLenses.includes(name)
      ? `### Линза "${name}"\n(линза не отработала — её находок нет, это НЕ значит, что проблем нет)`
      : `### Линза "${name}"\n${JSON.stringify(lensFindings[name], null, 2)}`,
  ).join('\n\n');

  const prompt = `Diff:\n${diff}\n\nНаходки линз:\n${findingsBlock}`;

  const { structuredOutput, usage } = await runAgentQuery('triage', prompt, {
    cwd: workdir,
    systemPrompt: SYSTEM_PROMPT,
    tools: ['Read', 'Glob'],
    allowedTools: ['Read', 'Glob'],
    maxTurns: 40,
    outputFormat: { type: 'json_schema', schema: REVIEW_VERDICT_JSON_SCHEMA },
  });

  const { verdict, valid, droppedFindings } = parseVerdict(structuredOutput);
  if (!valid) log.warn(`невалидный вывод triage (отброшено находок: ${droppedFindings})`);

  writeFileSync(paths.reviewFinal, JSON.stringify(verdict, null, 2), 'utf-8');
  writeFileSync(paths.reviewBrief, renderBriefMd(verdict, failedLenses, droppedFindings), 'utf-8');
  decisions.record('review.triage', valid ? 'ok' : 'invalid-output', 'llm', { findingsCount: verdict.findings.length, droppedFindings, failedLenses });

  return { verdict, usage };
}
