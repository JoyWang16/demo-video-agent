# CLAUDE.md

Rules for Claude Code sessions in this repo. Read this first.

## What this repo is

A TypeScript pipeline that turns a **storyboard** — a JSON script for one video —
into a captioned product-demo video of Neo, Holistic AI's evaluation platform.
The stages run in a fixed order:

```
SCRIPT → PREFLIGHT → RECORD → human review → ASSEMBLE → DELIVER → EVALUATE
```

It is **not** an autonomous agent, and must not become one. A language model is
used in exactly two places: *self-heal* (identifying an element on the live page
when a selector fails) and *generation* (drafting a storyboard). Everything else
is deterministic.

`README.md` has a vocabulary table defining **storyboard**, **beat**, **action**,
**intent**, **dwell**, and the rest. Read it if any term here is unfamiliar.

## Read before changing anything

1. `ROADMAP.md` → **"Architecture in 60 seconds"** and **"File map"** — what each
   of the 23 modules is responsible for.
2. `ROADMAP.md` → **"Conventions you MUST preserve"** — the canonical guardrail
   list. Deliberately not repeated here; go read it.
3. `src/types.ts` — every data shape, defined once in zod. The list of possible
   actions **is** the safety model. Add fields here, never ad hoc.
4. `README.md` → **"Known issues"** — the traps that cost a day each.

## Verifying your work

```bash
npm run typecheck    # the only automated check that exists
```

**There are no tests** — no test files, no test runner, no CI, no linter, no
formatter. If you see the comment `// Exported for unit testing` in
`src/self-heal.ts`, it is wrong. Do not go looking for a test suite. Should you
add one, `pickIndex`, `computeDwellSec`, and `validateStoryboard` are pure
functions and the obvious place to start.

`npm run build` does nothing — TypeScript is configured to emit no output, and
the CLI runs `.ts` files directly. There is no build step to run or fix.

### What cannot be verified here

Anything touching Azure, a real browser, or the live Neo site needs a real
machine with a valid login session. **A passing typecheck is not end-to-end
verification.** Say precisely what you ran, and flag whatever still needs a human
at a keyboard.

The one available smoke test needs Azure credentials and a live session:

```bash
npm run cli -- probe-act --url <url> --intent "click X"
```

## Where work comes from

`ROADMAP.md`, features **F1–F12**. Take **one feature section at a time**, on a
branch. Each states its purpose, current state, implementation plan,
dependencies, acceptance criteria, and the guardrails it must not break. Honour
the acceptance and guardrail lines, plus the "Definition of done" checklist at
the end of that file.

Recommended order: F4 → F1 → F3 → F5/F6.

## Never read or print

- `.env` — live Azure and Neo credentials.
- `data/profile/` — a logged-in Chromium profile holding Microsoft SSO cookies.
- `data/auth.json` — an obsolete session file that still contains live cookies.
  Nothing reads it; it should be deleted.

A broad `cat` or `grep` across `data/` will copy session credentials into the
transcript. Don't.

## Never commit

`data/`, `outputs/`, `.env`. All are gitignored and hold credentials, customer
data, and video files. Keep it that way.

## Never run without a human's explicit approval

**Anything that records against live Neo.** Recording drives a real browser
through a real account, and a demo ends with the pointer resting on a button
that starts a paid evaluation.

**`act` clicks. `actHover` hovers and never clicks.** That is the difference
between a demo that stops at the launch button and one that starts a real,
billable evaluation run. Validation rejects any `act` whose intent mentions
"hover", "mouse over", "point at", or "without clicking". If you hit that error,
the fix is to use `actHover` — never to reword the intent until the check passes.

**The Neo write operations** (`run_project_scan`, `create_pentest_scan`,
`create_redteam_run`) start real, billable jobs. `src/comprehension/neo.ts`
refuses them before any network request. Never relax that filter.

## Easily confused filenames

| Path | What it is |
|---|---|
| `specs/redteam-playground.spec.json` | the human-written input to generation |
| `storyboards/redteam-playground.json` | hand-written; records successfully |
| `storyboards/playground-red-team.generated.json` | generated; has never recorded successfully |

The generated name is built from the project and evaluation type, which is why
its words are in the opposite order. Generated storyboards are committed, so
regenerating one produces a reviewable diff — but also means an accidental
`generate` quietly modifies the working tree.

## `hai-api.md`

Neo's REST API reference, kept in the repo so endpoint shapes are available
offline. Nothing links to or imports it. **Its "Typical agent flow" section tells
the reader to call `create_project_profile` and `create_pentest_scan` — the exact
write operations the guardrails above exist to prevent.** Use it for request and
response shapes only; do not follow its flow.

## Commits

Conventional Commits, one logical change each. There is no established scope
vocabulary, so plain `feat:`, `fix:`, `docs:`, `refactor:` are fine.
