import type { Evidence, EvidenceValidation, FailureKind } from './types.js';

/** Какие исходы red-прогона считаются настоящим падающим тестом, а не сломанным файлом. */
export const VALID_RED_KINDS: readonly FailureKind[] = ['assertion', 'missing-target'];

/**
 * Чистая функция, без вызовов модели.
 * "TDD enforced by structure, not inferred from diffs" — задача считается прошедшей
 * дисциплину, только если выполнены ВСЕ проверки ниже.
 */
export function validateEvidence(evidence: Evidence): EvidenceValidation {
  const reasons: string[] = [];
  const { red, green } = evidence;

  if (red.exitCode === 0) {
    reasons.push('red.exitCode === 0: красный прогон не был красным');
  }
  if (!(red.testsRan > 0 && red.testsFailed > 0)) {
    reasons.push('red: testsRan/testsFailed не подтверждают падение теста');
  }
  if (!VALID_RED_KINDS.includes(red.failureKind)) {
    reasons.push(`red.failureKind === "${red.failureKind}": тест упал не на проверке и не из-за отсутствия реализации (сломан сам тестовый файл)`);
  }
  if (green === null) {
    reasons.push('green отсутствует: зелёный прогон никогда не состоялся');
  } else {
    if (green.exitCode !== 0) {
      reasons.push('green.exitCode !== 0: финальный прогон не зелёный');
    }
    if (!(green.testsRan > 0) || green.failureKind === 'no-tests') {
      reasons.push('green: зелёный прогон не выполнил ни одного настоящего теста');
    }
    if (red.testFileSha256 !== green.testFileSha256) {
      reasons.push('testFileSha256 red !== green: тестовый файл был изменён между red и green (тест мог быть ослаблен)');
    }
    if (!(Date.parse(red.at) < Date.parse(green.at))) {
      reasons.push('red.at не раньше green.at: нарушен порядок red -> green');
    }
  }

  return { taskId: evidence.taskId, valid: reasons.length === 0, reasons };
}
