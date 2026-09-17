# hai-neo API

Authenticated by Bearer token. The token can be **platform-scoped** (account-level) or **project-scoped**.

```
Authorization: Bearer <api-key>
```

Mint keys from the dashboard (Settings → Platform API Keys for account keys; the
project detail page for project keys).

Errors are JSON: every non-2xx response has the body
`{ "error": "<message>" }` with status 400 (bad request), 401 (bad/missing
key), 403 (out of scope), or 404 (not found).

## Endpoints

### GET /api/ping
Returns `{ ok, scope, userId, orgId, orgName, projectId }`. Use it to
discover the scope and workspace of the key.

### GET /api/projects (platform scope only)
Returns `{ projects: [{ id, name, description, createdAt }] }`.

### POST /api/projects (platform or repo scope)
Body: `{ name: string, description?: string, repoSourceKey?: string, repoSubpath?: string }`.
Returns `{ project: { id, name, description, orgId, orgName } }` (201).
This does NOT return a key — follow up with `POST /api/projects/:id/keys`
to mint one. `repoSourceKey` + `repoSubpath` bind the project into a monorepo
group as a component (see the Monorepo section). A repo-scoped key forces its
own `repoSourceKey` (the body value is ignored).

### POST /api/projects/:id/keys (platform scope only)
Mint a fresh project-scoped API key for an existing project. Used by
the MCP's `create_project` flow so a newly created project comes
with a ready-to-use key the agent can drop straight into a `.env`.
Returns `{ key: { id, plaintext, keyPrefix } }` (201) — `plaintext` is
shown only on creation; treat it as a secret.

AGENTS: when provisioning a project over REST, save the returned
`plaintext` to the project's `.env` (upsert `HAI_API_KEY`, alongside
`HAI_API_URL`) — exactly as the MCP `create_project` tool does — and
read the key from there on every later request instead of re-minting or
hard-coding it.

### Monorepo (many projects in one repo)
A repo can host several distinct systems; each becomes its own project, all
sharing a `repoSourceKey` and scoped to a `repoSubpath`. Two ways to split:

- **Auto-detect + accept.** A whole-repo scan of a GitHub-linked root project
  (`POST /api/project-scans` with no subpath) kicks off detection. Then:
  - `GET /api/repos/proposals?projectId=<id>` → `{ proposal: { proposalId, components: [{ subpath, proposedName, detectedSummary, recommendedServices }] } | null }`.
  - `POST /api/repos/split` body `{ proposalId, components?: [{ subpath, name }] }` →
    `{ createdProjectIds }`. Creates one sibling project per component (each
    scoped + auto-scanned); the origin stays the repo-root component.
- **Explicit (no GitHub).** `POST /api/repos/detect-components` body
  `{ paths: string[], label? }` → `{ components }` (stateless), then create each
  with `POST /api/projects` (`repoSourceKey` + `repoSubpath`) and scan with
  `POST /api/project-scans`.

### POST /api/repos/keys (platform scope only)
Body: `{ repoSourceKey: string }`. Mints a repo-scoped key that can create,
scan, and dispatch only for projects sharing that `repoSourceKey` — one
credential at a repo root, contained to the repo. Returns
`{ key: { id, plaintext, keyPrefix, repoSourceKey } }` (201).

### GET /api/project-profiles
Query: `?projectId=<id>` (omitted when using a project-scoped key).
Returns `{ profiles: Profile[] }`.

### POST /api/project-profiles
Body: `{ projectId?, name, description, fields? }`. The submission is
AI peer-reviewed first: critical issues block creation with status 422
and body `{ error: "review_failed", review }`; otherwise returns
`{ profile, review }` (201) — `review` carries any non-blocking notes
(`null` when bypassed with `?force=true`). The platform agent is then
scheduled and populates `agentRanAt` asynchronously.

### GET /api/project-profiles/:id
Returns `{ profile }` or 404.

### GET /api/project-profiles/:id/versions
Returns `{ versions: Version[] }` — every immutable snapshot, newest last.
Each has `{ id, profileId, version, name, description, fields, authorUserId,
createdAt }`.

### GET /api/project-profiles/:id/versions/:n
Returns `{ version }` for snapshot number `n` (1-based) or 404.

### PATCH /api/project-profiles/:id
Body: any subset of `{ name, description, fields }`. Snapshots a new
version and returns `{ profile }`.

### DELETE /api/project-profiles/:id
Deletes the profile and its version history. Returns `{ ok: true }`.

### POST /api/pentest/scans
Body: `{ target, task, projectId?, model?, useBrowser?, durationSec? }`.
`projectId` is required for platform keys, ignored for project keys.
Returns `{ id }`. The scan runs asynchronously on AWS; events stream in real-time.

### GET /api/pentest/scans
Query: `?projectId=<id>` (optional). Returns `{ scans: ScanSummary[] }`.

### GET /api/pentest/scans/:id
Returns `{ scan }` with findings + status.

### Red teaming (adversarial LLM eval)

Adversarial testing of a generative LLM endpoint: the agent runs the
selected attack families (jailbreak, injection, extraction, …) and
returns per-family findings. `apiKey` is the target's credential —
accepted on POST, never returned by any GET.

#### POST /api/redteam/runs
Body: `{ endpoint, apiType, projectId?, model?, apiKey?, systemPrompt?,
agentic?, endpointHints?, families?, durationSec? }`.
`endpoint` must be an http(s) URL; `apiType` is one of
`openai | anthropic | custom_rest | custom_code`. `families` defaults
to the full attack catalogue. Returns `{ id }` (201); runs asynchronously.

#### GET /api/redteam/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/redteam/runs/:id
Returns `{ run }` with status + per-family findings.

### OWASP LLM Top 10 (OWASP Top 10 for LLM Applications, 2025)

Probes a generative LLM endpoint against the OWASP Top 10 for LLM
Applications 2025: the agent runs a probe suite per selected category
(prompt injection, sensitive information disclosure, system prompt
leakage, …) and returns one finding per category. `apiKey` is the
target's credential — accepted on POST, never returned by any GET.

#### POST /api/owaspllm/runs
Body: `{ endpoint, apiType, projectId?, model?, apiKey?, systemPrompt?,
agentic?, endpointHints?, categories?, durationSec? }`.
`endpoint` must be an http(s) URL; `apiType` is one of
`openai | anthropic | custom_rest | custom_code`. `categories` are
slugs like `llm01_prompt_injection` and default to the full Top 10.
Returns `{ id }` (201); runs asynchronously.

#### GET /api/owaspllm/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/owaspllm/runs/:id
Returns `{ run }` with status + per-category findings.

### Bias (cross-demographic fairness eval)

Probes a generative LLM endpoint for demographic bias across protected
dimensions (`gender`, `ethnicity`, `religion`, `age`, `disability`,
`intersectional`, `multilingual`) using the selected methodologies
(`counterfactual`, `benchmark`, `adversarial`, `multilingual`).
One finding per dimension with a disparity score and per-group metrics.

#### POST /api/bias/runs
Body: `{ endpoint, apiType, projectId?, model?, apiKey?, systemPrompt?,
endpointHints?, dimensions?, methodologies?, languages?, customProbes?,
generation?, durationSec? }`.
- `dimensions` defaults to all; `methodologies` defaults to
  `["counterfactual"]`; `languages` are BCP-47 subtags ("en" is the
  baseline and always included).
- `customProbes` is an array of
  `{ dimension, methodology, prompt, group?, stereotypeAnswer?, lang? }`
  appended to the built-in corpus (max 100). For counterfactual, use the
  `{subject}` placeholder to auto-expand across demographic groups.
- `generation` is `{ enabled, strategy?, perCell?, themes? }` —
  an LLM authors fresh probes per dimension at run time. Strategies:
  `theme_seeded | seed_mutate | rainbow`; `perCell` ≤ 6.

Returns `{ id }` (201); runs asynchronously.

#### GET /api/bias/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/bias/runs/:id
Returns `{ run }` with status + per-dimension findings
(disparity score, per-group/per-language metrics, sample transcripts).

### Hallucination and grounding

Measures whether a model states things that are not true, and whether what it
does state is supported by the documents it was given. Runs the selected tests
from the catalogue against your endpoint, grades the answers, and bands each
category against the risk tier read from the intended use.

#### POST /api/hallucination/runs
Body: `{ endpoint, apiType, evals, projectId?, model?, apiKey?, systemPrompt?,
modelLabel?, capabilities?, intendedUse?, riskTier?, domain?, audience?,
weights?, rag?, judgeTier?, concurrency?, durationSec? }`.
- `evals` is required — the test slugs to run, e.g.
  `["truthfulqa","simpleqa","selfcheckgpt"]`. Slugs that cannot run here, or
  whose gate your `capabilities` leave shut, are dropped; if that empties the
  selection the request is rejected rather than silently narrowed.
- `capabilities` is
  `{ retrievalAugmented?, returnsCitations?, inputTypes? }` where
  `inputTypes` is any of `text | image | audio` (defaults to
  `["text"]`). It gates which tests are legal: grounded tests need
  `retrievalAugmented`, citation tests need `returnsCitations`.
- `riskTier` is `low | standard | high | regulated` (defaults to
  `standard`) and sets the target each metric is banded against. Floors
  apply: a regulated `domain` cannot be scored as ordinary production use.
- `weights` is `{ <slug>: number }` — per-test weight inside its category.
  Renormalised over the selection, so any non-negative numbers work.
- `rag` is required for grounded tests and is
  `{ mode, ... }` with mode `client_records | end_to_end | live_retrieve`.
  `client_records` needs `recordsStorageId` (upload first);
  `live_retrieve` needs `retrievalEndpoint` and takes
  `retrievalApiKey?`, `retrievalPassagesPath?`, `topK?` (≤ 20).
- `judgeTier` picks the grading model; defaults from the risk tier.

Returns `{ id }` (201); runs asynchronously.

#### GET /api/hallucination/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/hallucination/runs/:id
Returns `{ run }` with status, per-category findings (metric values, band and
the target they were banded against) and the headline trust index.
`apiKey`, `systemPrompt` and the `rag` block are never returned.

### FinOps (cloud cost analysis)

Read-only cost analysis of a cloud account: the agent runs the selected
cost controls (idle resources, right-sizing, commitment coverage, …) and
returns one finding per control. Connect the account first (AWS read-only
role via the dashboard) or upload a cost export.

#### POST /api/finops/runs
Body: `{ scanTarget, projectId?, cloudConnectionId?, regions?,
costExportStorageId?, context?, analyses?, durationSec? }`.
`scanTarget` is `connected` (use a saved cloud connection —
pass `cloudConnectionId`) or `offline` (use an uploaded cost export —
pass `costExportStorageId`). Returns `{ id }` (201); runs asynchronously.

#### GET /api/finops/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/finops/runs/:id
Returns `{ run }` with status + per-control cost findings.

### Agent observability (trace analysis)

Analyses an uploaded agent trace (OpenTelemetry / framework-native
export) for taint flows, failure localization, and behavioural issues.
Upload the trace file to storage first, then submit its storage id.

#### POST /api/agent-observability/runs
Body: `{ traceStorageId, projectId?, analysis?, sourceFormat?, context?,
durationSec? }`. `analysis` is `taint | localization | full`
(default `full`). Returns `{ id }` (201); runs asynchronously.

#### GET /api/agent-observability/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/agent-observability/runs/:id
Returns `{ run }` with status + findings.

### Agent Behaviour Testing API (counterfactual bias + probes)

Re-run a trace's decisions under counterfactual perturbation: the NYC LL144
four-fifths bias audit + fairness/injection behaviour probes. Upload the trace
to storage first, then submit its storage id.

#### POST /api/agent-behaviour-testing/runs
Body: `{ traceStorageId, projectId?, biasModel?, sourceFormat?, context?,
probeSuite?, endpoint?, apiType?, apiModel?, apiKey?, durationSec? }`.
`biasModel` selects the LL144 scorer (default Haiku); `probeSuite` is
`"default"` or `{ probes: [...] }`. Set `endpoint` (https only) to score the
live agent instead of a stand-in. Returns `{ id }` (201); runs asynchronously.

#### GET /api/agent-behaviour-testing/runs
Query: `?projectId=<id>` (optional). Returns `{ runs: [...] }`.

#### GET /api/agent-behaviour-testing/runs/:id
Returns `{ run }` with status + findings (LL144 impact-ratio tables +
behaviour-probe results).

### Uploads API (get a storageId for run submission)

The run-submission routes take a `traceStorageId` that must already exist in
storage. Use this to obtain one headlessly with your API key.

#### POST /api/uploads
POST the raw file bytes as the request body. Returns `{ storageId }` (201) —
pass it as `traceStorageId` to a `/runs` call. Max 20 MB per upload.

### Control Points API (continuous control monitoring)

Trigger a control monitor to evaluate every control point against your project
documents and score each control's effectiveness against adversarial attacks.

#### GET /api/control-points/monitors
Returns `{ monitors: [...] }` for a project (`?projectId=` required with a
platform key) — each with `id`, `name`, `status`, `controlPointCount`.

#### POST /api/control-points/runs
Triggers a validation cycle. Body: `{ "monitorId": "...", "durationSec"?: number }`.
Returns `{ id }` (the cycle run id). The monitor must be `active`.

#### GET /api/control-points/runs
Lists validation cycles. Query: `?projectId=` (platform key) and optional
`?monitorId=` to filter to one monitor.

#### GET /api/control-points/runs/:id
Returns `{ run }` with per-control findings: each carries a `status`
(pass/fail/warn/n/a/needs_review) and, in `metrics`, the adversarial
`effectiveness` (0–1, = 1 − attack-success-rate), `asr`, and sample probes.

### Control Point Audits (MindBridge methodology — data-driven)

Audit a financial-anomaly control point against labeled test data: upload one CSV
per rubric category, score detection metrics, and roll up a per-criterion
Level 0–3 with an Overall RAG. Each control point is a **subproject** under an
audit-root project — bulk-import a whole engagement by calling this once per
control point.

#### POST /api/control-audits (platform key for `parentProjectId`)
Creates (or reuses) the control point's subproject and starts its audit. Files
are sent **inline** (base64); the server stores them. Body:
```
{
  // pick the subproject — EITHER an existing one:
  "projectId": "<subproject id>",
  // OR create/reuse a child by name under a root (platform key):
  "parentProjectId": "<root project id>", "name": "Unusual Amount",
  "analysisType": "gl",
  "datasets": [
    { "category": "use_case|small_data_changes|edge_cases|dataset_shift",
      "filename": "uc.csv", "contentBase64": "..." }   // or "content": "<raw csv>"
  ],
  "docs": [ { "filename": "card.pdf", "mimeType": "application/pdf", "contentBase64": "..." } ],
  "columns": { "groundTruth": "ground_truth_label", "predictedScore"?: "predicted_score", "idColumn"?: "..." },
  "scoreThreshold"?: 50,
  "targetEndpoint"?: "https://...", "targetApiType"?: "custom_rest|openai|anthropic", "targetApiKey"?: "...",
  "durationSec"?: 900,
  "monitor"?: { "enabled": true, "intervalMinutes": 1440 }   // arm continuous re-checks
}
```
Returns `{ projectId, runId }`. Re-running with the same `parentProjectId`+`name`
reuses the subproject (no duplicate) and adds a fresh audit cycle. Limits: ≤5 MiB
per file, ≤25 MiB and ≤20 files per request. When a `predictedScore` column is
present it's used directly; otherwise rows are scored via `targetEndpoint`.

**Org-level registry path** (platform key): register a control point from the
MindBridge bundle-v.7 catalogue (or reference an existing custom one) and start
a test cycle — no project, no inline files (archetype-covered control points
generate their labelled evaluation data from the registration's pinned seed):
```
{ "scope": "org", "registrationCode": "weekend_post",
  "monitor"?: { "enabled": true, "intervalMinutes"?: 1440 } }
```
Returns `{ registrationId, runId }`. Cycles appear on the Control Points page.

#### GET /api/control-audits
Lists control-audit runs (`?projectId=` with a platform key, or `?scope=org`
for org-level registry cycles).

#### GET /api/control-audits/:id
Returns `{ run }` with one finding per rubric criterion (`controlId` =
criterion, `status`, and `metrics.level` 0–3 + detection accuracy / FPR / FNR).

### Compliance audits

#### GET /api/compliance/frameworks
Returns `{ frameworks: [...] }` — the audit frameworks available
(NYC LL 144, EU AI Act, …) with their control sets.

#### POST /api/compliance/audits
Body: `{ projectId?, profileId, framework, datasetUrl?,
protectedAttributeCol?, predictionCol?, positiveLabel?,
modelEndpointUrl?, endpointHints?, supportingEvidence?, durationSec?,
auditorName?, auditorEmail?, auditorIndependenceAttested?,
candidateNoticeUrl?, candidateNoticePublishedAt?,
candidateNoticeContent? }`. Returns `{ id }` (201).

#### GET /api/compliance/audits
Query: `?projectId=<id>&profileId=<id>` (optional). Returns
`{ audits: [...] }`.

#### GET /api/compliance/audits/:id
Returns `{ audit }` with per-control findings.

#### GET /api/compliance/audits/:id/summary
Returns `{ summary }` — the NYC LL 144 §5-303 public-summary export
(aggregate selection/scoring rates + impact ratios per category, no raw
findings). Available only for **completed LL 144** audits; 404 otherwise.

### ISO 42001 (interactive assessment)

Walks the user through an ISO/IEC 42001:2023 self-assessment in
conversation with a "feedback specialist" agent. The agent reads a
predefined system template (clauses 4–10 + curated Annex A controls)
and elicits evidence for each control. Each assessment is a
long-running chat — clients POST user messages and poll the
assessment to read assistant replies.

#### GET /api/iso42001/template
Returns `{ version, items: [...] }` — the system template the agent
walks through. Each item has `id`, `group`, `title`, `intent`,
`question`, and an `expectedEvidence` list.

#### POST /api/iso42001/assessments
Body: `{ systemName, scopeNote?, projectId?, profileId? }`.
Returns `{ id }`. The agent opens the conversation with its first
question — read it via `GET /api/iso42001/assessments/:id`.

#### GET /api/iso42001/assessments
Query: `?projectId=<id>` (optional). Returns `{ assessments: [...] }`.

#### GET /api/iso42001/assessments/:id
Returns `{ assessment: { ..., findings: [...], messages: [...] } }`.
`findings` always contains one row per template item — even pending
ones — so a single GET renders the full control matrix.

#### POST /api/iso42001/assessments/:id/messages
Body: `{ content }`. Returns `{ ok: true }` with status `202`.
The assistant's reply is generated asynchronously; poll the GET to
read it.

### NIST AI RMF (interactive assessment)

Walks the user through a NIST AI Risk Management Framework (AI 100-1)
self-assessment in conversation with a specialist agent. The agent
reads a predefined system template (curated subcategories across the
GOVERN / MAP / MEASURE / MANAGE functions) and elicits evidence for
each. Same conversational shape as ISO 42001 — clients POST user
messages and poll the assessment to read assistant replies.

#### GET /api/nist/template
Returns `{ version, items: [...] }` — the system template the agent
walks through. Each item has `id` (e.g. `GOVERN 1.1`), `group` (the
function), `title`, `intent`, `question`, and an `expectedEvidence` list.

#### POST /api/nist/assessments
Body: `{ systemName, scopeNote?, projectId?, profileId? }`.
Returns `{ id }`. The agent opens the conversation with its first
question — read it via `GET /api/nist/assessments/:id`.

#### GET /api/nist/assessments
Query: `?projectId=<id>` (optional). Returns `{ assessments: [...] }`.

#### GET /api/nist/assessments/:id
Returns `{ assessment: { ..., findings: [...], messages: [...] } }`.
`findings` always contains one row per template item — even pending
ones — so a single GET renders the full control matrix.

#### POST /api/nist/assessments/:id/messages
Body: `{ content }`. Returns `{ ok: true }` with status `202`.
The assistant's reply is generated asynchronously; poll the GET to
read it.

### Reports (project scope only)

Reports live at the project level. The endpoints below require a
**project-scoped** API key — mint one from the project's API keys
page. Platform keys are rejected with 403; use a project key per
project, or generate from the web UI.

#### GET /api/reports
Query: `?sourceType=<overall|scan|audit|bias|agent-observability|iso42001|nist|deck>
&scanId=<id>&auditId=<id>&runId=<bias-run-id>` (all optional). The
project is inferred from the key. Returns
`{ reports: ReportSummary[] }` — newest first. Summaries omit the
structured `content` body; fetch it via `GET /api/reports/:id`.

#### POST /api/reports
Body:
- `{ sourceType: "overall" }` — project-wide executive summary.
- `{ sourceType: "scan", scanId }` — report for one pentest scan in this project.
- `{ sourceType: "audit", auditId }` — report for one compliance audit in this project.
- `{ sourceType: "bias", runId }` — fairness report for one bias run in this project.
- `{ sourceType: "agent-observability" }` — project-wide NYC LL144 bias-screen comparison across the project's agent-observability runs.

Returns `{ report: ReportEnvelope }` with the full structured `content`.
Each call appends a new versioned row; older versions stay available via
`GET /api/reports`.

#### GET /api/reports/:id
Returns `{ report: ReportEnvelope }` — the full structured report. The
report must belong to the key's project.

## Report shapes

```
ReportSummary = {
  id: string,
  projectId: string,
  sourceType: "overall" | "scan" | "audit" | "bias" | "agent-observability" | "iso42001" | "nist" | "deck",
  serviceRunId?: string,   // the run/scan/audit the report was generated for
  documentId: string,      // human-readable, e.g. "RPT-20260521-7CF5"
  generatedAt: number,
  modelId: string,
  title?: string,
  subtitle?: string
}

ReportEnvelope = ReportSummary + {
  disclaimer: string,
  content: {
    title, subtitle, executiveSummary,
    metrics:        [{ label, value, detail? }],
    keyFindings:    [{ title, severity, description, impact? }],
    sections:       [{ heading, body, bullets? }],
    recommendations:[{ priority, title, rationale }]
  }
}
```

## Project profile shape

```
{
  id: string,
  projectId: string,
  name: string,
  description: string,
  fields: any,          // free-form JSON blob the agent fills in
  currentVersion: number,
  agentRanAt: number | null,
  createdAt: number,
  updatedAt: number
}
```

## Typical agent flow

1. Call `describe_api` (this doc) once to ground yourself.
2. `list_projects` (if you have a platform key) to choose a project.
3. `create_project_profile({ projectId, name, description, fields })`.
4. Poll `get_project_profile({ id })` until `agentRanAt` is non-null — the platform
   agent has finished enriching the profile.

For pentest scans:
1. `create_pentest_scan({ projectId, target, task })` returns `{ id }`.
2. `get_pentest_scan({ id })` to poll status + findings as the scan runs.

For reports:
1. `generate_scan_report({ scanId })` after a scan completes to compose a
   decision-ready summary. The same flow exists for audits and the
   project as a whole.
2. `list_reports({ projectId, scanId })` later to browse every version
   generated for that source.
3. `get_report({ id })` to read a specific version's structured
   `content` and feed it into your downstream tooling (PDF pipeline,
   Slack post, ticketing system, …).
