import { neoRest } from "../config.ts";

/**
 * Read-only Neo REST client (comprehension layer). Separate from the MCP client
 * in neo.ts. By construction this exposes ONLY GET requests — there is no
 * post/patch/delete method here, so the pipeline structurally cannot create,
 * run, or mutate anything via REST (matches the read-only guardrail).
 *
 * The Neo write endpoints (POST /api/<eval>/runs, POST /api/projects,
 * POST /api/project-profiles, ...) launch real, billable jobs or mutate the org.
 * They are deliberately NOT modelled here. If a one-off registration is ever
 * needed, do it manually (a single explicit curl), never from this pipeline.
 */

export interface NeoProject {
  id: string;
  name: string;
  description?: string;
  createdAt?: number;
}

export class NeoRestClient {
  private base: string;
  private token: string;

  constructor() {
    if (!neoRest.token) {
      throw new Error("NEO_REST_TOKEN is not set. Put your Neo REST API key in .env (see .env.example).");
    }
    this.base = neoRest.url.replace(/\/+$/, "");
    this.token = neoRest.token;
  }

  /** The ONLY transport method — GET, with the Bearer header. */
  private async get<T>(pathAndQuery: string): Promise<T> {
    const res = await fetch(`${this.base}${pathAndQuery}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) msg += ` ${body.error}`;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`GET ${pathAndQuery} failed: ${msg}`);
    }
    return (await res.json()) as T;
  }

  /** Scope/workspace of the key. */
  ping(): Promise<{ ok: boolean; scope: string; orgName?: string; projectId?: string | null }> {
    return this.get("/api/ping");
  }

  /** Platform-scope only: all projects in the org. */
  async listProjects(): Promise<NeoProject[]> {
    const { projects } = await this.get<{ projects: NeoProject[] }>("/api/projects");
    return projects ?? [];
  }

  async listProfiles(projectId: string): Promise<unknown[]> {
    const { profiles } = await this.get<{ profiles: unknown[] }>(
      `/api/project-profiles?projectId=${encodeURIComponent(projectId)}`
    );
    return profiles ?? [];
  }

  /** Generic list for a per-project eval collection, e.g. "redteam/runs",
   * "bias/runs", "pentest/scans", "owaspllm/runs", "compliance/audits". Returns
   * the first array found in the response, or []. Read-only. */
  async listEval(collectionPath: string, projectId: string): Promise<unknown[]> {
    const data = await this.get<Record<string, unknown>>(
      `/api/${collectionPath}?projectId=${encodeURIComponent(projectId)}`
    );
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k])) return data[k] as unknown[];
    }
    return [];
  }
}
