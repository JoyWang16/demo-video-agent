import type { Page } from "playwright";
import type { Action } from "./types.ts";
import { resolveSecret } from "./config.ts";

/**
 * An AgentPage is a recorded Playwright page, optionally augmented with a
 * self-heal capability (present only when Azure is configured + the storyboard
 * needs it). Deterministic actions always use native Playwright; heal() is used
 * for pure `act` steps and as the fallback when a click/hover selector breaks.
 */
export interface AgentPage {
  page: Page;
  heal?: (intent: string, kind: "click" | "hover") => Promise<void>;
}

/** Does this set of actions require the self-heal capability (Azure)? */
export function needsAgent(actions: Action[]): boolean {
  return actions.some((a) => a.type === "act" || ("intent" in a && Boolean(a.intent)));
}

const NATIVE_ATTEMPT_TIMEOUT_MS = 4000; // fail fast so self-heal kicks in quickly

export async function runAction(ap: AgentPage, a: Action): Promise<void> {
  const { page } = ap;
  switch (a.type) {
    case "goto":
      await page.goto(a.url, { waitUntil: "domcontentloaded" });
      return;
    case "waitMs":
      await page.waitForTimeout(a.ms);
      return;
    case "waitForSelector":
      await page.waitForSelector(a.selector, { timeout: a.timeoutMs ?? 15_000 });
      return;
    case "selectOption":
      await page.selectOption(a.selector, a.value);
      return;
    case "scrollTo":
      await page.locator(a.selector).scrollIntoViewIfNeeded();
      return;
    case "fill":
      await page.fill(a.selector, resolveSecret(a.value));
      return;
    case "act": {
      if (!ap.heal) throw new Error(`act step needs Azure self-heal but it isn't enabled: "${a.intent}"`);
      await ap.heal(a.intent, "click");
      return;
    }
    case "click":
    case "hover": {
      const kind = a.type;
      const hasIntent = "intent" in a && Boolean(a.intent);
      const native = () =>
        kind === "click"
          ? page.click(a.selector, hasIntent ? { timeout: NATIVE_ATTEMPT_TIMEOUT_MS } : undefined)
          : page.hover(a.selector, hasIntent ? { timeout: NATIVE_ATTEMPT_TIMEOUT_MS } : undefined);
      if (!hasIntent) {
        await native(); // deterministic-only (current behaviour)
        return;
      }
      // Playwright-first, self-heal fallback. The healed {role,name} is cached,
      // so subsequent runs skip the model call.
      try {
        await native();
      } catch (err) {
        if (!ap.heal) throw err;
        console.warn(`  self-heal: selector '${a.selector}' failed; resolving "${a.intent}" live`);
        await ap.heal(a.intent as string, kind);
      }
      return;
    }
  }
}
