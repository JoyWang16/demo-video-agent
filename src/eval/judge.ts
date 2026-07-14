import fs from "node:fs";
import { z } from "zod";
import { generateObject } from "ai";
import { createAzure } from "@ai-sdk/azure";
import type { VideoSpec } from "../types.ts";
import { azureEnv } from "../config.ts";
import { sampleFrames } from "../ffmpeg.ts";

/**
 * OPTIONAL semantic gate. The hard checks in evaluate.ts confirm the file is
 * technically sound; this asks a vision model whether the video actually shows
 * the promised feature and whether captions read cleanly. Behind creds because
 * it costs tokens.
 */
const JudgeSchema = z.object({
  shows_feature: z.boolean(),
  captions_readable: z.boolean(),
  on_topic: z.boolean(),
  score: z.number().min(0).max(10),
  notes: z.string(),
});
export type JudgeResult = z.infer<typeof JudgeSchema>;

export async function judgeVideo(video: string, spec: VideoSpec, workDir: string): Promise<JudgeResult> {
  if (!azureEnv.apiKey || !azureEnv.resourceName || !azureEnv.visionDeployment) {
    throw new Error("Azure vision not configured (need a vision-capable deployment).");
  }
  const azure = createAzure({ resourceName: azureEnv.resourceName, apiKey: azureEnv.apiKey });
  const frames = await sampleFrames(video, 5, workDir);
  const images = frames.map((f) => ({
    type: "image" as const,
    image: fs.readFileSync(f),
  }));

  const { object } = await generateObject({
    model: azure(azureEnv.visionDeployment),
    schema: JudgeSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `These frames are sampled from a product-demo video.\n` +
              `Intended feature: "${spec.feature}"\nDescription: "${spec.description}"\n` +
              `Captions expected: ${spec.captions}.\n` +
              `Judge whether it shows the feature, captions read cleanly, and it stays on topic.`,
          },
          ...images,
        ],
      },
    ],
  });
  return object;
}
