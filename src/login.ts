import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { loadStoryboard } from "./storyboard.ts";
import { PROFILE_DIR, ensureDirs } from "./config.ts";

function waitForEnter(prompt: string): Promise<void> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/**
 * Open a real (headful) browser using a PERSISTENT profile directory, let the
 * human complete the full login flow by hand — Microsoft SSO, MFA, and crucially
 * the "Stay signed in?" / "Don't show this again" prompt — then close. Because
 * the profile is durable (like a normal browser), the persistent session token
 * is kept on disk, so recording runs reuse it and you are NOT re-prompted for
 * MFA every run. Re-run only when your org's session policy finally expires it.
 */
export async function manualLogin(storyboardFile: string): Promise<void> {
  ensureDirs();
  const sb = loadStoryboard(storyboardFile);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null, // normal window sizing for comfortable manual login
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(sb.auth.loginUrl, { waitUntil: "domcontentloaded" });
    console.log(
      "\n  A browser window is open. Log in fully — Microsoft SSO + MFA.\n" +
        "  IMPORTANT: when Microsoft asks \"Stay signed in?\" choose YES (and tick\n" +
        "  \"Don't show this again\") — that's what lets future runs skip MFA.\n" +
        "  Continue until you land on the app's home screen.\n"
    );
    await waitForEnter("  When you're in and see the app, press ENTER to save the session... ");
    console.log(`\n  ✓ Session saved to profile (${path.relative(process.cwd(), PROFILE_DIR)}). Recording runs will reuse it.`);
  } finally {
    await context.close();
  }
}
