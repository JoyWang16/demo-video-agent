import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const pexec = promisify(execFile);

export async function run(bin: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await pexec(bin, args, { maxBuffer: 1024 * 1024 * 64 });
  return stdout || stderr;
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
}

export async function probe(file: string): Promise<MediaInfo> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const json = JSON.parse(out);
  const v = (json.streams ?? []).find((s: any) => s.codec_type === "video");
  return {
    durationSec: parseFloat(json.format?.duration ?? "0"),
    width: v ? Number(v.width) : 0,
    height: v ? Number(v.height) : 0,
    hasVideo: Boolean(v),
  };
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(rem, 3)}`;
}

/** One caption cue spanning the whole clip. */
export function writeSrt(file: string, caption: string, durationSec: number) {
  const body = `1\n${srtTime(0)} --> ${srtTime(durationSec)}\n${caption}\n`;
  fs.writeFileSync(file, body, "utf8");
}

const CAPTION_STYLE =
  "FontName=DejaVu Sans,Fontsize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
  "BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=28";

/**
 * Normalize one clip to uniform mp4 (h264), scaled/padded to target size,
 * fixed fps, optional lead-trim, and burned-in captions. Uniform output means
 * clips concat cleanly afterward.
 */
export async function processClip(opts: {
  input: string;
  output: string;
  width: number;
  height: number;
  fps?: number;
  leadTrimSec?: number;
  caption?: string; // undefined/empty => no captions
  workDir: string;
}): Promise<void> {
  const { input, output, width, height, fps = 30, leadTrimSec = 0, caption, workDir } = opts;
  const info = await probe(input);
  const effectiveDur = Math.max(0.1, info.durationSec - leadTrimSec);

  const vf: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
  ];

  const args: string[] = ["-y"];
  if (leadTrimSec > 0) args.push("-ss", String(leadTrimSec));
  args.push("-i", input);

  if (caption && caption.trim()) {
    const srt = path.join(workDir, `${path.basename(output)}.srt`);
    writeSrt(srt, caption.trim(), effectiveDur);
    // escape for ffmpeg filter argument
    const esc = srt.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf.push(`subtitles='${esc}':force_style='${CAPTION_STYLE}'`);
  }

  args.push(
    "-vf", vf.join(","),
    "-an", // no audio in v0
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    output
  );
  await run("ffmpeg", args);
}

/** Concatenate uniform mp4 clips (concat demuxer, stream copy). */
export async function concat(clips: string[], output: string, workDir: string): Promise<void> {
  const list = path.join(workDir, "concat.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
}

/** Extract N evenly-spaced frames as PNGs (used by the evaluator). */
export async function sampleFrames(video: string, n: number, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await probe(video);
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (info.durationSec * (i + 0.5)) / n;
    const out = path.join(outDir, `frame_${i}.png`);
    await run("ffmpeg", ["-y", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", out]);
    paths.push(out);
  }
  return paths;
}
