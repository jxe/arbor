# Plan 006: Stop rebuilding the whole index on every move or delete

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plan/hardening/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/stores/src/indexer.ts packages/arbord/src/workspace.ts`
> Also run `git status --short` on those paths. If the excerpts under "Current
> state" do not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — the FTS5 table is an external-content table, so index rows
  must be deleted with the *old* content or the index silently desynchronizes
  from `files`.
- **Depends on**: none (but see the note about `plan/hardening/001-*` under Scope)
- **Category**: perf
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

When a file is moved or deleted, arbord calls `this.index.rebuild()` with **no
discovery argument**. With no argument, `rebuild` runs `discoverWorkspace(root)`
— a full recursive walk that reads and Markdown-parses every `.md` in the tree —
and then issues an FTS5 `'rebuild'` command that reindexes the entire corpus.

A rename in the sidebar is a routine editor action. The repo's own benchmark
sizes the target workspace at 50,000 files with a 5-second startup budget, and
arbord can be pointed at a home directory. Paying that cost again on every
single move or delete is the difference between an editor that feels instant
and one that stalls.

The incremental machinery already exists and is already used for single-file
changes: `updateAbsolute` and `deleteIndexedPath` do targeted `'delete'` +
insert pairs. This plan routes move and delete through them.

## Current state

Files involved:

- `packages/arbord/src/workspace.ts` — dispatches watcher events to the index.
- `packages/stores/src/indexer.ts` — `WorkspaceIndex`; rebuild and incremental paths.

The dispatch, `packages/arbord/src/workspace.ts:1185-1192`:

```ts
        this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
        await Promise.all([
          this.index.rebuild(discovery),
          this.generateTypes(discovery),
        ]);
      } catch {}
    } else if (event.type === "moved" || event.type === "deleted") await this.index.rebuild().catch(() => {});
    else if (event.type !== "diagnostic") await updateIndex(event.path).catch(() => {});
```

Note the `batch` branch above passes `discovery`; only the move/delete branch
calls `rebuild()` bare. Note also that every one of these is `.catch(() => {})`
— indexing failures are silent today. Preserve that behavior; do not add error
surfacing in this plan.

The incremental single-file path, `packages/stores/src/indexer.ts:125-134`:

```ts
  async updateAbsolute(path: string): Promise<void> {
    const treePath = nodePathFromPhysical(toTreePath(this.root, path));
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      await this.indexFile(path, treePath, info.mtimeMs, info.size);
    } catch {
      this.deleteIndexedPath(treePath);
    }
  }
```

`updateAbsolute` already handles the delete case correctly: if `stat` fails
(file gone), it removes the indexed path. So a **delete** event needs nothing
more than calling `updateAbsolute(path)`.

A **move** needs two operations — remove the old logical path, add the new one.
`deleteIndexedPath` is currently `private`; check its declaration at
`packages/stores/src/indexer.ts:189`.

The correct FTS5 delete pattern is visible in `deleteIndexedPath`,
`packages/stores/src/indexer.ts:189-199`:

```ts
  private deleteIndexedPath(treePath: string): void {
    const transaction = this.database.transaction(() => {
      const previous = this.database.query("SELECT rowid, path, title, body FROM files WHERE path = ?").get(treePath) as { rowid: number; path: string; title: string; body: string } | null;
      if (!previous) return;
      this.database.prepare("INSERT INTO docs(docs, rowid, path, title, body) VALUES ('delete', ?, ?, ?, ?)").run(previous.rowid, previous.path, previous.title, previous.body);
      this.database.prepare("DELETE FROM links WHERE source_path = ?").run(treePath);
      this.database.prepare("DELETE FROM files WHERE path = ?").run(treePath);
    });
    transaction();
  }
```

The `'delete'` row must carry the **previous** title and body — that is the
external-content contract. Any new code path that removes a row must follow
this shape exactly.

The schema and its indexes, `packages/stores/src/indexer.ts:71-76`:

```ts
    this.database.exec("CREATE TABLE IF NOT EXISTS links(source_path TEXT NOT NULL, target_path TEXT, target_page_id TEXT, context TEXT NOT NULL);");
    this.database.exec("CREATE INDEX IF NOT EXISTS links_target_path ON links(target_path);");
    this.database.exec("CREATE INDEX IF NOT EXISTS links_target_page_id ON links(target_page_id);");
```

There is no index on `links.source_path`, yet
`DELETE FROM links WHERE source_path = ?` runs in `deleteIndexedPath` and again
in `replaceLinks` — once per file on every single-file index, and once per
changed file inside the rebuild transaction. Each is a full table scan.

Repo conventions:

- SQLite work uses `bun:sqlite` `Database`, wrapped in
  `this.database.transaction(() => { ... })` and then invoked. Match that shape.
- Schema evolution is handled in the constructor with `CREATE ... IF NOT EXISTS`
  plus an explicit drop-and-recreate migration check at
  `packages/stores/src/indexer.ts:67-70`. Additive indexes just need
  `CREATE INDEX IF NOT EXISTS`.
- Tests: `bun:test`, `tests/unit/*.test.ts`, `mkdtemp` fixtures with cleanup.

## Commands you will need

| Purpose      | Command                                          | Expected on success             |
|--------------|--------------------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                              | exit 0, no output               |
| Tests        | `bun test`                                       | all pass (155 before this plan) |
| Workspace    | `bun test tests/integration/workspace.test.ts`   | all pass                        |
| Benchmark    | `bun run test:performance`                       | exit 0, asserted thresholds met |

`bun run test:performance` runs `tests/performance/indexer.bench.ts`, which
asserts hard thresholds. It is the primary evidence that this plan achieved
anything — run it before and after and record both numbers.

## Scope

**In scope**:

- `packages/stores/src/indexer.ts`
- `packages/arbord/src/workspace.ts` (the single dispatch line at `:1191`)
- `tests/unit/indexer.test.ts` (create, or extend if `plan/hardening/001-*` created it)
- `tests/performance/indexer.bench.ts` (add a move/delete measurement — optional, see step 5)

**Out of scope** (do NOT touch):

- The `search()` method and the excerpt shape. If `plan/hardening/001-escape-search-excerpts.md`
  has landed, `search()` returns structured segments; if it has not, it returns
  an HTML string. Either way, **do not modify `search()` in this plan.** If both
  plans are in flight, land 001 first to avoid a conflict in the same file.
- `discoverWorkspace` in `packages/fs/src/discovery.ts` — making the walk
  concurrent is separate work.
- The `batch` branch at `packages/arbord/src/workspace.ts:1186` — it correctly
  passes `discovery` already.
- Error surfacing. Every index call is `.catch(() => {})` today; keep it.

## Git workflow

- Branch: `advisor/006-incremental-index-updates`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Update the index incrementally on move and delete`.
- Do NOT push or open a PR.

## Steps

### Step 1: Record the baseline

```bash
bun run test:performance
```

Record the reported numbers. Expected: exit 0 with the thresholds in
`tests/performance/indexer.bench.ts:48-50` met. If it already fails before you
change anything, STOP and report — you cannot attribute a later failure.

### Step 2: Add the missing `links.source_path` index

In the `WorkspaceIndex` constructor in `packages/stores/src/indexer.ts`, add
alongside the two existing index statements:

```ts
    this.database.exec("CREATE INDEX IF NOT EXISTS links_source_path ON links(source_path);");
```

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

**Verify**: the index exists on a fresh database:

```bash
bun -e 'import { WorkspaceIndex } from "@arbor/stores"; import { mkdtemp, rm } from "node:fs/promises"; import { join } from "node:path"; import { tmpdir } from "node:os"; const dir = await mkdtemp(join(tmpdir(), "arbor-idx-")); const index = new WorkspaceIndex(dir, join(dir, "index.sqlite")); console.log(index["database"].query("SELECT name FROM sqlite_master WHERE type = ?").all("index").map((r) => r.name)); index.close(); await rm(dir, { recursive: true, force: true });'
```

Expected: the printed list includes `links_source_path`. (If importing from
`@arbor/stores` fails, use the relative module path
`./packages/stores/src/indexer.ts` instead.)

### Step 3: Add a targeted move/delete API to `WorkspaceIndex`

Add a public method that handles a path disappearing and, optionally, a path
appearing — for example:

```ts
  async applyMove(previousAbsolutePath: string | undefined, nextAbsolutePath: string | undefined): Promise<void>
```

Behavior:

- If `previousAbsolutePath` is given, convert it to a tree path the same way
  `updateAbsolute` does (`nodePathFromPhysical(toTreePath(this.root, path))`)
  and call `deleteIndexedPath(treePath)`.
- If `nextAbsolutePath` is given, call `this.updateAbsolute(nextAbsolutePath)`.
- Do **not** issue `INSERT INTO docs(docs) VALUES('rebuild')`. The targeted
  `'delete'` + insert pairs inside `deleteIndexedPath` and `indexFile` keep the
  external-content index consistent on their own.

You will likely need to widen `deleteIndexedPath` from `private` to `private`
-callable-from-the-new-method (same class, so no change needed) — confirm.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Route the move/delete event through it

First, determine what the watcher event actually carries. Inspect the event
type around `packages/arbord/src/workspace.ts:1191` and its declaration
(`grep -n "moved" packages/arbord/src/workspace.ts` and find the event
interface). You need to know whether a `moved` event supplies **both** the old
and the new path.

- **If it supplies both**, replace the branch with a call to `applyMove(old, new)`.
- **If a `moved` event supplies only one path**, then a move arrives as a
  delete plus a create, or the old path is unavailable. In that case handle
  `deleted` with `applyMove(event.path, undefined)` and handle `moved` with
  whatever paths are available — and **write down in your report** exactly what
  the event carries, since that determines whether stale rows can linger.

Keep the `.catch(() => {})` wrapper.

The line becomes something like:

```ts
    } else if (event.type === "moved" || event.type === "deleted") await this.index.applyMove(...).catch(() => {});
```

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `grep -n "index.rebuild()" packages/arbord/src/workspace.ts` returns
no matches (the bare, discovery-less call is gone; the `rebuild(discovery)` call
in the batch branch remains).

### Step 5: Test that the index actually tracks moves and deletes

Add tests to `tests/unit/indexer.test.ts` (create it if `plan/hardening/001-*` did not).
Use `tests/unit/journal.test.ts` as the structural exemplar for fixtures.

Cover:

1. **Delete removes the row**: index a file, confirm `search()` finds it, delete
   the file from disk, call the delete path, confirm `search()` no longer
   returns it.
2. **Move relocates the row**: index a file, move it on disk, apply the move,
   confirm `search()` returns the **new** path exactly once and never the old
   one. This is the assertion that catches a desynchronized external-content
   index.
3. **Links follow**: index a file containing a Markdown link, delete it, and
   confirm `backlinks(...)` no longer reports it as a source.
4. **No stale FTS rows**: after a move, assert the `files` table has exactly one
   row for the document. A desynchronized FTS index typically shows up as
   duplicate search hits.

Also add an integration check in `tests/integration/workspace.test.ts` that a
rename through the workspace's normal mutation API leaves search returning the
new path. Use a bounded poll loop (see `tests/integration/cli-sync.test.ts:128`)
rather than a fixed `setTimeout` — the indexer runs in the background.

**Verify**: `bun test tests/unit/indexer.test.ts tests/integration/workspace.test.ts` → all pass.

### Step 6: Measure

```bash
bun run test:performance
```

Compare against the step 1 baseline. The startup number should be unchanged
(this plan does not touch startup). If the benchmark file has a move/delete
case, its number should improve substantially; if it does not, consider adding
one — a loop of N renames over the benchmark's existing fixture tree, asserting
a threshold well under the full-rebuild cost. Adding it is optional but is the
only durable protection against this regressing.

**Verify**: `bun run test:performance` → exit 0, thresholds met.

### Step 7: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

## Test plan

- Unit (`tests/unit/indexer.test.ts`): the four cases in step 5. Case 2 and
  case 4 together are the load-bearing pair — they detect an FTS index that has
  drifted from the `files` table, which is the specific way this change can go
  wrong.
- Integration (`tests/integration/workspace.test.ts`): rename through the real
  mutation path, search reflects it.
- Performance (`tests/performance/indexer.bench.ts`): baseline recorded in step
  1, compared in step 6.
- Structural patterns: `tests/unit/journal.test.ts` for fixtures,
  `tests/integration/cli-sync.test.ts:128` for polling.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0, including the new indexer tests
- [ ] `bun run test:performance` exits 0 with thresholds met, and the numbers
      are reported alongside the step 1 baseline
- [ ] `grep -n "index.rebuild()" packages/arbord/src/workspace.ts` returns no
      matches
- [ ] `grep -n "VALUES('rebuild')" packages/stores/src/indexer.ts` appears only
      inside the full `rebuild` method, not in the new move/delete path
- [ ] `grep -n "links_source_path" packages/stores/src/indexer.ts` returns a match
- [ ] The `search()` method is unmodified (`git diff packages/stores/src/indexer.ts`)
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `plan/hardening/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun run test:performance` fails at step 1, before any change.
- The watcher `moved` event does not carry enough information to identify the
  old path, and you cannot determine from the code whether a move also emits a
  `deleted` for the old path. Report what the event carries; do not guess, and
  do not fall back to a full rebuild silently.
- Step 5 case 2 or case 4 fails in a way that suggests the FTS external-content
  index has drifted — report the symptom rather than adding a `'rebuild'` call
  to paper over it. A `'rebuild'` in the incremental path defeats the entire
  purpose of this plan.
- `plan/hardening/001-escape-search-excerpts.md` is mid-flight and has uncommitted
  changes to `packages/stores/src/indexer.ts`.

## Maintenance notes

- The FTS5 `docs` table is an **external-content** table over `files`. Every
  removal must first insert a `'delete'` row carrying the previous rowid, path,
  title, and body. Any future code path that removes a file row must follow
  `deleteIndexedPath`'s shape; a plain `DELETE FROM files` silently corrupts the
  index.
- Full `rebuild` remains correct and is still used for `batch` events and
  startup. It is the fallback if incremental state is ever suspected to have
  drifted.
- A reviewer should check that no `'rebuild'` command reaches the move/delete
  path, and that the move test asserts exactly-one search hit.
- Deliberately deferred: `rebuild` still uses `statSync`/`readFileSync` in a
  serial loop, blocking the single-threaded daemon during startup and batch
  rebuilds, and `discoverWorkspace` walks directories serially. Both are real
  and both are larger than this plan.
