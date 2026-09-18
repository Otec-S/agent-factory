import { runTests } from './testRunner.js';
import { makeLogger } from './logger.js';
import { serveChild } from './childProcess.js';
import { runAgentTurn, summarizeTestRun } from './agentTurn.js';
import { addUsage, ZERO_USAGE } from './usage.js';
import type { FixupResult, ReviewFinding, Task, TestRun } from './types.js';

export type FixupWorkerInput = {
  task: Task;
  findings: ReviewFinding[];
  workdir: string;
  maxAttempts: number;
  baseline: TestRun; // зелёный прогон теста задачи до fix-up — его делает оркестратор
};

function renderFindings(findings: ReviewFinding[]): string {
  return findings
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      return `- [${f.severity}] ${f.title}${loc}\n  ${f.rationale}`;
    })
    .join('\n');
}

/**
 * Точка входа процесса fix-up: одна задача, только её блокирующие находки.
 * Пишет только в targetFiles; тест задачи — read-only и служит гейтом регрессии:
 * правка засчитывается, только если тест остался зелёным. Откат несохранённой
 * правки делает оркестратор — здесь только попытки и честный статус.
 */
export async function runFixupWorker(input: FixupWorkerInput, abortController = new AbortController()): Promise<FixupResult> {
  const { task, findings, workdir, maxAttempts, baseline } = input;
  const log = makeLogger(`fixup:${task.id}`);
  let usage = ZERO_USAGE;
  let attempts = 0;
  let lastRun: TestRun = baseline;

  try {
    while (attempts < maxAttempts) {
      attempts++;
      const prompt =
        attempts === 1
          ? `Ревью нашло в реализации задачи "${task.title}" блокирующие проблемы:\n${renderFindings(findings)}\n\nИсправь их в файлах ${task.targetFiles.join(', ')}. Сначала прочитай код и убедись, что проблема реальна; не переписывай то, что работает.\nОписание задачи: ${task.description}\nКритерии приёмки:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nТест "${task.testFile}" сейчас проходит и должен проходить после правки. Не изменяй его.`
          : `После правки тест "${task.testFile}" перестал проходить — правка сломала уже работавшее поведение:\n${summarizeTestRun(lastRun)}\n\nИсправь ${task.targetFiles.join(', ')} так, чтобы и находки ревью были устранены, и тест снова проходил. Не изменяй "${task.testFile}".`;

      usage = addUsage(usage, await runAgentTurn(prompt, workdir, task.targetFiles, abortController));
      lastRun = runTests(workdir, task.testFile, task.targetFiles);
      log.info(`fix-up attempt ${attempts}: exitCode=${lastRun.exitCode} kind=${lastRun.failureKind}`);

      if (lastRun.failureKind === 'passed') {
        return {
          taskId: task.id,
          status: 'applied',
          findingsCount: findings.length,
          attempts,
          summary: `задача ${task.id}: правка по ${findings.length} находк. применена за ${attempts} попыт., тест зелёный`,
          usage,
          finalRun: lastRun,
        };
      }
    }

    return {
      taskId: task.id,
      status: 'reverted',
      findingsCount: findings.length,
      attempts,
      summary: `задача ${task.id}: за ${attempts} попыток тест так и не стал снова зелёным — правка откатывается`,
      usage,
      finalRun: lastRun,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    return { taskId: task.id, status: 'error', findingsCount: findings.length, attempts, summary: `задача ${task.id}: ошибка fix-up`, usage, error: message };
  }
}

serveChild<FixupWorkerInput, FixupResult>(runFixupWorker, (r) => (r.status === 'error' ? 1 : 0));
