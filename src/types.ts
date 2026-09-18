export type Task = {
  id: string; // "task-1", безопасен для имени файла
  title: string;
  description: string;
  testFirst: string; // что именно должно упасть первым
  testFile: string; // путь назначает планировщик, не воркер
  targetFiles: string[];
  acceptanceCriteria: string[]; // вход для линзы acceptance
};

/**
 * Почему прогон закончился так, как закончился. Нужна, чтобы отличить
 * настоящий red (упала проверка / ещё нет модуля реализации) от сломанного
 * тестового файла: node --test в обоих случаях пишет "# tests 1 / # fail 1".
 */
export type FailureKind =
  | 'passed' // exitCode 0, тесты выполнились
  | 'assertion' // хотя бы один тест реально упал
  | 'missing-target' // тест не загрузился, потому что ещё нет модуля/экспорта из targetFiles
  | 'load-error' // тестовый файл сам не загружается (синтаксис, чужой импорт, нет файла)
  | 'no-tests'; // прогон ничего не выполнил

export type TestRun = {
  cmd: string;
  exitCode: number;
  output: string; // stdout+stderr, обрезанный до ~8 КБ
  testsRan: number; // из TAP "# tests N"
  testsFailed: number; // из TAP "# fail N"
  failureKind: FailureKind;
  testFileSha256: string; // хэш тестового файла на момент прогона; '' если файла нет
  at: string; // ISO timestamp
};

export type Evidence = {
  taskId: string;
  red: TestRun;
  green: TestRun | null;
  attempts: { red: number; green: number }; // фактически потраченные попытки по фазам
};

// no_red: за maxAttempts так и не получилось валидного падающего теста, green не запускался.
export type WorkerStatus = 'green' | 'red_only' | 'no_red' | 'error' | 'timeout';

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type WorkerResult = {
  taskId: string;
  status: WorkerStatus;
  changedFiles: string[];
  summary: string;
  usage: TokenUsage;
  error?: string;
};

export type LensFinding = {
  // severity не выставляется линзой — это работа triage
  title: string;
  file?: string;
  line?: number;
  rationale: string;
};

export type LensName = 'blind' | 'acceptance' | 'standards';

export type ReviewFinding = LensFinding & {
  severity: 'critical' | 'major' | 'minor' | 'nit';
  sources: LensName[];
};

export type ReviewVerdict = {
  findings: ReviewFinding[];
  summary: string;
};

export type EvidenceValidation = {
  taskId: string;
  valid: boolean;
  reasons: string[]; // причины провала, пустой массив если valid
};

export type Phase =
  | 'init'
  | 'planning'
  | 'implementation'
  | 'validation'
  | 'diff'
  | 'review'
  | 'triage'
  | 'report'
  | 'done';

export type FactoryState = {
  phase: Phase;
  stage: string;
  updatedAt: string;
  taskCount: number;
  implMode: 'subagent-per-task';
  parallel: boolean;
  workdir: string;
  taskDescription: string;
  // git-дерево workdir на момент bootstrap: diff считается от него, а не от HEAD/индекса
  baseTree: string;
  completedStages: Phase[];
};

export type DecisionSource = 'deterministic' | 'llm' | 'route';

export type Decision = {
  at: string;
  gate: string;
  verdict: string;
  source: DecisionSource;
  detail?: Record<string, unknown>;
};

export type Usage = {
  planner: TokenUsage;
  workers: Record<string, TokenUsage>;
  lenses: Record<string, TokenUsage>;
  triage: TokenUsage;
};
