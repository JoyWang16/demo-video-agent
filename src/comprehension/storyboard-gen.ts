import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import { getAzureModel, azureConfigured } from "../agent-llm.ts";
import { StoryboardSchema, type GenerationSpec, type Storyboard } from "../types.ts";
import { validateStoryboard } from "../storyboard.ts";

/**
 * Phase B: turn a human-provided GenerationSpec + the Neo inventory into a
 * full, act()-first Storyboard draft.
 *
 * Design choices that keep generated storyboards RUNNABLE (not just plausible):
 *  - The model never invents CSS selectors (it can't see the DOM). The
 *    generation action set is restricted to goto / act / actHover / actFill /
 *    waitMs, all of which resolve live at record time via self-heal. Zero
 *    selector guessing. actHover exists so a demo can stop ON a launch control
 *    without pressing it — act() always clicks.
 *  - The model writes the semantic parts (title, description, feature, captions,
 *    natural-language intents). We fill the numeric/config parts (length,
 *    tolerance, resolution, captions, auth) from the spec deterministically.
 *  - Output is assembled into a full Storyboard and MUST pass validateStoryboard
 *    (duration budget + destructive-keyword denylist); on failure we retry once
 *    with the errors fed back to the model.
 */

// Generation-only action set: natural-language + deterministic navigation only.
const GenActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }),
  z.object({ type: z.literal("act"), intent: z.string() }),
  z.object({ type: z.literal("actHover"), intent: z.string() }),
  z.object({ type: z.literal("actFill"), intent: z.string(), value: z.string() }),
  z.object({ type: z.literal("waitMs"), ms: z.number().int().positive() }),
]);
const GenBeatSchema = z.object({
  id: z.string().min(1),
  caption: z.string(),
  actions: z.array(GenActionSchema).min(1),
});
const GenOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  feature: z.string().min(1),
  beats: z.array(GenBeatSchema).min(2),
});

const SYSTEM = [
  "You convert a human author's demo description into an executable storyboard for a",
  "short, non-destructive product-demo video of a web app, as a sequence of 'beats'.",
  "Each beat is one clip: a concise on-screen caption (<= ~70 chars, reads in a couple",
  "seconds) plus an ordered list of actions. You may ONLY use these action types:",
  "  - goto {url}: navigate to an absolute URL under the app's base URL.",
  "  - act {intent}: a natural-language CLICK/open/select, e.g. 'click the Run button on the second card'.",
  "  - actHover {intent}: hover over an element WITHOUT clicking it, e.g. 'the Start evaluation button'.",
  "  - actFill {intent, value}: type a value into a field described in natural language.",
  "  - waitMs {ms}: a short pause (e.g. 800-1500ms) for the UI to settle between related actions.",
  "You NEVER write CSS selectors — describe elements by their visible label/role/purpose.",
  "",
  "GUIDED MODE (when the author provides steps): convert EACH author step into EXACTLY ONE",
  "beat, in the SAME order. Do NOT add, remove, merge, split, or reorder steps. Take any",
  "literal values to type from the author's step text. Use the author's caption if given,",
  "otherwise write a short one. You are a translator from description to actions, not an author.",
  "",
  "STRICT SAFETY: never perform or describe a destructive/irreversible/costly action. Do NOT",
  "launch, start, submit, run, pay for, delete, or confirm anything. Naming a feature (e.g.",
  "'the red-teaming evaluation') is fine; TRIGGERING it is not. The final beat must only HOVER",
  "or point at any launch control — never trigger it. To do that you MUST use actHover: act()",
  "always CLICKS, so an act() step whose intent says 'hover' would press the button. Never write",
  "an act() intent containing 'hover', 'mouse over', 'point at', or 'without clicking'.",
].join(" ");

function buildPrompt(spec: GenerationSpec, inventoryText: string): string {
  const guided = spec.steps && spec.steps.length > 0;
  const stepsBlock = guided
    ? [
        "",
        "AUTHOR-PROVIDED STEPS — convert each into exactly one beat, in this order:",
        ...spec.steps!.map(
          (s, i) => `  ${i + 1}. ${s.do}${s.caption ? `  [caption: ${s.caption}]` : ""}`
        ),
      ].join("\n")
    : [
        "",
        "No explicit steps were provided. Propose a concise, sensible beat sequence for this demo",
        "(navigate in, walk through the setup, end by reviewing the ready state without launching).",
      ].join("\n");

  return [
    `Video to script: a demo of the "${spec.evalType}" evaluation for the project "${spec.project}" in the Neo app.`,
    spec.audience ? `Audience: ${spec.audience}.` : "",
    spec.tone ? `Tone: ${spec.tone}.` : "",
    `Target length: ~${spec.targetLengthSec}s. App base URL: ${spec.appBaseUrl}.`,
    spec.extraGuidance ? `Extra guidance: ${spec.extraGuidance}` : "",
    "",
    "Context — read-only inventory of this Neo account (ground the demo in the real project):",
    inventoryText,
    stepsBlock,
    "",
    "Produce a JSON object with: title, description, feature, and beats[].",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Load and lightly trim the inventory JSON for the prompt (cap size). */
function loadInventoryText(inventoryPath: string): string {
  const raw = fs.readFileSync(inventoryPath, "utf8");
  // Cap to keep the prompt bounded; the model needs the shape + names, not everything.
  return raw.length > 12_000 ? raw.slice(0, 12_000) + "\n… (truncated)" : raw;
}

function assemble(spec: GenerationSpec, gen: z.infer<typeof GenOutputSchema>): Storyboard {
  const id = `${slug(spec.project)}-${slug(spec.evalType)}`;
  const candidate = {
    spec: {
      id,
      title: gen.title,
      description: gen.description,
      feature: gen.feature,
      targetLengthSec: spec.targetLengthSec,
      tolerancePct: spec.tolerancePct,
      captions: spec.captions,
      resolution: spec.resolution,
      audience: spec.audience,
      tone: spec.tone,
    },
    auth: { loginUrl: spec.loginUrl, successUrlIncludes: spec.successUrlIncludes },
    beats: gen.beats.map((b) => ({ id: b.id, caption: b.caption, actions: b.actions })),
  };
  // Parse through the real schema so defaults (tolerancePct, maxDurationSec, …) are applied.
  return StoryboardSchema.parse(candidate);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "video";
}

export interface GenerateResult {
  storyboard: Storyboard;
  outPath: string;
  warnings: string[];
}

export async function generateStoryboard(spec: GenerationSpec, inventoryPath: string): Promise<GenerateResult> {
  if (!azureConfigured()) {
    throw new Error("Generation needs Azure configured (AZURE_API_KEY / AZURE_RESOURCE_NAME / AZURE_DEPLOYMENT).");
  }
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`Inventory not found at ${inventoryPath}. Export one first (explore --full, or hand-export from Claude Code).`);
  }
  const inventoryText = loadInventoryText(inventoryPath);
  const model = getAzureModel();

  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      buildPrompt(spec, inventoryText) +
      (lastErrors.length
        ? `\n\nYour previous draft FAILED validation with these errors — fix them:\n- ${lastErrors.join("\n- ")}`
        : "");

    const { object } = await generateObject({ model, schema: GenOutputSchema, system: SYSTEM, prompt });
    const storyboard = assemble(spec, object);
    const v = validateStoryboard(storyboard);
    if (v.ok) {
      const outPath = path.join(process.cwd(), "storyboards", `${storyboard.spec.id}.generated.json`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(storyboard, null, 2), "utf8");
      return { storyboard, outPath, warnings: v.warnings };
    }
    lastErrors = v.errors;
    console.warn(`  generation attempt ${attempt} failed validation: ${v.errors.join("; ")}`);
  }
  throw new Error(`Generator could not produce a valid storyboard after 2 attempts: ${lastErrors.join("; ")}`);
}
