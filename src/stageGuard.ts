import type { FactoryState, Phase } from './types.js';

const ORDER: Phase[] = [
  'init',
  'planning',
  'implementation',
  'validation',
  'diff',
  'review',
  'triage',
  'report',
  'done',
];

export type GuardResult = { allow: true } | { allow: false; reason: string };

/**
 * Чистая функция, вызывается перед каждой стадией.
 * Не даёт прыгнуть, например, из planning сразу в review.
 */
export function canRun(targetPhase: Phase, state: Readonly<FactoryState>): GuardResult {
  const currentIdx = ORDER.indexOf(state.phase);
  const targetIdx = ORDER.indexOf(targetPhase);

  if (targetIdx === -1) {
    return { allow: false, reason: `неизвестная стадия "${targetPhase}"` };
  }
  if (currentIdx === -1) {
    return { allow: false, reason: `текущее состояние "${state.phase}" повреждено` };
  }
  if (targetIdx < currentIdx) {
    return {
      allow: false,
      reason: `ран уже прошёл стадию "${targetPhase}" (сейчас на "${state.phase}") — повторный запуск назад запрещён`,
    };
  }
  if (targetIdx > currentIdx + 1) {
    return {
      allow: false,
      reason: `нельзя перейти из "${state.phase}" сразу в "${targetPhase}" — пропущены промежуточные стадии`,
    };
  }
  return { allow: true };
}
