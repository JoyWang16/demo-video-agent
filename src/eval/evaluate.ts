import fs from "node:fs";
import path from "node:path";
import type { VideoSpec } from "../types.ts";
import { probe, run } from "../ffmpeg.ts";

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  severity: "hard" | "soft"; // hard = gate; soft = warning only
}

export interface Scorecard {
  specId: string;
  video: string;
  passed: boolean; // all hard checks pass
  checks: Check[];
  metrics: Record<string, number | string>;
  evaluatedAt: string;
}

// --- individual checks ------------------------------------------------------

async function checkPlayable(video: string): Promise<Check> {
  try {
    const info = await probe(video);
    const ok = info.hasVideo && info.durationSec > 0;
    return { name: "playable", severity: "hard", pass: ok,
      detail: ok ? `video stream, ${info.durationSec.toFixed(1)}s` : "no valid video stream" };
  } catch (e) {
    return { name: "playable", severity: "hard", pass: false, detail: (e as Error).message };
  }
}

async function checkDuration(video: string, spec: VideoSpec): Promise<Check> {
  const info = await probe(video);
  const lo = spec.targetLengthSec * (1 - spec.tolerancePct);
  const hi = spec.targetLengthSec * (1 + spec.tolerancePct);
  const ok = info.durationSec >= lo && info.durationSec <= hi;
  return { name: "duration_in_tolerance", severity: "hard", pass: ok,
    detail: `${info.durationSec.toFixed(1)}s vs target ${spec.targetLengthSec}s [${lo.toFixed(1)}–${hi.toFixed(1)}]` };
}

async function checkResolution(video: string, spec: VideoSpec): Promise<Check> {
  const info = await probe(video);
  const ok = info.width === spec.resolution.width && info.height === spec.resolution.height;
  return { name: "resolution_matches", severity: "hard", pass: ok,
    detail: `${info.width}x${info.height} vs ${spec.resolution.width}x${spec.resolution.height}` };
}

/** Fail if a large fraction of the video is black (blank capture). */
async function checkNotBlank(video: string): Promise<Check> {
  const info = await probe(video);
  const out = await run("ffmpeg", ["-i", video, "-vf", "blackdetect=d=0.5:pic_th=0.98", "-an", "-f", "null", "-"]);
  const black = [...out.matchAll(/black_duration:(\d+(?:\.\d+)?)/g)].reduce((s, m) => s + parseFloat(m[1]!), 0);
  const frac = info.durationSec > 0 ? black / info.durationSec : 1;
  const ok = frac < 0.5;
  return { name: "not_mostly_black", severity: "hard", pass: ok,
    detail: `${(frac * 100).toFixed(0)}% black` };
}

/** Warn if the video appears frozen for long stretches (nothing happening). */
async function checkNotFrozen(video: string): Promise<Check> {
  const info = await probe(video);
  const out = await run("ffmpeg", ["-i", video, "-vf", "freezedetect=n=0.003:d=2", "-an", "-f", "null", "-"]);
  const freeze = [...out.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)].reduce((s, m) => s + parseFloat(m[1]!), 0);
  const frac = info.durationSec > 0 ? freeze / info.durationSec : 0;
  const ok = frac < 0.6;
  return { name: "not_mostly_frozen", severity: "soft", pass: ok,
    detail: `${(frac * 100).toFixed(0)}% frozen (>2s stretches)` };
}

// --- runner -----------------------------------------------------------------

export async function evaluateVideo(video: string, spec: VideoSpec): Promise<Scorecard> {
  if (!fs.existsSync(video)) throw new Error(`Video not found: ${video}`);
  const checks: Check[] = [];
  checks.push(await checkPlayable(video));
  // only run the rest if the file is playable
  if (checks[0]!.pass) {
    checks.push(await checkDuration(video, spec));
    checks.push(await checkResolution(video, spec));
    checks.push(await checkNotBlank(video));
    checks.push(await checkNotFrozen(video));
  }
  const info = checks[0]!.pass ? await probe(video) : { durationSec: 0, width: 0, height: 0, hasVideo: false };
  const passed = checks.filter((c) => c.severity === "hard").every((c) => c.pass);

  return {
    specId: spec.id,
    video,
    passed,
    checks,
    metrics: {
      duration_sec: info.durationSec.toFixed(1),
      resolution: `${info.width}x${info.height}`,
      hard_checks_passed: checks.filter((c) => c.severity === "hard" && c.pass).length,
      hard_checks_total: checks.filter((c) => c.severity === "hard").length,
    },
    evaluatedAt: new Date().toISOString(),
  };
}

export function printScorecard(sc: Scorecard): void {
  console.log(`\n  Evaluation — ${sc.specId}  (${sc.passed ? "PASS" : "FAIL"})`);
  for (const c of sc.checks) {
    const mark = c.pass ? "✓" : c.severity === "hard" ? "✗" : "!";
    console.log(`   ${mark} ${c.name.padEnd(24)} ${c.detail}`);
  }
}

export function writeScorecard(sc: Scorecard, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "scorecard.json");
  fs.writeFileSync(p, JSON.stringify(sc, null, 2), "utf8");
  return p;
}
