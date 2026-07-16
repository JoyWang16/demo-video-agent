import fs from "node:fs";
import { chromium } from "playwright";
import type { Storyboard } from "./types.ts";
import { PROFILE_DIR, neoMcp } from "./config.ts";
import { exploreInventory } from "./comprehension/explore.ts";

const SIGN_IN_RE = /sign-in|login\.microsoftonline|\/login/i;

/** Selectors the flow explicitly waits on are the natural "must exist" anchors. */
function deriveWaypoints(sb: Storyboard): string[] {
  if (sb.waypoints?.length) return sb.waypoints;
  const wps: string[] = [];
  for (const b of sb.beats) {
    for (const a of b.actions) {
      if (a.type === "waitForSelector") wps.push(a.selector);
    }
  }
  return wps;
}

/**
 * Run BEFORE recording. Two layers, matching the two ways Neo can drift:
 *   1) CONTENT — refresh the Neo MCP inventory (what projects/evals exist).
 *      Cheap, read-only, no cost. Skipped if NEO_MCP_URL isn't set.
 *   2) STRUCTURE — open the app in the persistent profile and verify we're
 *      authenticated and the first-screen waypoint still exists. If the UI has
 *      shifted enough that the entry point is gone, fail fast with a clear
 *      message instead of filming a broken take.
 *
 * Deeper mid-flow UI drift is still caught per-action during recording (each
 * failed action is logged) and by the eval gate afterwards. The durable fix for
 * that layer is act()-based beats (next phase); this gate is the cheap detector.
 */
export async function preflight(sb: Storyboard): Promise<void> {
  // 1) content freshness
  if (neoMcp.url) {
    try {
      await exploreInventory({ full: false });
      console.log("  preflight: Neo inventory refreshed.");
    } catch (e) {
      console.warn(`  preflight: inventory refresh skipped (${(e as Error).message}).`);
    }
  } else {
    console.log("  preflight: NEO_MCP_URL not set — skipping content refresh.");
  }

  // 2) structure + auth
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("No browser profile. Run `login` first: npm run cli -- login --storyboard <file>");
  }
  const firstGoto = sb.beats.flatMap((b) => b.actions).find((a) => a.type === "goto") as
    | { type: "goto"; url: string }
    | undefined;
  const url = firstGoto?.url ?? sb.auth.loginUrl;
  const waypoints = deriveWaypoints(sb);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500); // let any SSO redirect settle

    if (SIGN_IN_RE.test(page.url())) {
      throw new Error("Session expired — re-run `login` before recording.");
    }

    // Verify the first-screen waypoint (later waypoints live deeper in the flow
    // and are validated per-action while recording).
    const firstWaypoint = waypoints[0];
    if (firstWaypoint) {
      const visible = await page
        .locator(firstWaypoint)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) {
        throw new Error(
          `Preflight failed: expected element not found on ${page.url()}:\n` +
            `    '${firstWaypoint}'\n` +
            `  The entry screen looks different than the storyboard expects — the UI may have changed.\n` +
            `  Re-check the selector (playwright codegen), or convert this beat to an act() step.`
        );
      }
    }
    console.log("  preflight: app reachable, authenticated, entry waypoint present ✓");
  } finally {
    await ctx.close();
  }
}
