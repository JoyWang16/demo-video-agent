import { z } from "zod";
import { generateObject } from "ai";
import { createAzure } from "@ai-sdk/azure";
import { BeatSchema, type VideoSpec, type Beat } from "../types.ts";
import { azureEnv } from "../config.ts";

/**
 * OPTIONAL stage. Turns a VideoSpec + comprehension context (Neo data + a
 * description of the app's known routes) into a draft list of beats: caption
 * copy + an ordered action outline.
 *
 * Honesty note: an LLM cannot reliably invent CSS selectors for a UI it hasn't
 * seen. Treat generated selectors as drafts to verify against the live app, or
 * swap the recorder's action executor for Stagehand `act()` (natural-language
 * actions resolved against the live DOM) so selectors aren't needed at all.
 */
export async function generateBeats(
  spec: VideoSpec,
  context: { appRoutes: string; neoSummary: string }
): Promise<Beat[]> {
  if (!azureEnv.apiKey || !azureEnv.resourceName || !azureEnv.deployment) {
    throw new Error("Azure not configured (AZURE_API_KEY / AZURE_RESOURCE_NAME / AZURE_DEPLOYMENT).");
  }
  const azure = createAzure({ resourceName: azureEnv.resourceName, apiKey: azureEnv.apiKey });

  const { object } = await generateObject({
    model: azure(azureEnv.deployment),
    schema: z.object({ beats: z.array(BeatSchema) }),
    system:
      "You script short product-demo videos as a sequence of 'beats'. Each beat is one clip: " +
      "a concise on-screen caption plus an ordered list of NON-DESTRUCTIVE navigation/read actions " +
      "(goto, click, hover, waitForSelector, waitMs, scrollTo, fill for search/filter only). " +
      "Never delete, submit, confirm, pay, or launch scans. Keep total runtime near the target length.",
    prompt:
      `Video spec:\n${JSON.stringify(spec, null, 2)}\n\n` +
      `Known app routes:\n${context.appRoutes}\n\n` +
      `What exists to demo (from the Neo read-only API):\n${context.neoSummary}\n\n` +
      `Produce beats whose captions explain the feature "${spec.feature}" for a ` +
      `${spec.audience ?? "general"} audience in a ${spec.tone ?? "clear, neutral"} tone.`,
  });
  return object.beats;
}
