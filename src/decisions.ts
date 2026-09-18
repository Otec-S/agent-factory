import { appendFileSync } from 'node:fs';
import type { Decision, DecisionSource } from './types.js';
import { runDirPaths } from './runDir.js';

/** Append-only журнал вердиктов. По строке (JSON) на каждый гейт. */
export class DecisionLog {
  private readonly file: string;

  constructor(runDir: string) {
    this.file = runDirPaths(runDir).decisionsFile;
  }

  record(gate: string, verdict: string, source: DecisionSource, detail?: Record<string, unknown>): void {
    const decision: Decision = {
      at: new Date().toISOString(),
      gate,
      verdict,
      source,
      detail,
    };
    appendFileSync(this.file, JSON.stringify(decision) + '\n', 'utf-8');
  }
}
