import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { PROFILE_DIR, HEADFUL, ensureDirs } from "./config.ts";
import { azureConfigured } from "./agent-llm.ts";
import { selfHeal } from "./self-heal.ts";

/**
 * Isolated test of the self-heal path on a real page: launch our recording
 * context, navigate, resolve one natural-language action via the accessibility
 * tree + Azure, and confirm (a) it resolved/acted and (b) the recording captured
 * it. Run this before adding intent/act to a storyboard.
 */
export async function probeAct(url: string, intent: string): Promise<void> {
  ensureDirs();
  if (!fs.existsSync(PROFILE_DIR)) throw new Error("No browser profile — run `login` first.");
  if (!azureConfigured()) throw new Error("Azure not configured — set AZURE_* in .env (self-heal needs a model).");

  const rawDir = path.join(process.cwd(), "data", "probe");
  fs.mkdirSync(rawDir, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADFUL,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: rawDir, size: { width: 1280, height: 720 } },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);

  let healOk = false;
  let healErr = "";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Diagnostics: what does the page actually contain right now?
    const buttons = await page.locator("button, [role=button]").count().catch(() => -1);
    const inputs = await page.locator("input, textarea, select").count().catch(() => -1);
    const links = await page.locator("a").count().catch(() => -1);
    const frames = page.frames().length;
    console.log(`  page: "${(await page.title().catch(() => "")).slice(0, 60)}" | frames=${frames} | buttons=${buttons} inputs=${inputs} links=${links}`);

    console.log(`  resolving "${intent}" via self-heal ...`);
    try {
      await selfHeal(page, intent, "click");
      healOk = true;
    } catch (e) {
      healErr = (e as Error).message;
    }
    await page.waitForTimeout(1500);
  } finally {
    const video = page.video();
    await context.close().catch(() => {});

    let videoOk = false;
    let sizeKB = 0;
    if (video) {
      try {
        sizeKB = fs.statSync(await video.path()).size / 1024;
        videoOk = sizeKB > 10;
      } catch {
        /* no video */
      }
    }
    console.log("\n  PROBE RESULTS");
    console.log(`   self-heal resolved + acted:  ${healOk ? "YES ✓" : `NO ✗  (${healErr.slice(0, 100)})`}`);
    console.log(`   recording captured it:       ${videoOk ? `YES ✓ (${sizeKB.toFixed(0)} KB)` : "NO ✗"}`);
    console.log(
      `\n  ${healOk && videoOk ? "Self-heal path works — safe to add intent/act to a storyboard." : "Something failed — paste this output and I'll adjust."}`
    );
  }
}
