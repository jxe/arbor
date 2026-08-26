# Plan 004: Serialize write-journal appends so counters cannot collide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plan/hardening/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/fs/src/journal.ts packages/fs/src/workspace-fs.ts`
> Also run `git status --short` on those paths. If the excerpts under "Current
> state" do not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

The write journal is what lets Arbor recover a user's in-progress edit after a
crash. Every journal record carries a monotonic counter `c`, and recovery
depends on it: `fold` orders records by `c` to decide each block's final state,
and `reconcile` compares a record's counter against a persisted watermark to
decide whether a block was already materialized.

`append` reads the current counter and only later appends the record — a
check-then-act on a shared file with nothing serializing it. Two overlapping
appends read the same value and emit records with duplicate `c`. That makes
`fold`'s ordering nondeterministic and can place a live block below the
watermark, so recovery either resurrects a block the user deliberately deleted
or fails to restore one the crash lost.

Overlap is not hypothetical: `WorkspaceFS.handleWatch` calls
`journal.observe(...)` with no coordinator lock, while `writeMarkdownInternal`
calls `journal.commit(...)` under the node coordinator. The two paths share the
journal file but not the lock, and the watcher fires precisely when the user is
editing. After this plan, counter assignment and the file append are atomic
within the process.

## Current state

Files involved:

- `packages/fs/src/journal.ts` — `WriteJournal`; the append/counter logic.
- `packages/fs/src/workspace-fs.ts` — calls `journal.commit` (locked) and
  `journal.observe` (unlocked) from different paths.

`packages/fs/src/journal.ts:118-130`:

```ts
  private async append(pageID: string, entries: Array<Omit<JournalRecord, "c" | "t">>): Promise<void> {
    if (!entries.length) return;
    const path = this.path(pageID);
    await mkdir(dirname(path), { recursive: true });
    let counter = await this.counter(pageID);
    const now = Date.now() / 1_000;
    const records = entries.map((entry) => ({ ...entry, t: now, c: ++counter }));
    await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
    const file = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    try { await file.sync(); } finally { await file.close(); }
    this.counters.set(pageID, counter);
  }
```

Every `await` between reading `counter` and writing `this.counters` is an
interleaving point.

The counter cache, `packages/fs/src/journal.ts:165-172`:

```ts
  private async counter(pageID: string): Promise<number> {
    const cached = this.counters.get(pageID);
    if (cached !== undefined) return cached;
    const records = await this.read(pageID);
    const value = records.reduce((max, record) => Math.max(max, record.c), 0);
    this.counters.set(pageID, value);
    return value;
  }
```

The class declares its cache at `packages/fs/src/journal.ts:51-53`:

```ts
export class WriteJournal {
  private counters = new Map<string, number>();
  constructor(private directory: string) {}
```

The unlocked caller is `packages/fs/src/workspace-fs.ts:1327` — inside
`handleWatch`, `await this.journal.observe(id, ...)` with no
`coordinator(path).exclusive(...)` around it. The locked caller is
`writeMarkdownInternal` at `packages/fs/src/workspace-fs.ts:475`.

**The pattern to follow.** This repo already solves exactly this problem with a
per-key promise chain: `NodeCoordinator` in
`packages/fs/src/workspace-fs.ts:60-160`. Read it before writing code and match
its shape — a `Map` from key to a tail promise, where each new operation chains
onto the tail and the tail is replaced. Do not invent a different mechanism and
do not add a dependency.

Repo conventions:

- Journal tests live in `tests/unit/journal.test.ts` (`bun:test`, `mkdtemp`
  into `tmpdir()`, an `afterEach` that removes created directories). That is
  your structural exemplar.
- `WriteJournal` is imported in tests from `@arbor/arborsync` (see
  `tests/unit/journal.test.ts:6`), not by relative path.

## Commands you will need

| Purpose      | Command                                 | Expected on success             |
|--------------|-----------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                     | exit 0, no output               |
| Tests        | `bun test`                              | all pass (155 before this plan) |
| Journal unit | `bun test tests/unit/journal.test.ts`   | all pass                        |
| FS unit      | `bun test tests/unit/fs.test.ts`        | all pass (includes fault injection) |

## Scope

**In scope**:

- `packages/fs/src/journal.ts`
- `tests/unit/journal.test.ts` (add tests)

**Out of scope** (do NOT touch):

- `packages/fs/src/workspace-fs.ts` — it is tempting to also wrap the
  `handleWatch` → `journal.observe` call in the node coordinator. Do **not**:
  `read()` is called from inside coordinator-held sections, so a naive
  `exclusive()` there self-deadlocks. Serializing inside `WriteJournal` is the
  safe fix and is sufficient for this defect. The broader locking question is
  recorded as a separate finding.
- `MutationJournal` (also in `journal.ts`, if present) — this plan covers
  `WriteJournal.append` and its callers only.
- The journal record format and the watermark file format — unchanged.

## Git workflow

- Branch: `advisor/004-serialize-journal-append`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Serialize journal appends per page`.
- Do NOT push or open a PR.

## Steps

### Step 1: Write a failing test for concurrent appends

Add a test to `tests/unit/journal.test.ts` that drives two journal operations
concurrently on the same page ID and asserts every record's counter is unique.

Shape:

1. `mkdtemp` a directory and construct `new WriteJournal(directory)`.
2. Fire two overlapping operations with `Promise.all` — e.g. two `commit(...)`
   calls with different block sets, or a `commit` racing an `observe`. Check
   the public method signatures at the top of the `WriteJournal` class and use
   whichever two are simplest to call; they both funnel into `append`.
3. Read the journal file back. The path is derived by the private `path(pageID)`
   method; rather than reaching into private state, read the directory with
   `readdir` and pick the file, or use the public `list(pageID, blocks)` API if
   it exposes what you need. Parse each line as JSON.
4. Assert `new Set(records.map(r => r.c)).size === records.length` — every
   counter is distinct.

**Verify**: `bun test tests/unit/journal.test.ts` → the new test FAILS with
duplicate counters.

If it passes before any fix, the race is not reproducible this way. Try
increasing the number of concurrent operations to 5–10. If it still passes,
STOP and report — do not proceed to write a fix for a race you cannot observe,
and note in your report that the defect may already be mitigated.

### Step 2: Add a per-page promise chain to `WriteJournal`

Add a private tail map alongside the existing counter cache:

```ts
  private tails = new Map<string, Promise<void>>();
```

Add a private helper that chains work per page ID, modeled on `NodeCoordinator`
in `packages/fs/src/workspace-fs.ts:60-160`:

```ts
  private exclusive<T>(pageID: string, work: () => Promise<T>): Promise<T> { ... }
```

It must:

- Chain onto the existing tail for that `pageID` (or a resolved promise if
  none), so operations run one at a time per page.
- Replace the stored tail with a promise that settles after `work` completes,
  **including when `work` rejects** — otherwise one failure wedges the page
  forever. Follow how `NodeCoordinator` handles this; if it swallows rejections
  on the tail while still propagating them to the caller, do the same.
- Return the caller's result/rejection unchanged.
- Not leak entries indefinitely: if `NodeCoordinator` prunes settled tails,
  match that; if it does not, leave a brief comment noting the map grows with
  distinct page IDs and move on (bounded by pages edited in a session).

Then wrap the body of `append` in it:

```ts
  private async append(pageID: string, entries: Array<Omit<JournalRecord, "c" | "t">>): Promise<void> {
    if (!entries.length) return;
    return this.exclusive(pageID, async () => { /* existing body */ });
  }
```

Critically, the `counter(pageID)` read must be **inside** the exclusive section,
together with the `appendFile` and the `this.counters.set(...)`.

**Verify**: `bun test tests/unit/journal.test.ts` → the step 1 test now PASSES.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Confirm no self-deadlock

`append` is called from `commit`, `observe`, and any other public method that
writes records. If one of those public methods calls another that also calls
`append` — i.e. a nested `exclusive` on the same page ID — the chain
deadlocks.

Check with: `grep -n "this.append(" packages/fs/src/journal.ts` and inspect
every caller. Confirm none of them is itself already inside `exclusive` for the
same page.

**Verify**: `bun test tests/unit/journal.test.ts` completes without hanging
(a deadlock manifests as a test timeout, not a failure).

**Verify**: `bun test tests/unit/fs.test.ts` → all pass and completes. This
suite includes the fault-injection crash-recovery cases, which exercise the
journal end to end; a hang here means a deadlock in a real path.

### Step 4: Add a recovery-ordering test

Add one more test asserting that after concurrent appends, recovery still
behaves correctly — that the fix protects the property that motivated it, not
just counter uniqueness.

Model it on the existing `restores an edit journaled before a simulated file-write crash`
test in `tests/unit/journal.test.ts:14`: journal an edit, race it against a
second journal operation on the same page, then call `reconcile(...)` and assert
the expected block is restored exactly once (not duplicated, not missing).

**Verify**: `bun test tests/unit/journal.test.ts` → all pass.

### Step 5: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass, and the run completes in roughly its usual
time (the suite took about 3.4 seconds before this plan; a large increase
suggests unintended serialization across unrelated pages).

## Test plan

- Test A (step 1): concurrent appends produce distinct counters. This is the
  regression test — it must fail before the fix.
- Test B (step 4): recovery after concurrent appends restores the right block
  exactly once.
- Structural pattern: `tests/unit/journal.test.ts`, existing tests.
- The whole of `tests/unit/fs.test.ts` acts as the integration check, since its
  fault-injection cases drive the journal through real crash recovery.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0 with no test timing out
- [ ] Test A fails when the `exclusive` wrapper is removed from `append`
      (verify this explicitly, then restore)
- [ ] `grep -n "private tails" packages/fs/src/journal.ts` returns a match
- [ ] `packages/fs/src/workspace-fs.ts` is unmodified (`git status --short`)
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `plan/hardening/README.md` status row for 004 updated

## STOP conditions

Stop and report back if:

- Step 1's test cannot be made to fail even with 10 concurrent operations.
- Any test hangs after step 2 — that is a deadlock. Report which test and which
  call path, do not add timeouts to work around it.
- `grep -n "this.append(" packages/fs/src/journal.ts` shows a caller that is
  already inside an `exclusive` section for the same page ID.
- The fix appears to require changing `packages/fs/src/workspace-fs.ts`.
- `tests/unit/fs.test.ts` fault-injection cases fail after the change.

## Maintenance notes

- The serialization is **per page ID and in-process only**. It does not protect
  against two arborsync processes writing the same journal file. That is a
  deliberate boundary: Arbor assumes one daemon per data home.
- If a future change adds a public `WriteJournal` method that writes records,
  it must go through `append` (and therefore through `exclusive`) rather than
  calling `appendFile` directly.
- A reviewer should check that the `counter()` read sits inside the exclusive
  section — a fix that only wraps `appendFile` does not close the race.
- Deliberately deferred and worth its own plan: `WorkspaceFS.read()` performs a
  journal-recovery repair write (`packages/fs/src/workspace-fs.ts:381-389`)
  with no node lock and no base-revision check, and `handleWatch` calls `read()`
  outside the coordinator. That is a separate data-loss risk this plan does not
  address, and fixing it requires splitting `read()` to avoid re-entrant
  deadlock.
