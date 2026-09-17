# demo-video-agent

Produces captioned product-demo videos of **Neo** (Holistic AI's evaluation
platform, `app.hai-neo.com`) by driving a real browser through a scripted demo
and recording it. Local-first, single machine, TypeScript, no build step.

It is a **fixed sequence of stages, not an autonomous agent**. The demo is
scripted in advance, reviewed by a human, then replayed — the software never
improvises on camera. A language model is used in only two places, both away
from the recording itself: resolving an on-screen element when a selector breaks
(*self-heal*), and writing a first draft of the script (*generation*).

## Vocabulary

Defined once here, used throughout. In pipeline order:

| Term | Means |
|---|---|
| **spec** | What you want a video to cover, written by a human. One JSON file in `specs/`. Input to generation. |
| **inventory** | A read-only snapshot of the projects and evaluations in your Neo account, at `data/inventory.json`. Grounds generation in real data. |
| **storyboard** | The executable script for exactly one video: an ordered list of beats. One JSON file in `storyboards/`. Either hand-written or generated from a spec. |
| **beat** | One step of a storyboard — a caption plus the browser actions to perform while it is on screen. Each beat becomes one clip. |
| **action** | A single browser verb (`goto`, `click`, `act`, `actFill`, …). The complete list is a deliberate allowlist in `src/types.ts`. |
| **intent** | A plain-English description of an element ("the Run button on the second card") used instead of, or as a fallback for, a CSS selector. |
| **self-heal** | Resolving an intent against the live page at record time, using Azure OpenAI to pick the matching element. |
| **dwell** | The pause after a beat's actions finish. The caption is shown during it, so dwell sets the pace of the video. |
| **waypoint** | An element that must be visible before recording starts — the pre-flight check that you are logged in and on the right screen. |
| **clip** | The video segment for one beat, cut out of the single continuous recording. |
| **run** | One execution of the pipeline, identified by a `runId`. All its files live in `data/runs/<runId>/`. |
| **scorecard** | The automated quality result for a delivered video, written to `data/runs/<runId>/scorecard.json`. |

Two external systems appear throughout: **Azure** always means Azure OpenAI (the
model provider for self-heal, generation, and the judge), and **MCP** is the
Model Context Protocol — one of two ways to read the inventory out of Neo, and
currently the blocked one.

## The docs, and which to open

Four files, deliberately non-overlapping. When they disagree, the most specific
wins: `CLAUDE.md` → `ROADMAP.md` → this file.

| File | Contains | Open when |
|---|---|---|
| **`README.md`** (this) | What the system is, how to set it up and run it, why it is built this way, and what is broken. | You are new, or you want the reasoning behind a choice before changing it. |
| **`ROADMAP.md`** | An architecture summary, a map of all 23 modules, the canonical list of conventions to preserve, and twelve planned features (**F1–F12**) with implementation plans and acceptance criteria. | You are about to build something. Read **one feature section at a time**. |
| **`CLAUDE.md`** | Rules for Claude Code sessions: how to verify work, what cannot be verified here, and what must never be read, committed, or run unsupervised. | Claude Code loads it automatically every session. Read it once yourself so you know what your agent has been told. |
| **`hai-api.md`** | Neo's REST API reference — endpoint and payload shapes, available offline. | You need a request or response shape. **Do not follow its "Typical agent flow"**; see [Known issues](#known-issues). |

Each fact has one home. Guardrails are stated in ROADMAP's conventions and only
linked from elsewhere; planned work lives only in ROADMAP. If you are about to
copy a rule between files, link to it instead.

---

## Status

**Working.** `storyboards/redteam-playground.json` (hand-written, 8 beats)
records, assembles, delivers, and evaluates. Six runs are in `data/runs/`, and
`outputs/manifest.csv` lists four delivered videos at 1280×720 with captions.

**Not yet working.** `storyboards/playground-red-team.generated.json`, the
generated equivalent, has never recorded successfully. It uses intents
throughout and hits one remaining blocker: the time-limit dropdown is an HTML
`<select>`, which `actFill` cannot operate (ROADMAP F3.3 proposes an `actSelect`
action). Its other blocker — a step that said "hover" but would have clicked
"Start red teaming eval" — is fixed; see
[`act` vs `actHover`](#act-vs-acthover).

**Blocked.** Reading the inventory over MCP (ROADMAP F1). The endpoint rejects a
static token: it authenticates through Clerk, Neo's identity provider, and
accepts only Clerk-issued OAuth tokens. Use the REST route instead —
`explore --rest`, which produced the current `data/inventory.json`.

---

## Pipeline

```
spec + inventory ─▶ [SCRIPT] ─▶ storyboard.json
                                  │ validate: duration budget,
                                  │ destructive-keyword denylist
                                  ▼
      [PREFLIGHT] refresh inventory + confirm login + check entry waypoint
                                  ▼
      [RECORD] ONE continuous browser session, recorded start to finish,
               then split into one clip per beat by timestamp
                                  ▼
      ═════════ HUMAN REVIEW GATE (status: pending_review) ═════════
                                  ▼
      [ASSEMBLE] ffmpeg burns in captions and joins the approved clips
                                  ▼
      [DELIVER] outputs/<id>.mp4 + a row in outputs/manifest.csv
                                  ▼
      [EVAL] automated checks (+ optional model judge) → scorecard.json
```

---

## Setup

Needs **Node ≥ 22.6** and **ffmpeg and ffprobe on your PATH**. The Node floor
exists because the CLI runs TypeScript directly via `--experimental-strip-types`
instead of compiling it. `.nvmrc` pins 24.

ffmpeg is a system binary, not an npm package, so install it separately:
`brew install ffmpeg` (macOS) · `sudo apt install ffmpeg` (Debian/Ubuntu) ·
`choco install ffmpeg` (Windows). Without it the pipeline fails only *after*
spending a recording.

```bash
nvm use                             # or fnm/volta — reads .nvmrc
npm ci                              # also downloads Chromium, via postinstall
cp .env.example .env                # then fill in the credentials below
```

> Use `npm ci`, not `npm install`: it installs the exact locked dependency tree
> and will not quietly rewrite `package-lock.json`.

### Credentials you need

None are in the repo. `.env` is gitignored and you must populate it locally.

| Credential | Needed for | Ask |
|---|---|---|
| Microsoft SSO account with Neo access | `login`, which saves a browser session to `data/profile/` | `<IT / your manager>` |
| `NEO_REST_TOKEN` | `explore --rest` — reading the inventory | Neo dashboard → Settings → Platform API Keys |
| `AZURE_RESOURCE_NAME`, `AZURE_API_KEY`, `AZURE_DEPLOYMENT` | self-heal and `generate` | `<Azure subscription owner>` |
| `AZURE_VISION_DEPLOYMENT` | the model judge (not yet wired up — ROADMAP F10) | `<Azure subscription owner>` |
| Neo MCP token (Clerk machine-to-machine) | `explore --tools` / `--full` — **blocked**, ROADMAP F1 | Neo platform team |

Without Azure the pipeline still runs, but only actions that use real selectors
work. Any storyboard relying on intents fails silently — see
[Known issues](#known-issues).

`NEO_USERNAME` and `NEO_PASSWORD` in `.env.example` are leftovers from a
password-login path that was deleted when SSO arrived. Leave them blank.

---

## Commands

Seven commands, all through `src/cli.ts`.

```bash
# Log in ONCE, by hand (Microsoft SSO + MFA). Opens a real browser window:
# complete the login, then press ENTER. When Microsoft asks "Stay signed in?"
# choose YES and tick "Don't show this again" — that is what lets later runs
# skip MFA. The session is saved to data/profile/ and reused from then on.
npm run cli -- login --storyboard storyboards/redteam-playground.json

# Validate, pre-flight, and record. Stops at the review gate.
npm run cli -- run --storyboard storyboards/redteam-playground.json

# → watch data/runs/<runId>/clips/*.mp4, then approve or reject each beat,
#   either by editing data/runs/<runId>/review.json or with the flags below.

# Assemble the approved clips, deliver, and evaluate.
npm run cli -- resume --run <runId> --approve-all
npm run cli -- resume --run <runId> --approve beat1,beat2 --reject beat3

# Score a delivered run, or any video file.
npm run cli -- evaluate --run <runId>
npm run cli -- evaluate --video some.mp4 --target 30

# Read the inventory out of Neo → data/inventory.json
npm run cli -- explore --rest [--full]    # the route that works
npm run cli -- explore --tools            # list MCP tools — blocked, F1
npm run cli -- explore [--full]           # inventory over MCP — blocked, F1

# Draft a storyboard from a spec plus the inventory. Needs Azure.
npm run cli -- generate --spec specs/redteam-playground.spec.json \
                        --inventory data/inventory.json

# Try one intent against a live page. Needs Azure and a valid session.
npm run cli -- probe-act --url https://app.hai-neo.com/catalog --intent "click Run"
```

`package.json` also has `npm run login`, `resume`, `evaluate`, and
`run:example` as shorthands. Be aware that `run:example` points at
`storyboards/example-projects-overview.json`, whose selectors are marked
`VERIFY selector against live UI` and never were verified. It illustrates the
file format; it is not a working demo.

---

## Why it is built this way

The commit messages carry the fullest reasoning
(`git log --format='%H %s%n%b'`). The decisions you cannot infer from the code:

**One continuous recording, split afterwards** (`2a2354c`). The recorder drives
a single browser session through every beat, records throughout, and cuts the
result into clips by timestamp. The earlier design opened a fresh browser per
beat, which made the video jump, because every beat restarted from a cold page.
Clips are re-encoded rather than copied so the cuts land on exact frames.

> **Trade-off you inherit:** a single beat can no longer be re-recorded on its
> own. Rejecting any clip dead-ends the run and you re-record the whole
> storyboard (`src/orchestrator.ts:80-82`).

**A persistent browser profile, not a saved cookie file** (`2a2354c`). A
saved-cookie file does not carry Microsoft's long-lived "Stay signed in"
cookie, so MFA was triggered on every run. A persistent Chromium profile does.
The automated username-and-password login was deleted at the same time: logging
in is manual, once, by a person — by design.

**Stagehand was evaluated and rejected.** Stagehand v3 drives the browser
through the Chrome DevTools Protocol, which is incompatible with Playwright's
video recording — and the video is the entire product. `src/self-heal.ts` is the
in-house replacement, matching elements on role and accessible name.

**Self-heal is a fallback, not the normal path.** An action with both a selector
and an intent tries the selector first, with a short 4-second timeout, so a
stale selector fails quickly into the model-resolved path instead of stalling
for 15 seconds. Resolved elements are cached in `data/heal-cache.json` so later
runs skip the model call.

**The safety check blocks some words and only warns on others** (`aa62d00`).
Blocking anything matching "red team" meant a red-teaming demo could not
describe its own subject. Now an unambiguous commit verb — `delete`, `destroy`,
`erase`, `pay`, `purchase`, `checkout`, `submit`, `confirm`, `save changes` —
blocks recording outright, while launch-like phrasing (`launch`, `execute`,
`start the scan`, …) only warns, because it overlaps too much with ordinary
English. The check reads actions only, never captions: a caption may name a
feature without performing it.

**The author writes the steps; the model translates them** (`aa62d00`). A spec
may list steps in order, and the generator turns each into exactly one beat,
adding, merging and reordering nothing. Letting the model invent the sequence
made the video unpredictable in precisely the place a demo must be exact: which
screens appear, in what order, and what gets typed where. The commit puts it
well — *"The model's job shifts from author to translator."* Specs without steps
still work.

**The generator never writes selectors.** It can only emit `goto`, `act`,
`actHover`, `actFill`, and `waitMs`, because it cannot see the page and would
otherwise invent CSS that does not match anything. Lengths, resolution, and
login details are filled in from the spec by code, not by the model.

### `act` vs `actHover`

**`act` clicks. `actHover` hovers and never clicks.** The distinction carries
real weight: stopping *before* the launch button is what keeps a demo from
starting a real, billable evaluation, and an intent is the only way a generated
storyboard can refer to that button at all.

`actHover` did not originally exist. Asked to finish on the launch control
without pressing it, the generator wrote
`{"type":"act","intent":"hover over the launch button without clicking it"}` —
a step that reads as safe and clicks. It shipped in
`storyboards/playground-red-team.generated.json` and would have started a real
red-team run if anyone had recorded it. Validation missed it, because "launch"
only triggers a warning.

Three changes prevent a repeat:

1. `actHover` exists, so "point at it without pressing it" can be expressed.
2. The generator is told that `act` clicks, and is forbidden from putting hover
   wording in an `act` intent.
3. Validation now **refuses** any `act` whose intent contains `hover`,
   `mouse over`, `point at`, or `without clicking`, before any recording starts.

Keep this property when adding any future intent-based action: the action's name
must say what it does to the page. Wording inside an intent must never be the
only thing separating a safe step from a destructive one.

**Captions are subtitle files that carry their own styling.** Each caption is
written as an ASS file — a subtitle format that stores its own appearance — with
the styling baked in: opaque box, bottom centre, sized relative to the video.
That means ffmpeg needs no `force_style` argument, which is notoriously fragile
about commas and escaping. ffmpeg is given the subtitle's bare filename and run
from its directory.

> **Load-bearing:** do not "tidy" that into an absolute path. ffmpeg's filter
> syntax treats slashes and colons as separators and it will break.

**Dwell is calculated from reading speed** (`src/timing.ts`): 15 characters per
second plus a 1-second settling pause, clamped between 2.5 and 12 seconds. A
caption appears only once the beat's actions have finished, so it never sits
over a half-loaded screen. Timing it from actual on-screen motion instead is
ROADMAP F8.

---

## Guardrails

Four layers. Each is weak alone:

1. **The list of possible actions is itself the guarantee** (`src/types.ts`).
   There is no delete, submit, confirm, pay, or launch verb to write down.
2. **Validation before recording** blocks destructive wording and warns on
   launch-like wording, so a bad storyboard never costs a recording.
3. **The generator is instructed** that naming a feature is fine and triggering
   it is not, and that the last beat may only hover.
4. **A human reviews every clip** between recording and delivery. Nothing
   auto-approves in the default path.

On the API side:

- **Neo access over MCP is read-only.** `src/comprehension/neo.ts` rejects any
  tool whose name is not a `list_`, `get_`, `detect_`, or `whoami` call, before
  any network request. The excluded write tools start real, billable jobs.
- **Neo access over REST cannot write at all.** `NeoRestClient` has one private
  `get()` method; no POST, PATCH, or DELETE method exists to call.
- **Credentials never appear on camera or in logs.** Logging in is a separate,
  unrecorded step, and secrets are read from the environment at the moment they
  are used.

There is **no per-beat time limit**, despite `Beat.maxDurationSec` existing in
the schema. What actually stops a stuck action is the 4-second selector attempt,
the 6-second self-heal attempt, and a 15-second default page timeout.

---

## Evaluation

**Automated checks** (`src/eval/evaluate.ts`) run on every delivered video. No
model calls, no cost. A video passes only if every *hard* check passes.

| Check | Severity | Fails when |
|---|---|---|
| `playable` | hard | the file has no decodable video |
| `duration_in_tolerance` | hard | length falls outside the target ± tolerance |
| `resolution_matches` | hard | dimensions are wrong |
| `not_mostly_black` | hard | over 50% of frames are black — a blank capture |
| `not_mostly_frozen` | soft | over 60% is motionless — warning only |

> `not_mostly_frozen` fails on five of the six recorded runs (53–76% against a
> 60% threshold). This is a flaw in the check, not the videos: dwell deliberately
> holds a still screen for 2.5–12 seconds per beat, and a still screen is
> motionless video. As written the check carries no information. Either the
> threshold is wrong, or ROADMAP F8 and F9 (motion-based timing, a visible
> cursor) need to land.

**A model judge** (`src/eval/judge.ts`) samples frames and asks an Azure vision
model whether the video shows the promised feature, whether the captions read
cleanly, and whether it stays on topic. It is written but **nothing calls it** —
wiring it in is ROADMAP F10.

**Regression testing against known-good examples** is not built. The intent is a
folder of specs with expected outcomes, tracking how often generation produces a
valid storyboard, how often recording succeeds, how often checks pass, and the
cost and time per video. Every delivered run already writes a scorecard to
aggregate from.

---

## Known issues

**The self-heal cache forgets which one you meant.** It stores only an element's
role and name, then replays that as "the first match"
(`src/self-heal.ts:172-177`). One cached entry pairs the intent *"click the
second Run button"* with `{role: "button", name: "Run"}`, so the first run
clicks the correct card and every later run clicks the **first** one, quietly
opening the wrong evaluation. Delete `data/heal-cache.json` to force fresh
resolution. The real fix is to cache something that preserves position.

**Recording continues through failures.** A failed action is logged and the
recording carries on (`src/recorder.ts:82-86`), so a broken beat yields a clip
where nothing happens rather than an error. Only the human review reliably
catches this. Combined with the point above, running an intent-based storyboard
without Azure produces a video of a motionless page and exits successfully.

**`fill` and `selectOption` have no self-heal fallback.** Four of the eight beats
in the working storyboard depend on raw selectors matched by placeholder text or
by position, so they break on a UI change even though the storyboard is
described as self-healing.

**Settings that look live but do nothing.** `Beat.maxDurationSec` is read from
the file and never used. `Beat.leadTrimSec` is supported by the clip processor
but never passed to it, so it is always 0. `AuthConfig`'s username, password,
and submit selectors are leftovers from the deleted password login, yet still
appear in every generated storyboard.

**Pre-flight skips its main check on generated storyboards.** It confirms the
first waypoint is visible, and derives waypoints from `waitForSelector` actions.
Generated storyboards contain none, so only the login check runs. Separately,
its inventory refresh calls the blocked MCP route rather than the REST one that
works — a one-line improvement nobody has made.

**Delivery overwrites previous videos.** Every run writes
`outputs/<spec.id>.mp4`, the same filename, while *adding* a row to
`manifest.csv`. The manifest now lists four videos of different lengths at one
path; only the most recent file exists, so three rows are wrong.

**`hai-api.md` is unreferenced and contains a trap.** Nothing links to it. Its
"Typical agent flow" section instructs the reader to call
`create_project_profile` and `create_pentest_scan` — exactly the write
operations every guardrail above exists to prevent. Use it for endpoint shapes
only.

**`data/auth.json` is a stale credential file.** 22 KB of live session cookies
from the pre-profile era. Nothing reads it. Delete it from your machine.

**Everything points at one deployment.** `app.hai-neo.com` and one specific
backend hostname are hard-coded defaults in `src/types.ts` and `src/config.ts`.
Supporting other targets is ROADMAP F11.

---

## Where this is going

`ROADMAP.md` holds twelve planned features with implementation plans and
acceptance criteria. Its recommended order:

1. **F4 — move run state into a hosted database (Convex).** Unblocks the review
   UI and batch processing; needs nothing external.
2. **F1 — obtain a Clerk machine token.** An external request; unblocks reading
   the inventory automatically.
3. **F3 — tune the generator's prompt.** Possible today using an exported
   inventory file.
4. **F5 — a review UI**, then **F6 — a job queue.** Together these turn a
   single-machine script into something the team can use.

The stage boundaries and stored data shapes were chosen to make these additions
rather than rewrites: `data/runs/<id>/state.json` already mirrors the database
row it is meant to become.
