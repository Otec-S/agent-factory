export type Task = {
  id: string; // "task-1", безопасен для имени файла
  title: string;
  description: string;
  testFirst: string; // что именно должно упасть первым
  testFile: string; // путь назначает планировщик, не воркер
  targetFiles: string[];
  acceptanceCriteria: string[]; // вход для линзы acceptance
};

export type TestRun = {
  cmd: string;
  exitCode: number;
  output: string; // stdout+stderr, обрезанный до ~8 КБ
  testsRan: number; // из TAP "# tests N"
  testsFailed: number; // из TAP "# fail N"
  testFileSha256: string; // хэш тестового файла на момент прогона
  at: string; // ISO timestamp
};

export type Evidence = {
  taskId: string;
  red: TestRun;
  green: TestRun | null;
  attempts: number;
};

export type WorkerStatus = 'green' | 'red_only' | 'error' | 'timeout';

export type WorkerResult = {
  taskId: string;
  status: WorkerStatus;
  changedFiles: string[];
  summary: string;
  usage: { inputTokens: number; outputTokens: number };
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
  planner: { inputTokens: number; outputTokens: number };
  workers: Record<string, { inputTokens: number; outputTokens: number }>;
  lenses: Record<string, { inputTokens: number; outputTokens: number }>;
  triage: { inputTokens: number; outputTokens: number };
};
