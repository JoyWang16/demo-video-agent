/**
 * Comprehension layer. The Neo MCP is an API client returning structured JSON
 * about what exists to demo (projects, profiles, scans, audits, etc.).
 *
 * GUARDRAIL: only READ tools are modelled here. The MCP also exposes WRITE
 * tools (run_project_scan, create_pentest_scan, create_redteam_run, ...) that
 * launch real, billable async jobs against live targets. Those are deliberately
 * NOT part of this interface. If a future feature needs them, they go behind an
 * explicit human-approval gate, never inside an automated recording/scripting
 * path.
 *
 * v0 does not require a live MCP connection: you can hand-author storyboards.
 * Wire a real client here (via your MCP host / the AI SDK's MCP support) when
 * you want storyboards generated from live app data.
 */

export interface NeoProject {
  id: string;
  name: string;
  description?: string;
}

export interface NeoComprehension {
  listProjects(): Promise<NeoProject[]>;
  getProjectProfile(projectId: string): Promise<unknown>;
  listProjectScans(projectId: string): Promise<unknown[]>;
  // add further READ-only surfaces as needed: pentest/redteam/bias/compliance
}

/** Placeholder so the pipeline type-checks and runs without live credentials. */
export class UnconfiguredNeoClient implements NeoComprehension {
  async listProjects(): Promise<NeoProject[]> {
    throw new Error(
      "Neo MCP client not configured. Hand-author a storyboard for v0, or wire a real read-only client here."
    );
  }
  async getProjectProfile(): Promise<unknown> {
    throw new Error("Neo MCP client not configured.");
  }
  async listProjectScans(): Promise<unknown[]> {
    throw new Error("Neo MCP client not configured.");
  }
}
