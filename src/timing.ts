/**
 * Layer-1 auto-timing: derive how long to hold on a beat from the caption's
 * reading time, so dwell no longer has to be hand-tuned per beat.
 *
 * ~15 characters/second is a widely used subtitle reading-speed floor; we add a
 * short settle pad (eye lands on the settled screen) and clamp to sane bounds.
 * A per-beat `dwellSec` in the storyboard overrides this when you want manual
 * control. Layer 2 (later) will refine this from actual frame-to-frame change.
 */
const CHARS_PER_SEC = 15;
const MIN_DWELL_SEC = 2.5;
const MAX_DWELL_SEC = 12;
const SETTLE_PAD_SEC = 1.0;

export function computeDwellSec(caption: string, captionsEnabled: boolean): number {
  const text = (caption ?? "").trim();
  if (!captionsEnabled || !text) return MIN_DWELL_SEC;
  const dwell = text.length / CHARS_PER_SEC + SETTLE_PAD_SEC;
  return Math.min(MAX_DWELL_SEC, Math.max(MIN_DWELL_SEC, dwell));
}
