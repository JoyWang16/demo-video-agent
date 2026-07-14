import { z } from "zod";

/**
 * A storyboard is the vetted, deterministic artifact that sits between
 * "understanding the app" and "recording". It is the reusable core of the
 * system: re-generate it when the UI changes; record/edit stay deterministic.
 */

// ---- Video spec: the input contract ---------------------------------------

export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const VideoSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  feature: z.string().min(1), // which app feature this demos (for the CSV + eval)
  targetLengthSec: z.number().positive(),
  tolerancePct: z.number().min(0).max(1).default(0.25),
  captions: z.boolean().default(true),
  resolution: ResolutionSchema.default({ width: 1280, height: 720 }),
  audience: z.string().optional(),
  tone: z.string().optional(),
});
export type VideoSpec = z.infer<typeof VideoSpecSchema>;

// ---- Actions: the only verbs a recording is allowed to perform ------------
// NOTE: this is intentionally a *read/navigation-only* allowlist. There is no
// "delete"/"submit form"/"confirm" verb. Destructive actions in the target app
// must never be part of an automated recording (see guardrails in README).

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }),
  z.object({ type: z.literal("click"), selector: z.string(), note: z.string().optional() }),
  z.object({ type: z.literal("hover"), selector: z.string(), note: z.string().optional() }),
  z.object({ type: z.literal("waitForSelector"), selector: z.string(), timeoutMs: z.number().optional() }),
  z.object({ type: z.literal("waitMs"), ms: z.number().int().positive() }),
  z.object({ type: z.literal("scrollTo"), selector: z.string() }),
  // fill is allowed only for non-destructive inputs (search boxes, filters).
  // Values may reference env secrets via "$VAR" and are resolved at runtime,
  // never logged. Login is handled separately, off-camera (see recorder.ts).
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string(), note: z.string().optional() }),
]);
export type Action = z.infer<typeof ActionSchema>;

// ---- Beats: one reviewable/replaceable clip each --------------------------

export const BeatSchema = z.object({
  id: z.string().min(1),
  caption: z.string(), // burned in over this clip (may be "" if captions off)
  actions: z.array(ActionSchema).min(1),
  maxDurationSec: z.number().positive().default(20), // safety cap per clip
  leadTrimSec: z.number().min(0).default(0.4), // trim initial blank/nav frames
});
export type Beat = z.infer<typeof BeatSchema>;

// ---- Auth config: how to log in (off-camera). Selectors are config, not code
export const AuthConfigSchema = z.object({
  loginUrl: z.string().url(),
  usernameSelector: z.string(),
  passwordSelector: z.string(),
  submitSelector: z.string(),
  // secret env var names, e.g. "NEO_USERNAME"; resolved at runtime only
  usernameEnv: z.string().default("NEO_USERNAME"),
  passwordEnv: z.string().default("NEO_PASSWORD"),
  // signal that login succeeded: either a URL substring or a post-login selector
  successUrlIncludes: z.string().optional(),
  successSelector: z.string().optional(),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const StoryboardSchema = z.object({
  spec: VideoSpecSchema,
  auth: AuthConfigSchema,
  beats: z.array(BeatSchema).min(1),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---- Run state: the local stand-in for a Convex row -----------------------

export type RunStatus =
  | "recording"
  | "pending_review"
  | "assembling"
  | "delivered"
  | "failed";

export interface ClipRecord {
  beatId: string;
  caption: string;
  rawPath: string; // .webm captured by Playwright
  durationSec?: number;
  approved: boolean | null; // null = awaiting human decision
  rejectionReason?: string;
}

export interface RunState {
  runId: string;
  spec: VideoSpec;
  status: RunStatus;
  clips: ClipRecord[];
  finalPath?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
