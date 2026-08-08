# Plan 008: Put the existing verification gates under CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plan/generated/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- package.json README.md`
> and `ls -a .github 2>/dev/null`. If a CI workflow already exists, treat it as
> a STOP condition — this plan assumes there is none.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none. Best run *after* `plan/generated/001`–`plan/generated/007` so CI starts
  green on the fixed tree; it is not technically blocked by them.
- **Category**: dx
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

The repository has a genuinely good verification story — `bun run typecheck` is
clean and `bun test` runs 155 tests in about 3.4 seconds — and nothing runs it
automatically. There is no `.github/` directory and no CI configuration of any
kind.

Two gates in particular are enforced only if a human remembers them, and both
are the kind that regress silently. `bun run test:protocol` is the cross-language
TypeScript↔Swift conformance harness: it checks shared JSON/SSE fixtures, starts
a temporary live arbord, and runs the Swift tests against it. `bun run test:performance`
asserts hard indexer thresholds. Neither is reachable from the default
`bun test`, which covers only `tests/unit` and `tests/integration`.

There is also no single local command that runs everything — the README lists
eight separate steps a contributor must remember. This plan adds one `verify`
script and one workflow that runs the same list, so the local and CI entry
points cannot drift apart.

## Current state

Files involved:

- `package.json` — the script definitions.
- `README.md:39-49` — the manual gate list this plan automates.

The current scripts block in `package.json`:

```json
  "scripts": {
    "dev": "bun packages/cli/src/index.ts browse",
    "host": "bun packages/cli/src/index.ts serve",
    "build": "bun run build:web && bun build packages/cli/src/index.ts --target=bun --outdir=dist/cli",
    "build:web": "vite build --config packages/render/vite.config.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test tests/unit/*.test.ts tests/integration/*.test.ts",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "test:e2e": "playwright test",
    "test:protocol": "bun tests/protocol/conformance.ts",
    "test:performance": "bun tests/performance/indexer.bench.ts"
  },
```

`README.md:39-49` documents the full manual sequence, which is the
authoritative list of what CI should run:

```sh
bun install
bunx playwright install chromium
bun run typecheck
bun test
bun run test:protocol
bun run build
bun run test:e2e
bun run test:performance
swift test --package-path native/Packages/ArborClient
```

Per `README.md:51`, `bun run test:protocol` starts a temporary live arbord and
runs the Swift tests against it — so it needs a Swift toolchain, which means
macOS. `swift test` run directly checks the standalone package and skips its
live-server case when `ARBOR_TEST_URL` is absent.

Known flakiness to expect (these are pre-existing, and CI will surface them):

- `tests/unit/fs.test.ts:311-323` uses fixed `setTimeout` sleeps of 320ms/180ms
  tuned against a real `@parcel/watcher` with `settleDelayMs: 250`. A slower CI
  runner can flip it.
- `tests/integration/workspace.test.ts:156` sleeps 100ms for the background
  indexer and asserts on content written by an *earlier test in the same file*,
  so it is order-dependent.
- `tests/integration/workspace.test.ts:14`, `tests/integration/fs-scope.test.ts:19`,
  and `tests/integration/self-sync.test.ts:22` mutate `process.env.ARBOR_DATA_HOME`
  at module scope without restoring it. `tests/unit/trees.test.ts:12-24` shows
  the correct save/restore pattern.

Repo conventions:

- The repo uses Bun as its package manager and runtime; `bun.lock` is committed.
- `tests/integration/postgres.test.ts` requires `ARBOR_TEST_POSTGRES_DSN` and is
  skipped without it (README.md:67-74). It must stay skipped in CI.

## Commands you will need

| Purpose       | Command                     | Expected on success              |
|---------------|-----------------------------|----------------------------------|
| Typecheck     | `bun run typecheck`         | exit 0, no output                |
| Tests         | `bun test`                  | all pass (155 at time of writing)|
| Protocol      | `bun run test:protocol`     | exit 0 (needs Swift toolchain)   |
| Build         | `bun run build`             | exit 0                           |
| Performance   | `bun run test:performance`  | exit 0, thresholds met           |
| E2E           | `bun run test:e2e`          | all pass (needs chromium)        |

## Scope

**In scope**:

- `.github/workflows/verify.yml` (create)
- `package.json` (add a `verify` script only — do not change existing scripts)
- `README.md` (point the testing section at the new one-command entry)

**Out of scope** (do NOT touch):

- **Fixing the flaky tests listed above.** They are real and they are recorded
  as a separate finding. If one of them fails in CI, report it — do not fix it
  inside this plan, and do not delete or skip it to make CI green.
- Any source file under `packages/`.
- Adding a linter or formatter — separate concern, separate decision.
- `tests/integration/postgres.test.ts` — leave it skipped.

## Git workflow

- Branch: `advisor/008-add-ci-workflow`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Run the verification gates in CI`.
- Do NOT push or open a PR. (Note: a workflow file has no effect until pushed;
  that is expected — the deliverable here is the committed configuration.)

## Steps

### Step 1: Confirm the baseline is green locally

Run each gate and record the result:

```bash
bun run typecheck && bun test
```

Then, separately (each may fail for environmental reasons — record which):

```bash
bun run build
bun run test:performance
bun run test:protocol
```

You need to know which gates pass on this machine before you can judge a CI
failure. If `bun run typecheck` or `bun test` fails here, STOP and report — CI
should not be introduced on a red tree.

### Step 2: Add a `verify` script

Add one script to `package.json` that chains the fast gates — the ones that
need no browser and no Swift toolchain:

```json
    "verify": "bun run typecheck && bun test && bun run build && bun run test:performance",
```

Keep every existing script exactly as it is. Place `verify` adjacent to
`typecheck` for readability.

**Verify**: `bun run verify` → exit 0.

If `bun run test:performance` is too slow to belong in a routine local command
(time it in step 1), drop it from `verify` and leave it to CI only — note the
decision in your report.

### Step 3: Write the workflow

Create `.github/workflows/verify.yml` with two jobs.

**Job `verify` (ubuntu-latest)** — the fast gate, runs on every push and PR:

1. `actions/checkout`
2. `oven-sh/setup-bun` (pin a major version)
3. `bun install --frozen-lockfile`
4. `bun run typecheck`
5. `bun test`
6. `bun run build`
7. `bun run test:performance`

**Job `e2e` (ubuntu-latest)** — browser tests:

1. Checkout, setup-bun, `bun install --frozen-lockfile`
2. Cache the Playwright browser download keyed on the `@playwright/test`
   version from `package.json` — without a cache this step dominates the run.
3. `bunx playwright install --with-deps chromium`
4. `bun run test:e2e`
5. On failure, upload `test-results/` as an artifact (`actions/upload-artifact`
   with `if: failure()`), since Playwright writes traces there.

**Job `protocol` (macos-latest)** — the cross-language gate:

1. Checkout, setup-bun, `bun install --frozen-lockfile`
2. `bun run test:protocol`
3. `swift test --package-path native/Packages/ArborClient`

macOS runners are the expensive ones. If that matters, gate the `protocol` job
with `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` so it
runs on main rather than on every PR — but say which you chose in your report.

Set a sensible `timeout-minutes` on each job (10 for `verify`, 20 for the
others) so a hang does not burn the runner budget.

Do **not** add `ARBOR_TEST_POSTGRES_DSN` to the environment; that suite must
stay skipped.

**Verify**: the file is valid YAML:

```bash
bun -e 'import { parse } from "yaml"; import { readFileSync } from "node:fs"; const doc = parse(readFileSync(".github/workflows/verify.yml", "utf8")); console.log("jobs:", Object.keys(doc.jobs)); console.log("triggers:", Object.keys(doc.on));'
```

Expected: three job names printed, and triggers including `push` and
`pull_request`.

### Step 4: Cross-check the workflow against the README

Compare the workflow's steps against `README.md:39-49` line by line. Every gate
in the README must appear in some job, and every job step must correspond to a
real script in `package.json`.

**Verify**: for each `bun run <script>` in the workflow,
`bun run <script> --help` or a `grep` of `package.json` confirms the script
exists. A workflow referencing a nonexistent script fails only once pushed,
which is exactly the feedback loop this plan is trying to close.

### Step 5: Update the README

In `README.md`'s Testing section, add one line above the existing command list
noting that `bun run verify` runs the fast gates in one step, and that CI runs
the full list on every push. Leave the existing eight-command list in place —
it documents what CI does and remains useful for running an individual gate.

Match the README's existing voice: plain declarative prose, no bullet-point
restructuring of the surrounding text.

**Verify**: `bun run verify` → exit 0 (unchanged behavior, confirming the
README's new claim is true).

### Step 6: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

**Verify**: `git status --short` shows exactly three changed/added paths:
`.github/workflows/verify.yml`, `package.json`, `README.md`.

## Test plan

This plan adds no tests — it runs the existing ones. Its correctness criteria
are structural:

- Every gate listed in `README.md:39-49` appears in the workflow.
- Every script the workflow invokes exists in `package.json`.
- The YAML parses and declares three jobs.
- `bun run verify` succeeds locally.

Note in your report that the workflow itself is **unverified until pushed** —
you cannot execute GitHub Actions locally. That is an honest limitation of this
plan, not a step to fake.

## Done criteria

ALL must hold:

- [ ] `.github/workflows/verify.yml` exists and parses as YAML with three jobs
- [ ] Every `bun run <script>` referenced by the workflow exists in `package.json`
- [ ] `bun run verify` exits 0
- [ ] `bun run typecheck` exits 0 and `bun test` passes
- [ ] The `protocol` job runs both `bun run test:protocol` and `swift test`
- [ ] The `e2e` job caches the Playwright browser and uploads `test-results/`
      on failure
- [ ] `ARBOR_TEST_POSTGRES_DSN` appears nowhere in the workflow
- [ ] No file under `packages/` or `tests/` is modified
- [ ] `plan/generated/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- A `.github/` directory or any CI configuration already exists.
- `bun run typecheck` or `bun test` fails at step 1 — do not add CI to a red
  tree.
- `bun install --frozen-lockfile` fails locally, which would mean `bun.lock` is
  out of sync with `package.json` and CI could never install.
- You are tempted to modify, skip, or delete any of the flaky tests named under
  "Current state". Report the flake instead; fixing it is separate work with its
  own risk.

## Maintenance notes

- `bun run verify` and the CI `verify` job must stay in sync. If a gate is added
  to one, add it to the other — the whole point is a single list.
- Three known flake sources will surface in CI sooner or later: the fixed
  `setTimeout` sleeps in `tests/unit/fs.test.ts`, the order-dependent search
  assertion in `tests/integration/workspace.test.ts:156`, and the three files
  that mutate `process.env.ARBOR_DATA_HOME` without restoring it. When one
  fails, fix the test — converting a fixed sleep to a bounded poll loop, per
  the pattern at `tests/integration/cli-sync.test.ts:128` — rather than
  retrying the job.
- A reviewer should confirm the `protocol` job actually runs Swift, since that
  gate is the one no contributor runs by hand.
- Deliberately deferred: no linter or formatter is added here. The codebase has
  a consistent hand-maintained house style, and introducing a formatter means a
  20K-line reformat commit — a separate decision with real conflict cost
  against in-flight work.
