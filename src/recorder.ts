import path from "node:path";
import fs from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { Action, AuthConfig, Beat, Storyboard } from "./types.ts";
import { HEADFUL, resolveSecret, AUTH_STATE_PATH } from "./config.ts";

/**
 * Log in ONCE in a throwaway, non-recorded context, then persist the session
 * to a storageState file. Recording contexts reuse it so clips never contain
 * the login flow (cleaner takes) and credentials never appear on camera.
 */
async function authenticate(browser: Browser, auth: AuthConfig, storageStatePath: string): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    if (!auth.usernameSelector || !auth.passwordSelector || !auth.submitSelector) {
      throw new Error("Automated login needs username/password/submit selectors; use the `login` command for SSO.");
    }
    await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
    await page.fill(auth.usernameSelector, resolveSecret(`$${auth.usernameEnv}`));
    await page.fill(auth.passwordSelector, resolveSecret(`$${auth.passwordEnv}`));
    await page.click(auth.submitSelector);

    if (auth.successSelector) {
      await page.waitForSelector(auth.successSelector, { timeout: 30_000 });
    } else if (auth.successUrlIncludes) {
      await page.waitForURL((url) => url.href.includes(auth.successUrlIncludes!), { timeout: 30_000 });
    } else {
      await page.waitForLoadState("networkidle");
    }
    await ctx.storageState({ path: storageStatePath });
  } finally {
    await ctx.close();
  }
}

/**
 * Decide which session to record with. Priority:
 *  1) a session saved by `login` (data/auth.json) — the MS SSO/MFA path;
 *  2) automated credential login (only for simple username/password apps);
 *  3) otherwise, a clear instruction to run `login`.
 */
async function resolveSession(browser: Browser, sb: Storyboard, outDir: string): Promise<string> {
  if (fs.existsSync(AUTH_STATE_PATH)) {
    console.log(`  Using saved session (${path.relative(process.cwd(), AUTH_STATE_PATH)}).`);
    return AUTH_STATE_PATH;
  }
  const hasCreds =
    process.env[sb.auth.usernameEnv] && process.env[sb.auth.passwordEnv];
  if (hasCreds) {
    const p = path.join(outDir, "auth.json");
    await authenticate(browser, sb.auth, p);
    return p;
  }
  throw new Error(
    "No saved session and no credentials.\n" +
      "  This app uses SSO/MFA, so log in once by hand:\n" +
      "    npm run cli -- login --storyboard <your storyboard.json>\n" +
      "  Then re-run. (For simple username/password apps, set NEO_USERNAME/NEO_PASSWORD in .env instead.)"
  );
}

async function runAction(page: import("playwright").Page, a: Action): Promise<void> {
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
  }
}

export interface RecordedClip {
  beatId: string;
  caption: string;
  rawPath: string;
}

/**
 * Record one clip PER BEAT. Each beat gets its own recorded context, so clips
 * are discrete, reviewable and replaceable (approve beat 3, re-record beat 4)
 * rather than one all-or-nothing take.
 */
export async function recordStoryboard(sb: Storyboard, outDir: string): Promise<RecordedClip[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const clipsDir = path.join(outDir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADFUL });
  const clips: RecordedClip[] = [];
  try {
    const sessionPath = await resolveSession(browser, sb, outDir);
    const { width, height } = sb.spec.resolution;

    for (const beat of sb.beats) {
      const ctx: BrowserContext = await browser.newContext({
        storageState: sessionPath,
        viewport: { width, height },
        recordVideo: { dir: clipsDir, size: { width, height } },
      });
      const page = await ctx.newPage();
      // Watchdog so a stuck selector can never hang the whole run.
      const deadline = setTimeout(() => void ctx.close(), beat.maxDurationSec * 1000 + 10_000);
      try {
        for (const a of beat.actions) await runAction(page, a);
      } catch (err) {
        console.error(`  [beat ${beat.id}] action error: ${(err as Error).message}`);
      } finally {
        clearTimeout(deadline);
      }
      const video = page.video();
      await ctx.close(); // finalizes the .webm
      if (!video) throw new Error(`No video captured for beat ${beat.id}`);
      const tmp = await video.path();
      const finalRaw = path.join(clipsDir, `${beat.id}.webm`);
      fs.renameSync(tmp, finalRaw);
      clips.push({ beatId: beat.id, caption: beat.caption, rawPath: finalRaw });
      console.log(`  [beat ${beat.id}] captured -> ${path.relative(process.cwd(), finalRaw)}`);
    }
  } finally {
    await browser.close();
  }
  return clips;
}
