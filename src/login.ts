import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { loadStoryboard } from "./storyboard.ts";
import { AUTH_STATE_PATH, ensureDirs } from "./config.ts";

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
 * Open a real (headful) browser, let the human complete the full login flow
 * by hand — including Microsoft SSO and MFA — then save the authenticated
 * session to a reusable storageState file. Recording runs load this session
 * and never touch the login flow, so SSO/MFA is handled exactly once, by you.
 *
 * Re-run whenever the saved session expires (a run failing at the first beat
 * with redirects to a login page is the tell).
 */
export async function manualLogin(storyboardFile: string): Promise<void> {
  ensureDirs();
  const sb = loadStoryboard(storyboardFile);
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(sb.auth.loginUrl, { waitUntil: "domcontentloaded" });
    console.log(
      "\n  A browser window is open. Log in fully — Microsoft SSO, MFA, everything —\n" +
        "  until you land on the app's home screen.\n"
    );
    await waitForEnter("  When you're logged in and see the app, press ENTER here to save the session... ");

    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await ctx.storageState({ path: AUTH_STATE_PATH });
    console.log(`\n  ✓ Session saved to ${path.relative(process.cwd(), AUTH_STATE_PATH)}. Recording runs will reuse it.`);
  } finally {
    await browser.close();
  }
}
