import fs from "node:fs";
import { StoryboardSchema, type Storyboard } from "./types.ts";
import { computeDwellSec } from "./timing.ts";

/** Words that suggest a mutating/irreversible action. A recording must never
 * perform these against the live app. This is a coarse but cheap safety net;
 * the real guarantee is the read/navigation-only Action allowlist in types.ts. */
// HARD block: unambiguous commit / irreversible / costly actions. These do not
// collide with feature *names* (a demo about "red-teaming" must be able to say
// "red-team" in a navigation intent without being blocked).
const DESTRUCTIVE = /\b(delete|destroy|erase|\bpay\b|purchase|checkout|submit|\bconfirm\b|save\s+changes)\b/i;
// SOFT warn: launch-ish phrasing. Collides with ordinary English ("the run",
// "launches"), so we surface it at the review gate instead of blocking — the
// demo is meant to STOP before launch (enforced by the generator prompt + the
// human review gate), and this flags anything that looks like it might trigger.
const LAUNCHISH = /(launch|execut|initiat)\w*|\b(start|run|begin|trigger)\s+(the\s+)?(scan|run|eval|audit|red[-\s]?team|pentest)\b/i;

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
      errors.push(`Beat "${b.id}" has a possibly destructive/costly action (commit verb). Blocked.`);
    } else if (LAUNCHISH.test(actionText)) {
      warnings.push(`Beat "${b.id}" has launch-like phrasing — confirm at review it does NOT actually trigger a run.`);
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
