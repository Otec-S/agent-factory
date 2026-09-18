import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { FactoryState, Phase } from './types.js';
import { runDirPaths } from './runDir.js';

/**
 * Единственный писатель state.local.json.
 * Никакой другой модуль не должен писать в этот файл напрямую —
 * это исключает гонки и рассинхронизацию формата.
 */
export class StateStore {
  private readonly stateFile: string;
  private state: FactoryState;

  private constructor(stateFile: string, state: FactoryState) {
    this.stateFile = stateFile;
    this.state = state;
  }

  static init(runDir: string, opts: { parallel: boolean; fixup: boolean; workdir: string; taskDescription: string; baseTree: string }): StateStore {
    const { stateFile } = runDirPaths(runDir);
    const state: FactoryState = {
      phase: 'init',
      stage: 'cli.bootstrap',
      updatedAt: new Date().toISOString(),
      taskCount: 0,
      implMode: 'subagent-per-task',
      parallel: opts.parallel,
      fixup: opts.fixup,
      workdir: opts.workdir,
      taskDescription: opts.taskDescription,
      baseTree: opts.baseTree,
      completedStages: [],
    };
    const store = new StateStore(stateFile, state);
    store.persist();
    return store;
  }

  static load(runDir: string): StateStore {
    const { stateFile } = runDirPaths(runDir);
    if (!existsSync(stateFile)) {
      throw new Error(`state.local.json not found at ${stateFile} — run was not initialized`);
    }
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as FactoryState;
    if (!state.baseTree) {
      throw new Error(`в ${stateFile} нет baseTree — ран создан старой версией, возобновить его нельзя`);
    }
    // Раны, созданные до появления fix-up раунда: поведение по умолчанию — раунд включён.
    return new StateStore(stateFile, { ...state, fixup: state.fixup ?? true });
  }

  get(): Readonly<FactoryState> {
    return this.state;
  }

  transition(phase: Phase, stage: string, patch: Partial<FactoryState> = {}): void {
    this.state = {
      ...this.state,
      ...patch,
      phase,
      stage,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  /** Помечает стадию завершённой — по этому списку resume пропускает уже сделанную работу. */
  markStageDone(phase: Phase): void {
    if (this.state.completedStages.includes(phase)) return;
    this.state = {
      ...this.state,
      completedStages: [...this.state.completedStages, phase],
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  isStageDone(phase: Phase): boolean {
    return this.state.completedStages.includes(phase);
  }

  private persist(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}
