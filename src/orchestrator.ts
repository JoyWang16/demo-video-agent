import path from "node:path";
import fs from "node:fs";
import { loadStoryboard, validateStoryboard } from "./storyboard.ts";
import { recordStoryboard } from "./recorder.ts";
import { processClip, concat } from "./ffmpeg.ts";
import { deliver } from "./deliver.ts";
import { evaluateVideo, printScorecard, writeScorecard } from "./eval/evaluate.ts";
import { writeReviewFile, applyDecisions, reviewSummary } from "./review.ts";
import { saveState, loadState, newRunId } from "./runstate.ts";
import { ensureDirs, runDir } from "./config.ts";
import type { RunState } from "./types.ts";

/** STAGE 1–3: validate -> record clips -> pause at the human review gate. */
export async function startRun(storyboardFile: string): Promise<RunState> {
  ensureDirs();
  const sb = loadStoryboard(storyboardFile);

  const v = validateStoryboard(sb);
  v.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
  if (!v.ok) {
    v.errors.forEach((e) => console.error(`  ✗ ${e}`));
    throw new Error("Storyboard failed validation; refusing to record.");
  }

  const runId = newRunId(sb.spec.id);
  const dir = runDir(runId);
  const state: RunState = {
    runId, spec: sb.spec, status: "recording", clips: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  saveState(state);

  console.log(`\n▶ Recording ${sb.beats.length} beat(s) for "${sb.spec.title}" (run ${runId})`);
  try {
    const clips = await recordStoryboard(sb, dir);
    state.clips = clips.map((c) => ({
      beatId: c.beatId, caption: c.caption, rawPath: c.rawPath, approved: null,
    }));
    state.status = "pending_review";
    saveState(state);
  } catch (err) {
    state.status = "failed";
    state.error = (err as Error).message;
    saveState(state);
    throw err;
  }

  const reviewFile = writeReviewFile(state);
  console.log(`\n⏸ PENDING REVIEW. Raw clips are in ${path.relative(process.cwd(), path.join(dir, "clips"))}/`);
  console.log(`   Watch them, then approve. Either edit ${path.relative(process.cwd(), reviewFile)}`);
  console.log(`   (set "approved": true/false per clip), or re-run with --approve-all.`);
  console.log(`   Then: npm run resume -- --run ${runId} --approve-all`);
  return state;
}

/** STAGE 4–6: apply review decisions -> assemble approved clips -> deliver -> evaluate. */
export async function resumeRun(
  runId: string,
  opts: { approveAll?: boolean; approve?: string[]; reject?: string[] }
): Promise<RunState> {
  let state = loadState(runId);
  if (state.status !== "pending_review" && state.status !== "assembling") {
    throw new Error(`Run ${runId} is '${state.status}', not awaiting review.`);
  }
  state = applyDecisions(state, opts);
  saveState(state);

  const { approved, rejected, undecided } = reviewSummary(state);
  if (undecided.length) {
    console.log(`  ⏸ Still undecided: ${undecided.join(", ")}. Approve/reject them first.`);
    return state;
  }
  if (rejected.length) {
    console.log(`  ✗ Rejected beats: ${rejected.join(", ")}. Re-record these before assembly.`);
    console.log(`    (v0: rejected clips block assembly. Replace the .webm or re-run the beat.)`);
    return state;
  }
  if (!approved.length) throw new Error("No approved clips to assemble.");

  state.status = "assembling";
  saveState(state);

  const dir = runDir(runId);
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const { width, height } = state.spec.resolution;

  console.log(`\n▶ Assembling ${approved.length} approved clip(s) with captions...`);
  const processed: string[] = [];
  for (const beatId of approved) {
    const clip = state.clips.find((c) => c.beatId === beatId)!;
    const out = path.join(workDir, `${beatId}.mp4`);
    await processClip({
      input: clip.rawPath, output: out, width, height,
      caption: state.spec.captions ? clip.caption : undefined,
      workDir,
    });
    processed.push(out);
  }
  const assembled = path.join(workDir, "assembled.mp4");
  await concat(processed, assembled, workDir);

  const finalPath = await deliver(state, assembled);
  state.finalPath = finalPath;
  state.status = "delivered";
  saveState(state);
  console.log(`\n✓ Delivered: ${path.relative(process.cwd(), finalPath)}`);

  const sc = await evaluateVideo(finalPath, state.spec);
  printScorecard(sc);
  writeScorecard(sc, dir);
  return state;
}
