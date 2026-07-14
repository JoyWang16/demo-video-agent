# demo-video-agent — v0

Automated product-demo video pipeline. Takes a **storyboard** for one video, logs
into the target app off-camera, records the demo clip-by-clip in a headless
browser, **pauses for human review**, then burns in captions, assembles, delivers,
and **evaluates** the result. Local-first, single machine, TypeScript.

This is v0: one video, hand-authored storyboard, no cloud. Every stage is
separated so it maps onto the Convex + TanStack version later (see bottom).

## The four stages (+ the gate)

```
  spec + Neo data ──▶ [1 SCRIPT] ──▶ storyboard.json
                                        │  (validate: duration budget,
                                        │   destructive-action denylist)
                                        ▼
        [2 RECORD]  auth off-camera ──▶ ONE continuous browser session
                                        │  recorded, then split by timestamp
                                        │  into one clip per beat
                                        ▼
                       ══════ HUMAN REVIEW GATE (status: pending_review) ══════
                                        │  approve/reject per clip (file or flag)
                                        ▼
        [3 ASSEMBLE] approved clips ──▶ ffmpeg: burn captions + normalize + concat
                                        ▼
        [4 DELIVER]  outputs/<id>.mp4  + append row to outputs/manifest.csv
                                        ▼
        [EVAL]       hard checks (+ optional LLM-as-judge) → scorecard.json
```

Recording is a **deterministic replay** of a vetted storyboard — the agent never
improvises on camera. AI (optional) is confined to *writing* the storyboard and
*judging* the output, off the critical path.

## Setup

Requires Node 22+ and ffmpeg/ffprobe on PATH.

```bash
npm install
npx playwright install chromium     # downloads the browser (not needed to typecheck)
cp .env.example .env                # hai-neo uses MS SSO — no creds needed here
```

## Run the single-video happy path

```bash
# 0: log in ONCE by hand (Microsoft SSO + MFA). Opens a browser; complete login,
#    then press ENTER to save the session to data/auth.json. Re-run only when it
#    expires. Recording runs reuse this session and never touch the login flow.
npm run login -- --storyboard storyboards/example-projects-overview.json

# 1–2: validate + record, then it pauses at the review gate
npm run cli -- run --storyboard storyboards/example-projects-overview.json

# → inspect data/runs/<runId>/clips/*.webm
#   approve: edit data/runs/<runId>/review.json ("approved": true/false per clip)
#   or just approve everything:

# 3–6: assemble approved clips, deliver, evaluate
npm run cli -- resume --run <runId> --approve-all

# evaluate any delivered run (or an arbitrary file) at any time
npm run cli -- evaluate --run <runId>
npm run cli -- evaluate --video some.mp4 --target 30
```

> The example storyboard's selectors (`text=Projects`, etc.) are **placeholders**
> marked `VERIFY`. Confirm them against the live app, or switch the recorder's
> action executor to Stagehand `act()` so natural-language actions resolve against
> the live DOM without selectors.

## Evaluation plan

Two layers, plus a regression story.

**A. Automated hard checks (the gate — `src/eval/evaluate.ts`).** Deterministic,
free, no model calls. A run only counts as good if all *hard* checks pass:

| check | severity | fails when |
|---|---|---|
| `playable` | hard | no decodable video stream |
| `duration_in_tolerance` | hard | length outside target ± tolerance |
| `resolution_matches` | hard | wrong dimensions |
| `not_mostly_black` | hard | >50% black frames (blank capture) |
| `not_mostly_frozen` | soft | >60% frozen (>2s stretches) — warn only |

**B. LLM-as-judge (semantic — `src/eval/judge.ts`, optional).** Samples frames and
asks an Azure vision model: does it show the promised feature, do captions read
cleanly, is it on-topic → structured score. Behind Azure creds because it costs
tokens. Use it as a soft signal / triage, not an automatic gate.

**C. Regression via a golden set.** Keep a folder of specs with known-good
expected outcomes. On any change to prompts/models/templates, run all of them and
track the metrics below over time so you catch regressions before they ship:

- storyboard validity rate (passes `validateStoryboard`)
- recording success rate (clips captured / beats)
- acceptance pass rate (hard checks green)
- LLM-judge mean score (when enabled)
- cost + latency per video

Each delivered run writes `scorecard.json`; aggregate those into a dashboard later.

## Guardrails (built in)

- **Credentials off-camera & never logged.** Login runs in a throwaway,
  non-recorded context; the session is reused via `storageState`. Secrets are
  resolved from env at execution time only (`resolveSecret`).
- **Read/navigation-only action allowlist.** The `Action` type has no
  delete/submit/confirm verb. A coarse destructive-keyword denylist blocks
  storyboards that try (`validateStoryboard`).
- **Neo MCP: read tools only.** `src/comprehension/neo.ts` models only `list_*`/
  `get_*`. The MCP's write tools (`run_project_scan`, `create_pentest_scan`, …)
  launch real billable jobs and are deliberately excluded; if ever needed they go
  behind explicit human approval.
- **Human review gate** between raw capture and any edit/delivery.
- **Pre-record validation** so a bad storyboard never wastes a recording.
- **Per-beat watchdog** so a stuck selector can't hang the run.

## What's intentionally NOT here yet (next phases)

| v0 (now) | next |
|---|---|
| local `data/runs/*/state.json` | **Convex** table (`runs`), same shape |
| `review.json` + CLI flag | **Convex** `pending_review` row + **TanStack Start** review screen |
| CLI commands | **TanStack Start** UI to submit specs & watch progress; **Clerk** gates the team |
| hand-authored storyboard | **AI SDK + Azure** generator (`storyboard-gen.ts`) from live **Neo MCP** data |
| Playwright raw capture | optional Stagehand `act()` for selector-free actions; screencli/ffmpeg polish |
| CSV local file | CSV export of the Convex table + **SharePoint** upload via the Microsoft 365 / Graph MCP |

The state shapes and stage boundaries are already chosen so these are additive,
not rewrites.
