import { startRun, resumeRun } from "./orchestrator.ts";
import { manualLogin } from "./login.ts";
import { exploreTools, exploreInventory, exploreInventoryRest } from "./comprehension/explore.ts";
import { probeAct } from "./probe-act.ts";
import { generateStoryboard } from "./comprehension/storyboard-gen.ts";
import { GenerationSpecSchema } from "./types.ts";
import fs from "node:fs";
import path from "node:path";
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
    case "probe-act": {
      const url = arg("--url");
      const intent = arg("--intent");
      if (!url || !intent) throw new Error('usage: probe-act --url <url> --intent "<natural language action>"');
      await probeAct(url, intent);
      break;
    }
    case "generate": {
      const specPath = arg("--spec");
      if (!specPath) throw new Error("usage: generate --spec <spec.json> [--inventory <inventory.json>]");
      const spec = GenerationSpecSchema.parse(JSON.parse(fs.readFileSync(specPath, "utf8")));
      const inventoryPath = arg("--inventory") ?? path.join(process.cwd(), "data", "inventory.json");
      const { storyboard, outPath, warnings } = await generateStoryboard(spec, inventoryPath);
      warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
      console.log(`\n✓ Generated storyboard -> ${path.relative(process.cwd(), outPath)}`);
      console.log(`  "${storyboard.spec.title}" — ${storyboard.beats.length} beats`);
      for (const b of storyboard.beats) console.log(`   ${b.id}: ${b.caption}`);
      console.log(`\n  Review it, tweak if needed, then record:`);
      console.log(`    npm run cli -- run --storyboard ${path.relative(process.cwd(), outPath)}`);
      break;
    }
    case "explore": {
      if (has("--tools")) await exploreTools();
      else if (has("--rest")) await exploreInventoryRest({ full: has("--full") });
      else await exploreInventory({ full: has("--full") });
      break;
    }
    case "login": {
      const storyboard = arg("--storyboard");
      if (!storyboard) throw new Error("usage: login --storyboard <file>");
      await manualLogin(storyboard);
      break;
    }
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
      console.log("Commands:\n  explore [--tools | --full | --rest [--full]]\n  generate --spec <spec.json> [--inventory <file>]\n  login --storyboard <file>\n  probe-act --url <url> --intent \"<action>\"\n  run --storyboard <file>\n  resume --run <id> [--approve-all|--approve a,b|--reject c]\n  evaluate (--run <id> | --video <file> [--target <sec>])");
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
