import fs from "node:fs";
import { StoryboardSchema, type Storyboard } from "./types.ts";
import { computeDwellSec } from "./timing.ts";

/** Words that suggest a mutating/irreversible action. A recording must never
 * perform these against the live app. This is a coarse but cheap safety net;
 * the real guarantee is the read/navigation-only Action allowlist in types.ts. */
const DESTRUCTIVE = /\b(delete|remove|destroy|drop|run\s+scan|create\s+(scan|audit|project)|pentest|red[-\s]?team|pay|purchase|submit|confirm|approve|save\s+changes)\b/i;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimatedMaxSec: number;
}

export function loadStoryboard(file: string): Storyboard {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return StoryboardSchema.parse(raw); // throws with a readable zod error if malformed
}

/**
 * Validate a storyboard *before* spending a recording:
 *  - total worst-case duration fits the target length (within tolerance)
 *  - no beat action looks destructive
 *  - captions present iff the spec asks for them
 */
export function validateStoryboard(sb: Storyboard): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Realistic estimate: explicit inter-action waits + a nominal per-action cost
  // + the (computed or overridden) dwell where the caption is shown.
  const estimatedMaxSec = sb.beats.reduce((sum, b) => {
    const explicitWaits = b.actions.reduce((s, a) => s + (a.type === "waitMs" ? a.ms / 1000 : 0), 0);
    const nominalActions = b.actions.filter((a) => a.type !== "waitMs").length * 1.0;
    const dwell = b.dwellSec ?? computeDwellSec(b.caption, sb.spec.captions);
    return sum + explicitWaits + nominalActions + dwell;
  }, 0);
  const { targetLengthSec, tolerancePct, captions } = sb.spec;
  const upper = targetLengthSec * (1 + tolerancePct);

  if (estimatedMaxSec > upper) {
    warnings.push(
      `Estimated duration ~${estimatedMaxSec.toFixed(0)}s exceeds target ${targetLengthSec}s +${Math.round(
        tolerancePct * 100
      )}% (=${upper.toFixed(1)}s). Trim beats or shorten captions.`
    );
  }
  if (estimatedMaxSec < targetLengthSec * (1 - tolerancePct)) {
    warnings.push(
      `Estimated duration ~${estimatedMaxSec.toFixed(0)}s is under target ${targetLengthSec}s -${Math.round(
        tolerancePct * 100
      )}%. Add beats/steps or set a lower targetLengthSec.`
    );
  }

  for (const b of sb.beats) {
    // Only ACTIONS can be destructive. A caption may legitimately describe a
    // feature by name (e.g. "red-teaming") without performing it.
    const actionText = b.actions.map((a) => JSON.stringify(a)).join(" ");
    if (DESTRUCTIVE.test(actionText)) {
      errors.push(`Beat "${b.id}" has a possibly destructive/costly action. Blocked.`);
    }
    if (captions && !b.caption.trim()) {
      warnings.push(`Beat "${b.id}" has no caption but spec.captions=true.`);
    }
    if (!captions && b.caption.trim()) {
      warnings.push(`Beat "${b.id}" has a caption but spec.captions=false (it will be ignored).`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, estimatedMaxSec };
}
