import fs from "node:fs";
import path from "node:path";
import type { Page, Locator } from "playwright";
import { z } from "zod";
import { generateObject } from "ai";
import { getAzureModel } from "./agent-llm.ts";
import { DATA_DIR } from "./config.ts";

/**
 * Selector-free self-heal, built on Playwright (no Stagehand). When a beat's
 * deterministic selector fails (or a pure `act` step runs), we:
 *   1) enumerate the visible interactive elements and read their role +
 *      accessible name (the same semantic layer Stagehand uses),
 *   2) ask Azure to pick the one matching the natural-language intent,
 *   3) act on it via a Playwright getByRole locator,
 *   4) cache intent -> {role,name} so the next run skips the model call.
 * Everything stays in our recorded Playwright page — recording is unaffected.
 */

const CANDIDATE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], input, textarea, select, [onclick]';
const MAX_CANDIDATES = 100;
const CACHE_PATH = path.join(DATA_DIR, "heal-cache.json");

type Cached = { role: string; name: string };
type Kind = "click" | "hover";

function loadCache(): Record<string, Cached> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveCache(c: Record<string, Cached>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2), "utf8");
}

interface Candidate {
  loc: Locator;
  role: string;
  name: string;
}

async function candidates(page: Page): Promise<Candidate[]> {
  // SPAs render interactive elements after domcontentloaded — wait for at least
  // one visible candidate (up to ~10s) before enumerating, so we don't scan an
  // empty page. Falls through to enumeration even if the wait times out.
  await page
    .locator(CANDIDATE_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});

  const base = page.locator(CANDIDATE_SELECTOR);
  const count = Math.min(await base.count(), MAX_CANDIDATES);
  const out: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const loc = base.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    // Skip disabled elements — the model shouldn't pick them and clicking a
    // disabled control just hangs until timeout (observed on the Attacks page).
    if (!(await loc.isEnabled().catch(() => true))) continue;
    const info = await loc
      .evaluate((el) => {
        const e = el as unknown as {
          getAttribute(n: string): string | null;
          innerText?: string;
          tagName: string;
          value?: string;
        };
        const name =
          e.getAttribute("aria-label") ||
          e.innerText ||
          e.getAttribute("placeholder") ||
          e.getAttribute("title") ||
          e.value ||
          "";
        return { role: e.getAttribute("role") || e.tagName.toLowerCase(), name: name.replace(/\s+/g, " ").trim().slice(0, 80) };
      })
      .catch(() => null);
    if (info) out.push({ loc, role: info.role, name: info.name });
  }
  return out;
}

/** Ask the model to choose one element index (or -1 if none fit). Exported for unit testing. */
export async function pickIndex(cands: { role: string; name: string }[], intent: string): Promise<number> {
  const list = cands.map((c, i) => `${i}. <${c.role}> ${c.name || "(no label)"}`).join("\n");
  const { object } = await generateObject({
    model: getAzureModel(),
    schema: z.object({ index: z.number().int(), reason: z.string() }),
    system:
      "Map a natural-language UI action to exactly ONE element from the numbered list. " +
      "Return its index. If none reasonably match, return -1.",
    prompt: `Action: "${intent}"\n\nVisible interactive elements:\n${list}`,
  });
  return object.index;
}

async function doAct(loc: Locator, kind: Kind): Promise<void> {
  const opts = { timeout: 6000 }; // fail fast rather than hang if unclickable
  if (kind === "click") await loc.click(opts);
  else await loc.hover(opts);
}

export async function selfHeal(page: Page, intent: string, kind: Kind): Promise<void> {
  const cache = loadCache();
  const key = `${page.url().split("?")[0]}::${kind}::${intent}`;

  // 1) cached resolution — no model call
  const hit = cache[key];
  if (hit) {
    const role = hit.role as Parameters<Page["getByRole"]>[0];
    const loc = page.getByRole(role, hit.name ? { name: hit.name } : undefined).first();
    if (await loc.isVisible().catch(() => false)) {
      await doAct(loc, kind);
      return;
    }
  }

  // 2) enumerate + model pick
  const cands = await candidates(page);
  if (cands.length === 0) throw new Error(`self-heal: no interactive elements found for "${intent}"`);
  const idx = await pickIndex(
    cands.map(({ role, name }) => ({ role, name })),
    intent
  );
  if (idx < 0 || idx >= cands.length) throw new Error(`self-heal: model could not match "${intent}"`);

  const chosen = cands[idx]!;
  await doAct(chosen.loc, kind);
  cache[key] = { role: chosen.role, name: chosen.name };
  saveCache(cache);
  console.log(`  self-heal resolved "${intent}" -> <${chosen.role}> ${chosen.name}`);
}
