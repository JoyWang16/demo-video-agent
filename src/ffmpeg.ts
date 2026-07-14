import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const pexec = promisify(execFile);

export async function run(bin: string, args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr } = await pexec(bin, args, { maxBuffer: 1024 * 1024 * 64, cwd });
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

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const rem = cs % 100;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h}:${p(m)}:${p(s)}.${p(rem)}`;
}

/**
 * Write a styled ASS subtitle with one caption cue spanning the clip. Styling
 * lives inside the file (BorderStyle=3 = opaque box, Alignment=2 = bottom
 * centre), so the ffmpeg `subtitles` filter needs NO force_style — which avoids
 * the comma/escaping bugs that plague force_style in a filter chain.
 */
export function writeAss(file: string, caption: string, startSec: number, endSec: number, width: number, height: number) {
  const fontSize = Math.max(18, Math.round(height * 0.045));
  const marginV = Math.round(height * 0.06);
  const text = caption.trim().replace(/\r?\n/g, "\\N").replace(/[{}]/g, "");
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,3,6,0,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${assTime(startSec)},${assTime(endSec)},Default,,0,0,0,,${text}
`;
  fs.writeFileSync(file, ass, "utf8");
}

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
  captionStartSec?: number; // when the caption appears within the clip (after actions settle)
  workDir: string;
}): Promise<void> {
  const { input, output, width, height, fps = 30, leadTrimSec = 0, caption, captionStartSec = 0, workDir } = opts;
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
    const assName = `${path.parse(output).name}.ass`; // e.g. b1-catalog.ass (single dot)
    // Caption appears only from captionStartSec (once the page has settled after
    // this beat's actions) to the end of the clip — never over a loading screen.
    const start = Math.min(Math.max(0, captionStartSec - leadTrimSec), Math.max(0, effectiveDur - 0.3));
    writeAss(path.join(workDir, assName), caption, start, effectiveDur, width, height);
    // Reference the subtitle by BASENAME, single-quoted, with cwd=workDir. This
    // is the form ffmpeg's filtergraph parser (incl. the stricter v7/v8 parser)
    // accepts: no slashes/colons/commas, value quoted.
    vf.push(`subtitles='${assName}'`);
  }

  args.push(
    "-vf", vf.join(","),
    "-an", // no audio in v0
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    output
  );
  await run("ffmpeg", args, workDir);
}

/** Concatenate uniform mp4 clips (concat demuxer, stream copy). */
export async function concat(clips: string[], output: string, workDir: string): Promise<void> {
  const list = path.join(workDir, "concat.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
}

/** Cut a segment [startSec, startSec+durationSec) from a video, re-encoded for
 * frame-accurate boundaries (used to split the continuous take into beat clips). */
export async function cutClip(input: string, output: string, startSec: number, durationSec: number): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-ss", startSec.toFixed(3),
    "-i", input,
    "-t", Math.max(0.1, durationSec).toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an",
    output,
  ]);
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
