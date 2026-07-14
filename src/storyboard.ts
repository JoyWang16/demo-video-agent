import fs from "node:fs";
import { StoryboardSchema, type Storyboard } from "./types.ts";

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

  const estimatedMaxSec = sb.beats.reduce((sum, b) => sum + b.maxDurationSec, 0);
  const { targetLengthSec, tolerancePct, captions } = sb.spec;
  const upper = targetLengthSec * (1 + tolerancePct);

  if (estimatedMaxSec > upper) {
    warnings.push(
      `Worst-case duration ${estimatedMaxSec}s exceeds target ${targetLengthSec}s +${Math.round(
        tolerancePct * 100
      )}% (=${upper.toFixed(1)}s). Trim beats or raise the cap.`
    );
  }

  for (const b of sb.beats) {
    const haystack = [b.caption, ...b.actions.map((a) => JSON.stringify(a))].join(" ");
    if (DESTRUCTIVE.test(haystack)) {
      errors.push(`Beat "${b.id}" contains a possibly destructive action/keyword. Blocked.`);
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
