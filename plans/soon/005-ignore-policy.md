# Filesystem 005: Keep ignored filesystem content outside Overstory trees

Historical identifier: **Security 005**. The filename number is preserved; this plan now belongs to filesystem.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Treat ignore matching as one filesystem-membership policy shared
> by discovery, listing, watching, snapshots, filesystem object reads, and
> materialization; do not add independent filters to those consumers. If
> anything in the "STOP conditions" section occurs, stop and report rather
> than improvising. When complete, record verification evidence in
> `status.md`, delete this file, and remove its entry from `plans/README.md`
> and `plans/catalog.md`.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat e66f8a02..HEAD -- \
>   packages/fs/src packages/arborsync/src/folder-sync.ts \
>   packages/arborsync/src/declined-paths.ts packages/arborsync/src/service.ts \
>   packages/arborsync/src/filesystem-object-source.ts \
>   swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/LocalFolderPreview.swift
> git status --short
> ```
>
> If the files named under "Current state" no longer behave as described,
> stop and reconcile the plan first.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH (a wrong filter silently uploads secrets or deletes local files)
- **Depends on**: none
- **Category**: security, correctness, and filesystem architecture
- **Planned at**: commit `ce51a4e`, 2026-09-07; revised against `e66f8a02`,
  2026-09-25, after the FolderSync rewrite made a separate
  tracked-membership store unnecessary

## Outcome

Overstory has one explicit filesystem-membership policy. It keeps the
mandatory exclusions for Overstory-private and generated directories, adds
portable `.arborignore` files, and reads ordinary `.gitignore` files as a
compatibility source. A matching untracked local path is opaque to Overstory.
It is not shown as a tree child, indexed, included in a snapshot, uploaded,
overwritten, or deleted during materialization.

A path already present in the root the folder last held is **tracked**. It
stays synchronized even if a later ignore rule matches it, as in Git. It leaves
the tree only through an explicit deletion. After that, a surviving or
recreated local copy is untracked and opaque. An ignore-file edit therefore can
never publish a tree-wide deletion.

The policy has these fixed semantics:

1. `.arborignore` is Overstory's portable, authoritative spelling. `.gitignore`
   uses the same pattern grammar as a compatibility input. Both files remain
   ordinary included tree content and cannot ignore themselves.
2. Root and nested ignore files apply from their containing directory down.
   Match paths with `/` separators, Git-style anchoring, directory rules,
   comments, escaping, and `!` negation. Do not invoke Git or inspect its
   index.
3. Do not consult `.git/info/exclude`, `core.excludesFile`, or a global Git
   ignore file. Those machine-private sources would make the same placement
   produce a device-dependent tree. A future placement-private ignore option
   belongs in `placements.yaml` and is not part of this plan.
4. The mandatory exclusions keep their stronger treatment: `.git`,
   `node_modules`, `.arbor`, `Trash`, `.build`, `DerivedData`, transaction
   temporaries, iCloud placeholders, nested tree mounts, and symlinks. A negated
   user pattern cannot re-include them.
5. An ignore file that is not valid UTF-8 contributes no patterns and produces
   a structured local diagnostic that names the file but not its contents. It
   does not block synchronization. Tracked content is unaffected either way,
   and the diagnostic tells the user their rules are not applying.
6. Ignored paths never cause pull cleanup. An accepted remote entry is still
   written because it is tracked. After an accepted remote deletion of a
   tracked path that a rule now matches, the local bytes are kept, become
   untracked, and are not re-uploaded while the rule matches.

## Why this matters

Overstory synchronizes every ordinary file except a short hard-coded set of
directory names. A developer who places a repository can reasonably expect its
ignored `.env`, credential files, caches, and build output to stay local.
Overstory currently snapshots and uploads them, which risks disclosing secrets
and goes against what the user expects.

Applying ignore rules only in the sidebar or search would be worse than having
no rules at all. Invisible files could still upload, or a pull could delete
content Overstory claimed not to own. The filter therefore belongs at the shared
`@overstory/fs` walk and has to be proven consistent across every consumer.

## Current state

- `packages/fs/src/discovery.ts` exports `IGNORED_WORKSPACE_DIRECTORIES`,
  `isIgnoredWorkspaceDirectory`, and `WORKSPACE_WATCHER_IGNORE_GLOBS`.
  `discoverWorkspace()` is consumed only by `WorkspaceFS`
  (`workspace-fs.ts:85,100,109`), whose discovery result feeds page-ID
  loading, search indexing, and generated collection types.
- `packages/fs/src/workspace-fs.ts` filters `list()` with the same set and
  passes the static globs to `@parcel/watcher` (`:364`).
- `packages/fs/src/protocol-tree.ts` checks the set again in
  `snapshotDirectory()` (`:148`) and in the cleanup loop of `materializeTree()`
  (`:260`). Both already accept a list of excluded absolute roots.
  `snapshotDirectory()` also accepts a `SnapshotObjectIndex` whose
  `directoryHash` shortcut returns a cached directory hash without walking.
- `packages/arborsync/src/service.ts:scanWorkspace()` (`:514`) is the folder
  scan. FolderSync reaches it through `host.scan()`
  (`folder-sync.ts:51`, wired at `service.ts:484`).
- `packages/arborsync/src/folder-sync.ts` durably records `known.root`, the
  root the folder last held (written or scanned), and reaches the accepted root
  through `accepted()`. It already masks paths against a root:
  `publishable()` (`:295`) substitutes accepted content at declined points, and
  `write()` (`:363`) passes declined points to `materializeTree` as exclusions,
  then verifies the rescanned folder against the root. `declined-paths.ts`
  provides `entryAt(root, path, load)`.
- `packages/arborsync/src/filesystem-object-source.ts` rebuilds directory
  bytes from disk (`:74`) and audits file rows (`:100`) by calling
  `snapshotDirectory` directly. Its rebuilt directory hashes must match what
  the folder scan produced.
- `swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/LocalFolderPreview.swift:27`
  keeps its own copy of the directory set for the pre-placement preview
  (`CanopyAppModel.swift:1376`).
- `packages/arborsync/src/state/placements.ts` accepts only scalar
  `path: TreeID` entries. Do not widen it.

**Tracked** needs no new state. A path is tracked when
`entryAt(knownRoot, path)` is non-null, and FolderSync already persists
`known.root` together with its basis. Existing placements therefore need no
upgrade step: a `.env` they already uploaded is in `known.root` and stays
tracked.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused filesystem tests | `bun test tests/unit/discovery.test.ts tests/unit/protocol-objects.test.ts tests/integration/workspace.test.ts` | all pass |
| Synchronization tests | `bun test tests/integration/self-sync.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Product suite | `bun run test` | all pass (see the known parallel-only flakes in memory/status) |
| Protocol suite | `bun run test:protocol` | all pass |
| Swift preview tests | `swift test` in `swift/Packages/CanopyWorkingTree` | all pass |
| Links and diff hygiene | `bun run check:links && git diff --check` | exit 0 |

Do not commit, push, or run a long-lived daemon unless Joe asks. If you add a
dependency, change `bun.lock` narrowly.

## Scope

**In scope**: a policy module under `packages/fs/src/` and its export;
`discovery.ts`, `workspace-fs.ts`, and `protocol-tree.ts`; the FolderSync,
service and filesystem-object-source wiring; `LocalFolderPreview.swift`; a
shared matcher fixture; the tests listed below; `packages/fs/README.md`,
`docs/architecture/arborsync/data-home.md`,
`docs/overstory-spec/02-directory-format.md`; the plan index.

**Out of scope**: Git index integration or shelling out to Git; machine-global
Git sources; widening `placements.yaml`; an `arbor untrack` command (see
Maintenance notes); marking ignored paths in the Mac app's "what it would
publish" view (a Native follow-up); changing Overstory object shapes, canopyd,
or nested-tree semantics; following symlinks.

## Steps

### Step 1: Freeze matcher behavior in a shared fixture

Write `tests/fixtures/ignore-policy/cases.json`, a table of
`{ files: {path: contents}, path, isDirectory, ignored }` cases covering:

- root and nested `.arborignore` and `.gitignore`;
- comments and escaped leading `#`/`!`;
- anchored patterns, directory-only rules, `**`, and negation, including
  negation that cannot re-include a file whose parent directory is excluded;
- Unicode names and `/` normalization;
- that both control files are always included;
- that mandatory exclusions cannot be negated.

Add a pure `bun:test` runner for the fixture. The Swift port in Step 5 runs the
same file.

**Verify**: the runner exists and fails only because the module is missing.

### Step 2: One immutable ignore policy

Create `packages/fs/src/ignore-policy.ts`. Prefer a maintained Git-compatible
matcher (the `ignore` package is the obvious candidate) over a new glob engine.
Its interface:

- `loadIgnorePolicy(root, { excludedRoots })` returns one immutable
  `IgnorePolicy` for a single operation;
- `policy.decision(treePath, isDirectory)` returns
  `"included" | "mandatory" | "ignored"` together with the matching source file
  and pattern for diagnostics and tests;
- `policy.diagnostics` lists any control file that was not valid UTF-8.

Move the mandatory set into this module. `IGNORED_WORKSPACE_DIRECTORIES` stays
exported only for the watcher's static globs.

**Verify**: the fixture runner and `bun run typecheck` pass.

### Step 3: Discovery, listing, and watching

`discoverWorkspace()` loads one policy and uses it for both directory descent
and file admission. `WorkspaceFS.list()` and path resolution use the same
policy, so an ignored path does not become a node just because it was addressed
directly. Browsing with `discovery: "none"` stays path-addressable: the policy
limits tree membership, not which local files the user can open.

The static mandatory globs stay as a watcher optimization. Filter queued events
through the current policy. An event on `.arborignore` or `.gitignore` reloads
the policy and rediscovers once, then emits a tree-level invalidation.

`WorkspaceFS` does not know about tracked paths. Its discovery is the
local-browsing view. The synchronized tree is decided in Step 4.

**Verify**: `bun test tests/unit/discovery.test.ts tests/integration/workspace.test.ts`
passes, including external creation and removal of files and live ignore-file
edits.

### Step 4: Snapshot, materialization, and FolderSync

Give `snapshotDirectory()` and `materializeTree()` one new optional input,
`skip(treePath, isDirectory): Promise<boolean>`, which callers build from the
policy and a tracked root:

```ts
skip = decision === "ignored" && !(await entryAt(trackedRoot, treePath, load))
```

Evaluate it lazily and only for ignored paths, so an ordinary walk loads no
extra objects. Mandatory exclusions keep their current unconditional handling.
Then:

- `host.scan(trackedRoot)` takes the tracked root. FolderSync passes
  `known.root` when it compares or publishes (`install`, `scan`, `preview`,
  `restore`). In `write()` it passes the root it just wrote.
- `write()` passes the same `skip` to `materializeTree`, with the new root as
  the tracked root. Cleanup never deletes an ignored path that is absent from
  that root. Every tracked entry is still written, including one a rule now
  matches.
- Ignored filtering happens in the scan, before `publishable()` masks declined
  points, so the two mechanisms compose without knowing about each other.
- `FilesystemObjectSource` rebuilds and audits with the same policy and the
  folder's `known.root`, so a rebuilt directory hash matches the scan. A policy
  reload drops cached `directoryHash` rows beneath the directory containing the
  changed ignore file.
- The first placement of a folder that has no accepted base uses an empty
  tracked set, so ignores apply before the first snapshot.

**Verify**: `bun test tests/unit/protocol-objects.test.ts tests/integration/self-sync.test.ts`
passes the cases listed under "Test plan". Each self-sync case ends with the
expected accepted root and `sync: "idle"`.

### Step 5: Swift preview

`LocalFolderPreview` applies the same policy with an empty tracked set, so the
preview shows exactly what a first placement would publish. Port the matcher
to Swift inside `CanopyWorkingTree`, keep it small, and drive its tests from the
shared fixture. If the port cannot pass the fixture, stop. Do not ship two
matchers that disagree.

**Verify**: the Swift fixture tests pass.

### Step 6: Documentation and gates

- `docs/overstory-spec/02-directory-format.md`: `.arborignore`, its nested
  scope, that control files are included, the tracked rule, and the difference
  between tree content and opaque placement files.
- `packages/fs/README.md` and `docs/architecture/arborsync/data-home.md`:
  `.gitignore` compatibility, the mandatory exclusions, the UTF-8 diagnostic,
  the unsupported Git sources, and the untrack recipe (see Maintenance notes).
- Remove this plan's rows from `plans/README.md` and `plans/catalog.md`.

**Verify**: every command in "Commands you will need" passes.

## Test plan

1. A fresh ignored `.env`, an ignored directory, and an ignored Markdown page
   never appear in discovery, listing, PageID maps, search, generated types,
   snapshots, or published change graphs.
2. The shared fixture passes in TypeScript and Swift without a Git executable.
3. Live edits to `.arborignore` and `.gitignore` cause exactly one policy reload
   and rediscovery.
4. Mandatory exclusions, transaction files, symlinks, and nested mounts stay
   excluded under negated patterns.
5. A matching path already in `known.root` stays listed by the sync, is
   uploaded when edited, and is updated by a pull.
6. Deleting that tracked path locally publishes the deletion. A later local
   copy at the same path stays on disk, and the placement stays idle.
7. A remote deletion of a tracked path that a rule matches keeps the local
   bytes, and the placement returns to idle without uploading them again.
8. Materialization never deletes an ignored untracked file and still verifies
   the accepted root.
9. A restart with an ignored untracked file present reaches idle without a
   change.
10. `FilesystemObjectSource` rebuilds a directory containing ignored files to
    the scanned hash.
11. An ignore file that is not valid UTF-8 produces a diagnostic without its
    contents, and synchronization continues.
12. Global Git ignores and `.git/info/exclude` have no effect.

## STOP conditions

Stop and report back rather than improvising if:

- a coherent implementation requires putting ignore rules or local absolute
  paths into Overstory objects, synchronized account configuration, or canopyd;
- materialization would have to delete ignored local bytes to verify the root,
  or include them and so re-upload them;
- the tracked root that a scan needs is not available from FolderSync's durable
  record at some call site;
- the TypeScript and Swift matchers cannot both pass the shared fixture; or
- a focused gate fails twice after a reasonable correction.

## Maintenance notes

- Reviewers should look hardest at the transitions between tracked and ignored
  content, not at the pattern parser. The dangerous failures are silent
  upload, silent deletion, and a placement that can never reach idle.
- **Untracking.** Because tracked paths win, adding a rule does not stop
  syncing an already uploaded `.env`. The documented recipe is: move the file
  out of the folder, let the deletion sync, then move it back. The rule then
  keeps it local. The bytes remain in accepted history, so a leaked secret
  must be rotated. A one-step `arbor untrack` command is a candidate for the
  catalog, not part of this plan.
- New consumers of workspace enumeration must receive the shared policy or the
  already filtered discovery result. They must not keep their own list of
  ignored names.
- Any future placement-private ignore option must work as a local projection
  mask. It must not change canonical tree membership or leak absolute paths.
