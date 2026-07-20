# demo-video-agent — Contributor Roadmap

> **Audience:** engineers branching from this repo, and Claude Code sessions
> asked to implement a feature. Each feature below is self-contained: purpose,
> current state, and a concrete implementation plan referencing real files.
>
> **How to use with Claude Code:** open a branch, then paste a single feature
> section (plus the "Architecture in 60 seconds" and "Conventions" sections
> below) into Claude Code. Every feature lists the exact files to touch, the
> data shapes involved, and acceptance criteria. Do NOT hand Claude Code the
> whole file at once — feed one feature at a time.

---

## Architecture in 60 seconds

This is a **local-first TypeScript pipeline** that turns a *storyboard* (JSON
spec for one video) into a finished, captioned product-demo video of the Neo
web app (`app.hai-neo.com`). It is a **deterministic DAG of stages**, not an
autonomous agent. An LLM is used in only two narrow places: **self-heal**
(resolving a UI action against the live page when a selector breaks) and
**storyboard generation** (Phase B).

```
spec + inventory ─▶ [SCRIPT] ─▶ storyboard.json
                                  │ validateStoryboard (duration budget,
                                  │ destructive-keyword denylist)
                                  ▼
      [PREFLIGHT] refresh inventory (if MCP) + verify auth + entry waypoint
                                  ▼
      [RECORD] ONE continuous Playwright session (persistent profile),
               deterministic actions native; act()/self-heal via Azure;
               split into per-beat clips by timestamp
                                  ▼
      ═════════ HUMAN REVIEW GATE (status: pending_review) ═════════
                                  ▼
      [ASSEMBLE] ffmpeg burns captions (timed to the post-action dwell) + concat
                                  ▼
      [DELIVER] outputs/<id>.mp4 + append row to outputs/manifest.csv
                                  ▼
      [EVAL] hard checks (+ optional Azure LLM-judge) → scorecard.json
```

**Run it:**
```bash
npm run cli -- login    --storyboard storyboards/redteam-playground.json   # once, manual SSO/MFA
npm run cli -- run      --storyboard storyboards/redteam-playground.json   # validate→preflight→record→pause
npm run cli -- resume   --run <runId> --approve-all                        # assemble→deliver→eval
npm run cli -- explore  --tools | --full                                   # (needs Neo MCP auth) inventory
npm run cli -- generate --spec specs/<x>.spec.json --inventory data/inventory.json  # Phase B
npm run cli -- probe-act --url <url> --intent "click X"                    # self-heal smoke test
```

**Stack:** Node ≥22.6 running `.ts` directly via `--experimental-strip-types`
(no build step); ESM + NodeNext + strict. Playwright (browser + video),
ffmpeg/ffprobe on PATH (captions/concat/eval), AI SDK v5 + `@ai-sdk/azure` v2
(self-heal + generation), `@modelcontextprotocol/sdk` (read-only Neo MCP), zod
(schemas). No Stagehand (removed — v3 is CDP-based and incompatible with
Playwright `recordVideo`; self-heal is our Playwright-native replacement).

---

## File map (what each module owns)

| File | Owns |
|---|---|
| `src/types.ts` | All zod schemas: `VideoSpec`, `GenerationSpec`, `Action` (discriminated union), `Beat`, `Storyboard`, `AuthConfig`, `RunState`, `ClipRecord`. **Single source of truth for data shapes.** |
| `src/config.ts` | Env loading; `PROFILE_DIR`, `DATA_DIR`, `azureEnv`, `neoMcp` (url/token/transport), `resolveSecret("$VAR")`, `ensureDirs()`. |
| `src/storyboard.ts` | `loadStoryboard`, `validateStoryboard` (duration estimate via `computeDwellSec`; destructive-keyword denylist scans **actions**, not captions). |
| `src/preflight.ts` | Pre-record gate: refresh MCP inventory (if configured) + verify auth + entry-screen waypoint. |
| `src/recorder.ts` | The RECORD stage. Persistent-profile Playwright context + `recordVideo`; runs beats via `runAction`; wires `heal`/`healFill` when Azure configured + storyboard needs it; splits continuous take into per-beat clips. |
| `src/executor.ts` | `runAction(AgentPage, Action)`: deterministic actions native; `click`/`hover` with `intent` = native-first then self-heal fallback; `act`/`actFill` = pure self-heal. `needsAgent(actions)` decides if Azure is required. |
| `src/self-heal.ts` | Playwright-native self-heal: enumerate visible+enabled interactive elements → Azure `pickIndex` → act via `getByRole`; cache to `data/heal-cache.json`. `selfHeal` (click/hover) + `selfHealFill` (form input). |
| `src/agent-llm.ts` | `getAzureModel()` (AI SDK v5 model) + `azureConfigured()`. |
| `src/ffmpeg.ts` | `probe`, `cutClip`, `writeAss` (styled captions timed `start→end`), `processClip` (scale/pad/fps + burn caption during dwell), `concat`, `sampleFrames`. |
| `src/timing.ts` | `computeDwellSec(caption, captionsEnabled)` — reading-time-based hold. |
| `src/orchestrator.ts` | `startRun` (validate→preflight→record→pending_review) and `resumeRun` (assemble approved clips→deliver→evaluate). |
| `src/review.ts`, `src/runstate.ts` | Review gate (`review.json`) and run-state persistence (`data/runs/<id>/state.json`). |
| `src/deliver.ts` | Copy final mp4 to `outputs/`, append `outputs/manifest.csv`. |
| `src/eval/evaluate.ts` | Hard checks: playable, duration_in_tolerance, resolution_matches, not_mostly_black, not_mostly_frozen (soft). Writes `scorecard.json`. |
| `src/eval/judge.ts` | Optional Azure vision LLM-judge (semantic). Off the critical path. |
| `src/comprehension/neo.ts` | Read-only Neo MCP client. Refuses any tool not matching `^(list_|get_|detect_|whoami)`. |
| `src/comprehension/explore.ts` | `explore --tools` (catalog) and `explore --full` → writes `data/inventory.json`. |
| `src/comprehension/storyboard-gen.ts` | Phase B generator: `GenerationSpec` + inventory → act()-first `Storyboard` (validate + one retry). |
| `src/cli.ts` | Command dispatch: `login`, `run`, `resume`, `evaluate`, `explore`, `generate`, `probe-act`. |

---

## Conventions you MUST preserve

1. **Guardrails are non-negotiable.**
   - Credentials are off-camera and never logged. Login is manual/one-time
     (persistent profile in `data/profile`). Secrets resolve from env at
     runtime via `resolveSecret("$VAR")` only.
   - The `Action` union is a **read/navigation-only allowlist** — no
     delete/submit/confirm/pay/launch verb exists. `validateStoryboard` runs a
     destructive-keyword denylist over actions. Keep both.
   - Neo MCP client is **read-only** (`src/comprehension/neo.ts` refuses write
     tools before any network call). Never relax this.
   - Every generated/authored demo **STOPS before any launch action** (last
     beat only hovers). The generator's system prompt enforces this.
   - There is a **human review gate** between raw capture and delivery. Do not
     auto-approve in the default path.
2. **No build step.** Code runs as `.ts` via `--experimental-strip-types`.
   Keep it typecheck-clean: `npm run typecheck` (== `tsc --noEmit`) must pass.
   Node lib only — **no DOM types** in Node files; inside Playwright
   `page.evaluate` callbacks, cast the element to a local structural type.
3. **Data shapes live in `src/types.ts`.** Add fields there (zod), not ad hoc.
   State persisted under `data/runs/<id>/state.json` is the local stand-in for
   a future Convex row and intentionally mirrors the schema.
4. **The LLM is confined to self-heal + generation.** Do not turn stages into
   autonomous agents. Parallelism is across videos (queue + workers), not
   agents collaborating on one video.
5. **`data/` and `outputs/` are gitignored** (contain sessions, org data,
   videos). Never commit them. `.env` too.
6. **Verification reality:** Azure calls, a real browser, and the live Neo site
   can only be exercised on a real machine. CI/sandbox can only typecheck +
   unit-test pure logic. Ship typechecked code + a probe/smoke path for
   anything that touches those three.

---

# Unimplemented features

Ordered roughly by dependency. Each is branchable independently unless a
`Depends on` is listed.

---

## F1 — Neo MCP authentication (Clerk M2M token) 🔴 BLOCKER

**Purpose.** Let the pipeline read the Neo MCP non-interactively so `explore`
and live storyboard generation work without a human browser login.

**Current state.** `src/comprehension/neo.ts` sends `Authorization: Bearer
$NEO_MCP_TOKEN`. The MCP endpoint (`…convex.site/mcp/<key>`) returns 401 to a
static token: its authorization server is **Clerk (`clerk.hai-neo.com`)** and
it only accepts Clerk-issued OAuth tokens (confirmed via the endpoint's
`/.well-known/oauth-protected-resource`, `bearer_methods_supported: ["header"]`).
Reusing the claude.ai OAuth token is disallowed by Anthropic ToS.

**Implementation options (pick based on what Neo/Clerk supports):**
- **Preferred — Clerk M2M token.** Obtain a Clerk machine token (client_credentials
  or a long-lived JWT) scoped to the MCP resource from the Neo platform team.
  Put it in `.env` as `NEO_MCP_TOKEN`. No code change needed — the Bearer header
  path already exists. If the token needs periodic refresh, add a small
  `getNeoToken()` in `src/comprehension/neo.ts` that exchanges Clerk
  `client_id`/`client_secret` (new env vars `NEO_CLERK_CLIENT_ID`/`_SECRET`) for
  an access token and caches it until expiry.
- **Alternative — Neo REST API.** If Neo exposes a plain REST API + API key,
  skip MCP entirely: replace the MCP calls in `neo.ts` with `fetch` to the REST
  base URL, keeping the same `read()`/`listTools()`/inventory shape so
  `explore.ts` and the generator are unaffected.
- **Heavy fallback — full OAuth in-process.** Implement OAuth 2.1 + PKCE against
  `clerk.hai-neo.com` in `neo.ts` (browser once, refresh after). Only if no
  machine credential is available.

**Depends on.** External: a credential from the Neo/Clerk owner.
**Acceptance.** `npm run cli -- explore --tools` prints the tool catalogue;
`explore --full` writes a non-empty `data/inventory.json`.
**Guardrail.** Keep the read-only tool filter intact regardless of auth method.

---

## F2 — Live inventory refresh inside preflight

**Purpose.** Keep the pipeline's understanding of "what projects/evals exist"
current before each record, per the two-layer drift model (content + structure).

**Current state.** `src/preflight.ts` already calls `exploreInventory({full:false})`
when `NEO_MCP_URL` is set, else prints "skipping content refresh". So this is
**wired but dormant** until F1 lands. `explore.ts` writes `data/inventory.json`.

**Implementation.** Once F1 works, no new code is strictly required. Optional
polish: (a) cache inventory with a TTL so back-to-back runs don't re-fetch;
(b) diff the new inventory against the last and log added/removed projects;
(c) surface a preflight warning if the storyboard's target project is no longer
in the inventory (`spec.feature`/generation `project` vs inventory names).

**Depends on.** F1.
**Acceptance.** With MCP configured, `run` logs "Neo inventory refreshed" and
`data/inventory.json` updates; a missing target project produces a clear warning.

---

## F3 — Phase B generator: live-MCP wiring + prompt tuning

**Purpose.** Generate runnable storyboards from a human `GenerationSpec` + live
Neo data, instead of hand-authoring.

**Current state.** `src/comprehension/storyboard-gen.ts` is **built** and passes
typecheck + unit tests. It reads an inventory **file** (`--inventory`, default
`data/inventory.json`), emits an **act()-first** storyboard (action set limited
to `goto`/`act`/`actFill`/`waitMs` — zero selector hallucination), assembles a
full `Storyboard`, runs `validateStoryboard`, and retries once on failure. CLI:
`generate --spec <file> --inventory <file>`. Sample spec:
`specs/redteam-playground.spec.json`.

**What's left.**
1. **Live inventory** (vs file): trivial once F1/F2 exist — call
   `exploreInventory` (or read the freshly written `data/inventory.json`) inside
   `generate` instead of requiring a hand-exported file.
2. **Prompt tuning against real output.** The system prompt in `storyboard-gen.ts`
   (`SYSTEM`) and `buildPrompt` are first-draft. Run `generate` on real inventory,
   inspect beat segmentation + intent phrasing + caption quality, and iterate.
   Add few-shot examples (a known-good storyboard like `storyboards/redteam-playground.json`
   converted to act()-first) to the prompt to anchor style.
3. **Dropdown/select handling.** `actFill` covers text inputs; native `<select>`
   and custom dropdowns currently must be two `act` clicks ("open X", "choose Y").
   Consider a dedicated `actSelect {intent, option}` action (schema + executor +
   a `selfHealSelect` in `self-heal.ts`) if generated demos hit selects often.

**Depends on.** F1/F2 for live inventory (works today with a hand-exported file).
**Acceptance.** `generate` on real inventory produces a storyboard that `run`
records end-to-end and that passes `evaluate`. Beat captions read cleanly.
**Guardrail.** The generator must keep emitting only the 4 safe action types and
the "stop before launch" rule; keep the post-generation `validateStoryboard`.

---

## F4 — Convex state layer (orchestration backbone) ⭐ high leverage

**Purpose.** Move run state from local files into Convex so multiple videos,
a GUI, and a queue can all share one source of truth. This is the step that
turns a single-machine script into a service.

**Current state.** Run state is `data/runs/<id>/state.json` via
`src/runstate.ts`; review is `data/runs/<id>/review.json` via `src/review.ts`.
Shapes (`RunState`, `ClipRecord`) already mirror a DB row by design.

**Implementation.**
1. Add a `convex/` project (Convex free tier). Define tables mirroring
   `src/types.ts`: `runs` (id, spec, status: `queued|recording|pending_review|assembling|delivered|failed`, timestamps), `clips` (runId, beatId, caption, captionStartSec, approved, rejectionReason, storagePath), `manifest` rows.
2. Introduce a `StateStore` interface in `src/runstate.ts` with two impls:
   `FileStateStore` (current behavior) and `ConvexStateStore` (Convex client).
   Select via env (`STATE_BACKEND=file|convex`). Keep `RunState` shape identical.
3. `orchestrator.ts` writes status transitions through `StateStore` at each
   stage boundary (already the natural seams: after validate, preflight, record,
   review, assemble, deliver, eval).
4. Clip artifacts: keep video files local for now (Convex stores metadata +
   local paths); a later feature can push to Convex file storage or SharePoint (F7).

**Depends on.** none (fully unblocked).
**Acceptance.** A run's lifecycle is visible in Convex; `run`/`resume` work with
`STATE_BACKEND=convex` and produce identical output to the file backend.
**Note.** Do NOT rip out the file backend — keep it as the default/dev path.

---

## F5 — Review GUI (TanStack Start + Clerk)

**Purpose.** Replace the `review.json`-editing + CLI-flag gate with a web UI:
submit a spec, watch progress, review clips per beat, edit captions, approve/
reject, trigger re-record. Clerk gates **your team's** access to this tool
(distinct from the Neo/Clerk MCP auth in F1).

**Current state.** Review is manual (`data/runs/<id>/review.json` or
`resume --approve-all`). No UI.

**Implementation.**
1. TanStack Start app (new `app/` or `web/` dir). Auth via Clerk (`@clerk/*`).
2. Screens: **Submit** (form → `GenerationSpec` → calls generator → shows draft
   storyboard for edit) · **Runs list** (reads Convex `runs`) · **Review**
   (per-beat clip player, caption edit, approve/reject, "re-record beat"
   button) · **Deliverables** (links to `outputs/*.mp4`, manifest).
3. The UI reads/writes Convex (F4) — it does not call the pipeline directly.
   A worker (F6) picks up `queued` runs and executes them.
4. Caption edits: writing a new caption to a clip re-runs only ASSEMBLE
   (`processClip`), not RECORD — captions are burned at assembly. Wire a
   "re-assemble" action that calls `resumeRun` for that run.

**Depends on.** F4 (state layer). F3 for the "submit a spec" flow.
**Acceptance.** A team member logs in via Clerk, submits a spec, watches the run,
reviews clips, approves, and downloads the video — no CLI.
**Guardrail.** The review gate stays mandatory; approval is an explicit human action.

---

## F6 — Batch across videos (queue + workers)

**Purpose.** Produce many videos of many types by running N independent
pipelines. This is the throughput story.

**Current state.** Single video per CLI invocation.

**Implementation.**
1. A `runs` queue in Convex (F4): rows with `status:queued`.
2. A worker loop (`src/worker.ts`) that claims a queued run, executes
   `startRun`, and updates status. Multiple workers can run on multiple
   machines. **Recording serializes per machine** (one visible browser films one
   thing) — enforce a per-machine record lock; the parallelism is across
   machines and across the non-record stages (script/generate/eval).
2. Idempotency: claiming a run should be atomic (Convex mutation) so two workers
   don't grab the same run.
3. Backpressure: cap concurrent recordings per machine at 1; allow generation/
   eval concurrency higher.

**Depends on.** F4.
**Acceptance.** Submitting 5 specs results in 5 delivered videos with no manual
per-run commands; recordings don't collide on one machine.
**Guardrail.** Preserve per-video review gates (batch does not auto-approve).

---

## F7 — SharePoint / Microsoft 365 delivery

**Purpose.** Publish finished videos to SharePoint so the team/marketing can use
them, instead of only local `outputs/`.

**Current state.** `src/deliver.ts` copies to `outputs/` and appends
`outputs/manifest.csv`. The `manifest.csv` already has a `sharepoint_url` column
(currently blank).

**Implementation.** Add an upload step in `deliver.ts` (or a post-deliver hook)
that uploads via the **Microsoft 365 / Graph MCP** (already available as a
connector) or the Graph REST API with an app registration. Fill the
`sharepoint_url` column with the resulting link. Gate behind env
(`SHAREPOINT_ENABLED`, target site/drive path). Keep local delivery as default.

**Depends on.** A Graph credential/app registration (external), similar M2M
consideration as F1.
**Acceptance.** A delivered run appears in the configured SharePoint location and
`manifest.csv`/Convex row carries the link.

---

## F8 — Layer-2 adaptive timing (dwell from real motion)

**Purpose.** Make dwell reflect what's actually happening on screen (wait for a
page to settle before starting the caption; hold longer when content is dense),
improving pacing and reducing the `not_mostly_frozen` warning.

**Current state.** Dwell is reading-time-based (`src/timing.ts`,
`computeDwellSec`). Caption shows only during the post-action dwell
(`captionStartSec`), already implemented in recorder + `ffmpeg.processClip`.

**Implementation.** During RECORD, sample frame-to-frame change (e.g., periodic
screenshots hashed/diffed, or CDP screencast metrics) to detect when the UI has
"settled" after actions, and set the caption start / dwell length from that
rather than a fixed formula. Keep `computeDwellSec` as the floor. This lives in
`recorder.ts` (measure) + `timing.ts` (combine reading-time floor with measured
settle). Alternatively, post-process: `ffmpeg.sampleFrames` already exists — a
motion analysis pass could recommend per-beat dwell for a re-assemble.

**Depends on.** none.
**Acceptance.** Captions never appear over a still-loading screen; measured
`frozen%` drops on the same storyboard vs the reading-time-only baseline.

---

## F9 — Cursor rendering + click highlights (polish)

**Purpose.** Show a visible cursor and click pulses so viewers can follow the
demo (Playwright doesn't render a real pointer into the video).

**Current state.** No visible cursor; actions appear to happen with no pointer.

**Implementation.** Inject a small JS/CSS overlay into the page at record time
(a `page.addInitScript` or per-beat injection in `recorder.ts`) that draws a
fake cursor following `mousemove` and a pulse on click. Optionally add
auto-zoom on the focused element. Purely a RECORD-stage/visual concern; does not
touch the action model. Pairs well with F8.

**Depends on.** none.
**Acceptance.** Delivered videos show a moving cursor and click emphasis;
no change to eval hard checks.

---

## F10 — LLM-judge wiring + regression golden set

**Purpose.** A semantic quality signal (does the video actually show the feature,
do captions read cleanly) and a regression harness so prompt/model/template
changes don't silently degrade output.

**Current state.** `src/eval/judge.ts` (Azure vision judge) exists but is
optional and off the critical path. `evaluate.ts` writes `scorecard.json`.

**Implementation.**
1. Wire `judge.ts` as an optional soft signal in `resumeRun`'s eval step
   (behind Azure config), appending a `judgeScore` to the scorecard. Never make
   it a hard gate.
2. Golden set: a `golden/` folder of `GenerationSpec`s (or storyboards) with
   expected outcomes. A `npm run cli -- eval:golden` command runs all, aggregates
   metrics (storyboard validity rate, recording success rate, hard-check pass
   rate, judge mean, cost + latency per video) into a `scorecard`-style summary.
3. Track those metrics over time (dump to Convex or a CSV) for a dashboard.

**Depends on.** Azure (already used). F4 optional for storing metrics.
**Acceptance.** `eval:golden` produces a metrics summary; judge score appears on
delivered runs when enabled.

---

## F11 — Multi-app / config generalization

**Purpose.** Let the pipeline target apps beyond `app.hai-neo.com` (or multiple
Neo environments) without hardcoded URLs.

**Current state.** Some URLs are hardcoded in storyboards and defaults
(`GenerationSpec` defaults, `preflight`, sample spec). Auth is Neo-specific
(SSO/MFA via persistent profile).

**Implementation.** Introduce a `target` config object (base URL, login URL,
success signal, profile dir per target) in `src/config.ts`, referenced by specs
and preflight. Support multiple persistent profiles keyed by target. Keep Neo as
the default target.

**Depends on.** none.
**Acceptance.** A second target app can be recorded by supplying a target config,
with its own reusable login session.

---

## F12 — Additional storyboard templates / video types

**Purpose.** Prove and expand coverage beyond the red-team demo (e.g., bias
evaluation, compliance audit walkthrough, onboarding tour). Each "video type" is
a **storyboard template / generation preset**, NOT a new agent.

**Current state.** Two hand-authored storyboards
(`storyboards/redteam-playground.json`, `example-projects-overview.json`) and one
generation spec. Self-heal proven on the red-team flow only.

**Implementation.** Author (or generate via F3) storyboards for other Neo
evaluation types. Add matching `GenerationSpec`s under `specs/`. Verify self-heal
holds on each new flow (different pages/labels). Common intros/outros can become
shared beat snippets if duplication grows.

**Depends on.** F3 for generation; otherwise hand-authorable today.
**Acceptance.** At least one new video type records end-to-end and passes eval.

---

## Suggested contribution order

1. **F4 (Convex state layer)** — unblocks F5/F6, highest leverage, no external deps.
2. **F1 (Clerk MCP token)** — external ask; unblocks F2/F3-live in parallel.
3. **F3 prompt tuning** — usable today with a hand-exported inventory.
4. **F5 (GUI)** then **F6 (batch)** — the "team service" milestone.
5. **F8/F9 (polish)** and **F10 (judge/regression)** — quality, anytime.
6. **F7 (SharePoint)**, **F11 (multi-app)**, **F12 (more types)** — as needed.

## Definition of done (any feature)

- `npm run typecheck` passes (no build step; strict).
- Guardrails in "Conventions" preserved (read-only, denylist, review gate,
  stop-before-launch, secrets off-camera).
- New data shapes added to `src/types.ts` (zod).
- Anything touching Azure/browser/live-Neo ships with a probe or smoke path,
  since CI can only typecheck + unit-test pure logic.
- `data/`, `outputs/`, `.env` remain gitignored.
