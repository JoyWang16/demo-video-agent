import fs from "node:fs";
import path from "node:path";
import { NeoClient } from "./neo.ts";
import { NeoRestClient } from "./neo-rest.ts";
import { DATA_DIR, ensureDirs } from "../config.ts";

/**
 * Exploration = build a structured inventory of the org from the Neo MCP so a
 * later stage can decide WHAT to demo. No model calls, no cost, read-only.
 */

const PER_PROJECT_READS = [
  "get_project_profile",
  "list_project_scans",
  "list_redteam_runs",
  "list_bias_runs",
  "list_pentest_scans",
  "list_compliance_audits",
] as const;

export const INVENTORY_PATH = path.join(DATA_DIR, "inventory.json");

// Per-project READ-ONLY eval collections probed over REST (label -> API path).
// Each is listed with ?projectId=; counts feed the generator's "what exists".
const REST_EVAL_COLLECTIONS: { label: string; path: string }[] = [
  { label: "redteam", path: "redteam/runs" },
  { label: "owaspllm", path: "owaspllm/runs" },
  { label: "bias", path: "bias/runs" },
  { label: "pentest", path: "pentest/scans" },
  { label: "compliance", path: "compliance/audits" },
  { label: "finops", path: "finops/runs" },
  { label: "agentObservability", path: "agent-observability/runs" },
];

/** `explore --rest [--full]`: build inventory from the read-only REST API and
 * write data/inventory.json in the SAME shape the generator already consumes. */
export async function exploreInventoryRest(opts: { full?: boolean } = {}): Promise<string> {
  ensureDirs();
  const neo = new NeoRestClient();
  const inventory: {
    generatedAt: string;
    source: string;
    org: unknown;
    projects: any[];
  } = { generatedAt: new Date().toISOString(), source: "rest", org: null, projects: [] };

  const ping = await neo.ping();
  inventory.org = { scope: ping.scope, orgName: ping.orgName, projectId: ping.projectId };

  const projects = await neo.listProjects();
  console.log(`  Found ${projects.length} project(s).`);

  for (const p of projects) {
    const entry: any = { id: p.id, name: p.name, description: p.description };
    if (opts.full) {
      const evalTypes: string[] = [];
      const runs: Record<string, number> = {};
      for (const c of REST_EVAL_COLLECTIONS) {
        try {
          const items = await neo.listEval(c.path, p.id);
          if (items.length > 0) {
            evalTypes.push(c.label);
            runs[c.label] = items.length;
          }
        } catch (e) {
          (entry.errors ??= {})[c.label] = (e as Error).message;
        }
      }
      entry.evalTypes = evalTypes;
      entry.runs = runs;
      try {
        entry.profiles = (await neo.listProfiles(p.id)).slice(0, 5);
      } catch (e) {
        (entry.errors ??= {})["profiles"] = (e as Error).message;
      }
    }
    inventory.projects.push(entry);
  }

  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2), "utf8");
  console.log(`  Inventory -> ${path.relative(process.cwd(), INVENTORY_PATH)} (${inventory.projects.length} projects, source=rest).`);
  return INVENTORY_PATH;
}

/** `explore --tools`: just print the server's tool catalog (pure discovery). */
export async function exploreTools(): Promise<void> {
  const neo = new NeoClient();
  await neo.connect();
  try {
    const tools = await neo.listTools();
    console.log(`\n  Neo MCP exposes ${tools.length} tool(s):\n`);
    for (const t of tools) {
      const kind = neo.isReadOnly(t.name) ? "read " : "WRITE";
      const desc = t.description ? " — " + t.description.replace(/\s+/g, " ").slice(0, 90) : "";
      console.log(`   [${kind}] ${t.name}${desc}`);
    }
    console.log(`\n  Only [read ] tools are ever callable by explore.`);
  } finally {
    await neo.close();
  }
}

function toArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  const o = v as Record<string, unknown> | null;
  for (const k of ["items", "projects", "data", "results"]) {
    if (o && Array.isArray(o[k])) return o[k] as any[];
  }
  return v ? [v] : [];
}

/** `explore [--full]`: list projects (+ per-project governance artifacts when
 * --full) and write data/inventory.json. Per-call errors are captured, not
 * fatal — so the first run also reveals exact tool arg shapes. */
export async function exploreInventory(opts: { full?: boolean } = {}): Promise<string> {
  ensureDirs();
  const neo = new NeoClient();
  await neo.connect();
  const inventory: {
    generatedAt: string;
    org: unknown;
    tools: { name: string; readOnly: boolean }[];
    projects: any[];
  } = { generatedAt: new Date().toISOString(), org: null, tools: [], projects: [] };

  try {
    const tools = await neo.listTools();
    inventory.tools = tools.map((t) => ({ name: t.name, readOnly: neo.isReadOnly(t.name) }));

    if (neo.hasTool("whoami")) {
      try { inventory.org = await neo.read("whoami"); } catch { /* optional */ }
    }

    const projects = neo.hasTool("list_projects") ? toArray(await neo.read("list_projects")) : [];
    console.log(`  Found ${projects.length} project(s).`);

    for (const p of projects) {
      const id = (p.id ?? p.projectId ?? p._id) as string | undefined;
      const entry: any = { id, name: p.name, description: p.description };
      if (opts.full && id) {
        for (const tool of PER_PROJECT_READS) {
          if (!neo.hasTool(tool)) continue;
          const key = neo.projectArgName(tool) ?? "projectId";
          try {
            const r = await neo.read(tool, { [key]: id });
            if (tool === "get_project_profile") entry.profile = r;
            else {
              const arr = toArray(r);
              entry[tool.replace(/^list_/, "")] = { count: arr.length, items: arr.slice(0, 15) };
            }
          } catch (e) {
            (entry.errors ??= {})[tool] = (e as Error).message;
          }
        }
      }
      inventory.projects.push(entry);
    }
  } finally {
    await neo.close();
  }

  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2), "utf8");
  console.log(`  Inventory -> ${path.relative(process.cwd(), INVENTORY_PATH)} (${inventory.projects.length} projects, ${inventory.tools.length} tools).`);
  return INVENTORY_PATH;
}
