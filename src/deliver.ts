import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./types.ts";
import { MANIFEST_CSV, OUTPUTS_DIR, ensureDirs } from "./config.ts";
import { probe } from "./ffmpeg.ts";

const COLUMNS = [
  "id",
  "title",
  "feature",
  "description",
  "recorded_date",
  "length_sec",
  "captions",
  "resolution",
  "status",
  "local_path",
  "sharepoint_url",
] as const;

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Deliver the finished video: copy into outputs/ and append one row to the CSV.
 * The CSV is an *export* of run metadata, not a second source of truth — in the
 * Convex version it is generated from the runs table on demand.
 * SharePoint upload (via the Microsoft 365 / Graph MCP) is a later hook; the
 * column exists now so the schema is stable.
 */
export async function deliver(state: RunState, assembledPath: string): Promise<string> {
  ensureDirs();
  const ext = path.extname(assembledPath) || ".mp4";
  const finalName = `${state.spec.id}${ext}`;
  const finalPath = path.join(OUTPUTS_DIR, finalName);
  fs.copyFileSync(assembledPath, finalPath);

  const info = await probe(finalPath);
  const row: Record<string, string> = {
    id: state.spec.id,
    title: state.spec.title,
    feature: state.spec.feature,
    description: state.spec.description,
    recorded_date: new Date().toISOString(),
    length_sec: info.durationSec.toFixed(1),
    captions: String(state.spec.captions),
    resolution: `${state.spec.resolution.width}x${state.spec.resolution.height}`,
    status: "delivered",
    local_path: finalPath,
    sharepoint_url: "", // filled when the Graph upload hook is enabled
  };

  const line = COLUMNS.map((c) => csvEscape(row[c] ?? "")).join(",") + "\n";
  if (!fs.existsSync(MANIFEST_CSV)) {
    fs.writeFileSync(MANIFEST_CSV, COLUMNS.join(",") + "\n", "utf8");
  }
  fs.appendFileSync(MANIFEST_CSV, line, "utf8");
  return finalPath;
}
