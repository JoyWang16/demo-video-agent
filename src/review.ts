import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./types.ts";
import { runDir } from "./config.ts";

/**
 * The review gate lives in orchestration, not in the recorder. After raw clips
 * land, the run pauses at status=pending_review. A human inspects the clips and
 * records a decision per clip. In v0 that decision is a JSON file (and/or CLI
 * flags); in the Convex/TanStack version it becomes a row + a review screen.
 */

interface ReviewEntry {
  beatId: string;
  caption: string;
  clip: string; // path to the raw clip to watch
  approved: boolean | null; // set true/false; null = undecided
  rejectionReason?: string;
}

function reviewPath(runId: string) {
  return path.join(runDir(runId), "review.json");
}

export function writeReviewFile(state: RunState): string {
  const entries: ReviewEntry[] = state.clips.map((c) => ({
    beatId: c.beatId,
    caption: c.caption,
    clip: path.relative(process.cwd(), c.rawPath),
    approved: c.approved,
    rejectionReason: c.rejectionReason,
  }));
  const p = reviewPath(state.runId);
  fs.writeFileSync(p, JSON.stringify(entries, null, 2), "utf8");
  return p;
}

/** Merge decisions from the review file (if edited) and/or explicit flags. */
export function applyDecisions(
  state: RunState,
  opts: { approveAll?: boolean; approve?: string[]; reject?: string[] }
): RunState {
  const p = reviewPath(state.runId);
  if (fs.existsSync(p)) {
    const entries = JSON.parse(fs.readFileSync(p, "utf8")) as ReviewEntry[];
    const byId = new Map(entries.map((e) => [e.beatId, e]));
    for (const c of state.clips) {
      const e = byId.get(c.beatId);
      if (e && e.approved !== null) {
        c.approved = e.approved;
        c.rejectionReason = e.rejectionReason;
      }
    }
  }
  if (opts.approveAll) for (const c of state.clips) c.approved = true;
  for (const id of opts.approve ?? []) {
    const c = state.clips.find((x) => x.beatId === id);
    if (c) c.approved = true;
  }
  for (const id of opts.reject ?? []) {
    const c = state.clips.find((x) => x.beatId === id);
    if (c) c.approved = false;
  }
  return state;
}

export function reviewSummary(state: RunState): {
  approved: string[];
  rejected: string[];
  undecided: string[];
} {
  return {
    approved: state.clips.filter((c) => c.approved === true).map((c) => c.beatId),
    rejected: state.clips.filter((c) => c.approved === false).map((c) => c.beatId),
    undecided: state.clips.filter((c) => c.approved === null).map((c) => c.beatId),
  };
}
