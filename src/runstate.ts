import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./types.ts";
import { runDir } from "./config.ts";

function statePath(runId: string) {
  return path.join(runDir(runId), "state.json");
}

export function saveState(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(runDir(state.runId), { recursive: true });
  fs.writeFileSync(statePath(state.runId), JSON.stringify(state, null, 2), "utf8");
}

export function loadState(runId: string): RunState {
  const p = statePath(runId);
  if (!fs.existsSync(p)) throw new Error(`No run found: ${runId}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as RunState;
}

export function newRunId(specId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${specId}__${stamp}`;
}
