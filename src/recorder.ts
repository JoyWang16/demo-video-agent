import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Action, Storyboard } from "./types.ts";
import { HEADFUL, resolveSecret, PROFILE_DIR } from "./config.ts";
import { cutClip } from "./ffmpeg.ts";
import { computeDwellSec } from "./timing.ts";

async function runAction(page: Page, a: Action): Promise<void> {
  switch (a.type) {
    case "goto":
      await page.goto(a.url, { waitUntil: "domcontentloaded" });
      break;
    case "click":
      await page.click(a.selector);
      break;
    case "hover":
      await page.hover(a.selector);
      break;
    case "waitForSelector":
      await page.waitForSelector(a.selector, { timeout: a.timeoutMs ?? 15_000 });
      break;
    case "waitMs":
      await page.waitForTimeout(a.ms);
      break;
    case "scrollTo":
      await page.locator(a.selector).scrollIntoViewIfNeeded();
      break;
    case "fill":
      await page.fill(a.selector, resolveSecret(a.value));
      break;
    case "selectOption":
      await page.selectOption(a.selector, a.value);
      break;
  }
}

export interface RecordedClip {
  beatId: string;
  caption: string;
  rawPath: string;
  captionStartSec: number;
}

const SIGN_IN_RE = /sign-in|login\.microsoftonline|\/login/i;

/** Quick headless check that the persistent profile is still authenticated,
 * BEFORE opening the recording context — so an expired session fails fast with
 * a clear message instead of producing a broken take. */
async function assertAuthenticated(loginUrl: string): Promise<void> {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(
      "No browser profile yet. Log in once:\n" +
        "    npm run cli -- login --storyboard <your storyboard.json>"
    );
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500); // allow any SSO redirect to settle
    if (SIGN_IN_RE.test(page.url())) {
      throw new Error(
        "Session expired — the profile is no longer logged in. Re-run:\n" +
          "    npm run cli -- login --storyboard <your storyboard.json>"
      );
    }
  } finally {
    await ctx.close();
  }
}

/**
 * Record the demo as ONE continuous session (so each step starts where the last
 * left off), then split the take into per-beat clips by timestamp. Uses the
 * persistent profile from `login`, so it starts already authenticated.
 */
export async function recordStoryboard(sb: Storyboard, outDir: string): Promise<RecordedClip[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const clipsDir = path.join(outDir, "clips");
  const rawDir = path.join(outDir, "raw");
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  await assertAuthenticated(sb.auth.loginUrl);

  const { width, height } = sb.spec.resolution;
  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADFUL,
    viewport: { width, height },
    recordVideo: { dir: rawDir, size: { width, height } },
  });
  const clips: RecordedClip[] = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width, height });
    page.setDefaultTimeout(15_000); // a bad selector throws (and is caught) instead of hanging

    const segments: { beatId: string; caption: string; startSec: number; captionStartSec: number }[] = [];
    const t0 = Date.now();
    for (const beat of sb.beats) {
      const beatStart = (Date.now() - t0) / 1000;
      try {
        for (const a of beat.actions) await runAction(page, a);
      } catch (err) {
        console.error(`  [beat ${beat.id}] action error: ${(err as Error).message} (continuing)`);
      }
      const actionsEnd = (Date.now() - t0) / 1000;
      const dwellSec = beat.dwellSec ?? computeDwellSec(beat.caption, sb.spec.captions);
      await page.waitForTimeout(Math.round(dwellSec * 1000));
      segments.push({
        beatId: beat.id,
        caption: beat.caption,
        startSec: beatStart,
        captionStartSec: actionsEnd - beatStart, // caption begins once actions settle
      });
      console.log(
        `  [beat ${beat.id}] actions ${(actionsEnd - beatStart).toFixed(1)}s + dwell ${dwellSec.toFixed(1)}s`
      );
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
      const dur = end - s.startSec;
      const clipOut = path.join(clipsDir, `${s.beatId}.mp4`);
      await cutClip(rawFull, clipOut, s.startSec, dur);
      clips.push({ beatId: s.beatId, caption: s.caption, rawPath: clipOut, captionStartSec: s.captionStartSec });
      console.log(`  [beat ${s.beatId}] clip ${dur.toFixed(1)}s -> ${path.relative(process.cwd(), clipOut)}`);
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
