import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import type { Storyboard } from "./types.ts";
import { HEADFUL, PROFILE_DIR } from "./config.ts";
import { cutClip } from "./ffmpeg.ts";
import { computeDwellSec } from "./timing.ts";
import { runAction, needsAgent, type AgentPage } from "./executor.ts";
import { azureConfigured } from "./agent-llm.ts";
import { selfHeal } from "./self-heal.ts";

export interface RecordedClip {
  beatId: string;
  caption: string;
  rawPath: string;
  captionStartSec: number;
}

const SIGN_IN_RE = /sign-in|login\.microsoftonline|\/login/i;

async function assertAuthenticated(loginUrl: string): Promise<void> {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("No browser profile yet. Log in once:\n    npm run cli -- login --storyboard <file>");
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    if (SIGN_IN_RE.test(page.url())) {
      throw new Error("Session expired. Re-run:\n    npm run cli -- login --storyboard <file>");
    }
  } finally {
    await ctx.close();
  }
}

/**
 * Record the demo as ONE continuous session (each step starts where the last
 * left off), then split into per-beat clips by timestamp. Uses the persistent
 * profile from `login`, so it starts authenticated. Deterministic actions run
 * natively; if the storyboard uses intent/act AND Azure is configured, click/
 * hover selectors self-heal via the accessibility tree on failure.
 */
export async function recordStoryboard(sb: Storyboard, outDir: string): Promise<RecordedClip[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const clipsDir = path.join(outDir, "clips");
  const rawDir = path.join(outDir, "raw");
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  await assertAuthenticated(sb.auth.loginUrl);

  const { width, height } = sb.spec.resolution;
  const wantAgent = needsAgent(sb.beats.flatMap((b) => b.actions));
  const healEnabled = wantAgent && azureConfigured();
  if (wantAgent && !healEnabled) {
    console.warn("  ⚠ storyboard uses intent/act but Azure isn't configured — running deterministic-only (no self-heal).");
  }

  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADFUL,
    viewport: { width, height },
    recordVideo: { dir: rawDir, size: { width, height } },
  });
  const clips: RecordedClip[] = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width, height });
    page.setDefaultTimeout(15_000);

    const agent: AgentPage = {
      page,
      heal: healEnabled ? (intent, kind) => selfHeal(page, intent, kind) : undefined,
    };

    const segments: { beatId: string; caption: string; startSec: number; captionStartSec: number }[] = [];
    const t0 = Date.now();
    for (const beat of sb.beats) {
      const beatStart = (Date.now() - t0) / 1000;
      try {
        for (const a of beat.actions) await runAction(agent, a);
      } catch (err) {
        console.error(`  [beat ${beat.id}] action error: ${(err as Error).message} (continuing)`);
      }
      const actionsEnd = (Date.now() - t0) / 1000;
      const dwellSec = beat.dwellSec ?? computeDwellSec(beat.caption, sb.spec.captions);
      await page.waitForTimeout(Math.round(dwellSec * 1000));
      segments.push({ beatId: beat.id, caption: beat.caption, startSec: beatStart, captionStartSec: actionsEnd - beatStart });
      console.log(`  [beat ${beat.id}] actions ${(actionsEnd - beatStart).toFixed(1)}s + dwell ${dwellSec.toFixed(1)}s`);
    }
    const totalSec = (Date.now() - t0) / 1000;

    const video = page.video();
    await context.close(); // finalizes the raw .webm
    if (!video) throw new Error("No video captured");
    const rawFull = path.join(rawDir, "full.webm");
    fs.renameSync(await video.path(), rawFull);
    console.log(`  raw take: ${totalSec.toFixed(1)}s -> splitting into ${segments.length} clip(s)`);

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!;
      const end = i + 1 < segments.length ? segments[i + 1]!.startSec : totalSec;
      const clipOut = path.join(clipsDir, `${s.beatId}.mp4`);
      await cutClip(rawFull, clipOut, s.startSec, end - s.startSec);
      clips.push({ beatId: s.beatId, caption: s.caption, rawPath: clipOut, captionStartSec: s.captionStartSec });
      console.log(`  [beat ${s.beatId}] clip ${(end - s.startSec).toFixed(1)}s -> ${path.relative(process.cwd(), clipOut)}`);
    }
  } finally {
    try {
      await context.close();
    } catch {
      /* already closed after finalizing video */
    }
  }
  return clips;
}
