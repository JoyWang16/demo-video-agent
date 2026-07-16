import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { neoMcp } from "../config.ts";

/**
 * Comprehension layer. The Neo MCP is an API client that returns structured
 * JSON about what exists to demo (projects, profiles, scans, red-team/bias
 * runs, compliance audits). This client is deliberately READ-ONLY.
 *
 * GUARDRAIL: `read()` refuses any tool that isn't list_/get_/detect_/whoami.
 * The MCP's write tools (run_project_scan, create_pentest_scan,
 * create_redteam_run, ...) launch real, billable async jobs and are never
 * callable from here. If a future feature needs them, they go behind an
 * explicit human-approval gate, never inside exploration/scripting.
 */

const READ_ONLY = /^(list_|get_|detect_|whoami)/;

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class NeoClient {
  private client: Client;
  private connected = false;
  private tools = new Map<string, ToolInfo>();

  constructor() {
    this.client = new Client({ name: "demo-video-agent", version: "0.0.1" });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!neoMcp.url) {
      throw new Error("NEO_MCP_URL is not set. Put your Neo MCP endpoint in .env (see .env.example).");
    }
    const url = new URL(neoMcp.url);
    const requestInit = neoMcp.token ? { headers: { Authorization: `Bearer ${neoMcp.token}` } } : undefined;
    const transport =
      neoMcp.transport === "sse"
        ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
        : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
    await this.client.connect(transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  async listTools(): Promise<ToolInfo[]> {
    const res = await this.client.listTools();
    const tools = res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    this.tools = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  isReadOnly(name: string): boolean {
    return READ_ONLY.test(name);
  }

  /** Call a READ-ONLY tool; refuse anything mutating. Returns parsed JSON if the
   * tool result is JSON text, else the raw text/result. */
  async read(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!READ_ONLY.test(name)) {
      throw new Error(`Refused: '${name}' is not read-only (only list_/get_/detect_/whoami are allowed).`);
    }
    const res = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const blocks = Array.isArray(res.content) ? res.content : [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (!text) return res;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Infer the project-id argument name for a per-project tool from its schema,
   * so we pass the right key even if it's projectId / project_id / id. */
  projectArgName(toolName: string): string | undefined {
    const schema = this.tools.get(toolName)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    const keys = Object.keys(schema?.properties ?? {});
    return keys.find((k) => /^(project_?id|id)$/i.test(k)) ?? keys.find((k) => /project/i.test(k));
  }
}
