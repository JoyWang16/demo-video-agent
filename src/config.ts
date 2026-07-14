import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const OUTPUTS_DIR = path.join(ROOT, "outputs");
export const MANIFEST_CSV = path.join(OUTPUTS_DIR, "manifest.csv");

export function ensureDirs() {
  for (const d of [DATA_DIR, RUNS_DIR, OUTPUTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function runDir(runId: string) {
  return path.join(RUNS_DIR, runId);
}

/** Run headful when you need to watch/debug; default headless for capture. */
export const HEADFUL = process.env.HEADFUL === "1";

/**
 * Resolve a storyboard value that may reference a secret env var as "$NAME".
 * Secrets are only ever read here, at execution time; they are never persisted
 * to run state, logs, or the manifest.
 */
export function resolveSecret(value: string): string {
  if (value.startsWith("$")) {
    const name = value.slice(1);
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var referenced by storyboard: ${name}`);
    return v;
  }
  return value;
}

export const azureEnv = {
  resourceName: process.env.AZURE_RESOURCE_NAME,
  apiKey: process.env.AZURE_API_KEY,
  deployment: process.env.AZURE_DEPLOYMENT, // e.g. gpt-4o deployment name
  visionDeployment: process.env.AZURE_VISION_DEPLOYMENT ?? process.env.AZURE_DEPLOYMENT,
};
