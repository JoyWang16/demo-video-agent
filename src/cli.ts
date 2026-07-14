import { startRun, resumeRun } from "./orchestrator.ts";
import { loadState } from "./runstate.ts";
import { evaluateVideo, printScorecard } from "./eval/evaluate.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function list(flag: string): string[] {
  const v = arg(flag);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "run": {
      const storyboard = arg("--storyboard");
      if (!storyboard) throw new Error("usage: run --storyboard <file>");
      await startRun(storyboard);
      break;
    }
    case "resume": {
      const runId = arg("--run");
      if (!runId) throw new Error("usage: resume --run <runId> [--approve-all] [--approve a,b] [--reject c]");
      await resumeRun(runId, {
        approveAll: has("--approve-all"),
        approve: list("--approve"),
        reject: list("--reject"),
      });
      break;
    }
    case "evaluate": {
      const runId = arg("--run");
      const video = arg("--video");
      if (runId) {
        const s = loadState(runId);
        if (!s.finalPath) throw new Error(`Run ${runId} has no delivered video yet.`);
        printScorecard(await evaluateVideo(s.finalPath, s.spec));
      } else if (video) {
        // ad-hoc: evaluate any file against a target length
        const target = Number(arg("--target") ?? "60");
        printScorecard(
          await evaluateVideo(video, {
            id: "adhoc", title: "adhoc", description: "adhoc", feature: "adhoc",
            targetLengthSec: target, tolerancePct: 0.25, captions: true,
            resolution: { width: 1280, height: 720 },
          })
        );
      } else {
        throw new Error("usage: evaluate (--run <runId> | --video <file> [--target <sec>])");
      }
      break;
    }
    default:
      console.log("Commands:\n  run --storyboard <file>\n  resume --run <id> [--approve-all|--approve a,b|--reject c]\n  evaluate (--run <id> | --video <file> [--target <sec>])");
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
