import type { Evidence, EvidenceValidation } from './types.js';

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
    reasons.push('red: testsRan/testsFailed не подтверждают реальное падение теста (возможна ошибка загрузки модуля)');
  }
  if (green === null) {
    reasons.push('green отсутствует: зелёный прогон никогда не состоялся');
  } else {
    if (green.exitCode !== 0) {
      reasons.push('green.exitCode !== 0: финальный прогон не зелёный');
    }
    if (!(green.testsRan > 0)) {
      reasons.push('green.testsRan === 0: зелёный прогон ничего не выполнил');
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
