# Security 005: Keep ignored filesystem content outside Arbor trees

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Treat ignore matching as one filesystem-membership policy shared
> by discovery, browsing, watching, indexing, snapshots, and materialization;
> do not add independent filters to those consumers. If anything in the
> "STOP conditions" section occurs, stop and report rather than improvising.
> When complete, move this file to
> `plans/_done/security/005-ignore-policy.md`, add verification evidence to the
> historical index, and remove its active entry from `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat ce51a4e..HEAD -- \
>   packages/fs packages/arborsync/src packages/stores/src \
>   tests/unit/discovery.test.ts tests/unit/wire.test.ts \
>   tests/integration/workspace.test.ts tests/integration/self-sync.test.ts \
>   docs/local-system.md spec/02-directory-format.md
> git status --short
> ```
>
> This plan was written while the worktree already contained unrelated edits,
> including edits in `packages/arborsync/src/service.ts`,
> `packages/arborsync/src/workspace.ts`, `packages/stores/src/indexer.ts`, and
> `plans/README.md`. Preserve them. If their live behavior no longer matches
> the current-state description below, stop and reconcile the plan first.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Coordinates with**: Speed 001, because ignored paths must never enter the
  search/backlink index, but neither plan depends on the other
- **Category**: security, correctness, and filesystem architecture
- **Planned at**: commit `ce51a4e`, 2026-09-07

## Outcome

Arbor has one explicit filesystem-membership policy. It retains the existing
mandatory exclusions for Arbor-private and generated directories, adds
portable `.arborignore` files, and reads ordinary `.gitignore` files as a
compatibility source. A matching new local path is opaque to Arbor: it is not
shown as a tree child, assigned durable identity, parsed, indexed, watched as
authored content, included in a Wire snapshot, uploaded, overwritten, or
deleted during materialization.

The last accepted Arbor snapshot is the tracked-membership boundary. A path
already present in that accepted tree remains visible and synchronized even if
a later ignore rule matches it. It leaves the tree only through an explicit
filesystem deletion or structural mutation, after which a surviving ignored
local copy is untracked and opaque. This gives Arbor Git's important safety
property without depending on a Git index and prevents an ignore-file edit
from silently publishing a tree-wide deletion.

The policy has these fixed semantics:

1. `.arborignore` is Arbor's portable, authoritative spelling. `.gitignore`
   uses the same pattern grammar as a compatibility input. Both files remain
   ordinary included tree content and cannot ignore themselves.
2. Root and nested ignore files apply from their containing directory down.
   Match paths with `/` separators, Git-style anchoring, directory rules,
   comments, escaping, and `!` negation. Do not invoke Git or inspect its
   index.
3. Do not consult `.git/info/exclude`, `core.excludesFile`, or a user's global
   Git ignore file. Those machine-private sources must not make the same Arbor
   placement produce an invisible, device-dependent tree. A future
   placement-private ignore option belongs in `placements.yaml`; it is not
   part of this plan.
4. `.git`, `node_modules`, `.arbor`, `Trash`, `.build`, `DerivedData`, Arbor
   transaction temporaries, nested tree mounts, and symlinks retain their
   current stronger treatment. A negated user pattern cannot re-include an
   Arbor-private directory or cross a nested-tree boundary.
5. If an ignore file cannot be decoded or its policy cannot be evaluated
   safely, retain the last valid policy for an open placement, publish a
   structured local diagnostic, and do not construct or submit a candidate
   from a partially filtered walk. Initial activation with no valid policy
   fails closed before upload.
6. Ignored paths never cause pull cleanup. An accepted remote entry is still
   materialized because it is tracked; after an accepted remote deletion, a
   matching local path may remain on disk but is excluded from the verification
   snapshot and cannot be re-uploaded while the rule matches.

## Why this matters

Arbor currently synchronizes every ordinary file except a short hard-coded set
of directory names. A developer can reasonably place a repository expecting
its ignored `.env`, credential files, caches, generated output, or large build
artifacts to remain local, but Arbor will currently snapshot and upload most of
them. That is both a secret-disclosure risk and a severe mismatch with user
expectation.

Applying ignore rules only in search or the sidebar would be worse than having
no feature: invisible files could still upload, or a pull could delete content
Arbor claimed not to own. The filter therefore belongs at the shared
`WorkspaceFS`/Wire projection boundary and must be proven consistently across
every consumer.

## Current state

Relevant files and responsibilities:

- `packages/fs/src/discovery.ts` owns startup discovery and exports the
  hard-coded directory set plus watcher globs. Its current policy is only:

  ```ts
  export const IGNORED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = new Set([
    ".git",
    "node_modules",
    ".arbor",
    "Trash",
    ".build",
    "DerivedData",
  ]);
  ```

- `packages/fs/src/workspace-fs.ts` independently uses that set in `list()`
  and passes static globs to `@parcel/watcher`. Dynamic ignore files are not
  represented, and watcher events cannot currently explain why a path is
  excluded.
- `packages/fs/src/wire-tree.ts` independently checks the same directory set
  during `snapshotDirectory()` and pull cleanup in `materializeTree()`. Files
  such as `.env` are included. Pull cleanup preserves only the hard-coded set
  and explicit nested-placement roots.
- `packages/stores/src/indexer.ts` calls `discoverWorkspace()` and indexes the
  resulting files. It should consume the filtered discovery result rather than
  implementing pattern matching.
- `packages/arborsync/src/service.ts:snapshotWorkspace()` and
  `packages/arborsync/src/tree-sync.ts` repeatedly compare physical snapshots
  with accepted Wire roots, freeze pending candidates, and materialize accepted
  snapshots. Ignore policy and tracked membership must be part of these same
  comparisons or clean placements will appear permanently dirty.
- `packages/arborsync/src/sync-state.ts` currently retains an accepted root and
  object hashes, but no accepted path-membership view. Extend private sync
  state only as much as needed to recover the tracked-membership invariant
  offline; do not put ignore metadata in Wire objects or Canopy APIs.
- `packages/stores/src/placements.ts` deliberately accepts only scalar
  `path: TreeID` entries. Do not widen that schema in this plan.
- `packages/fs/README.md` says all hidden directories other than the fixed set
  are ordinary content. `docs/local-system.md` owns replaceable local
  implementation choices. `spec/02-directory-format.md` owns the portable
  directory projection and is where `.arborignore` membership belongs;
  `.gitignore` compatibility remains reference-implementation documentation.

Conventions to preserve:

- `WorkspaceFS` is the sole server-side authority for workspace-content I/O;
  keep consumers thin and pass one immutable policy/snapshot view through an
  operation rather than rereading ignore files at different times.
- Discovery is symlink-safe, nested mounted roots are explicit exclusions, and
  Wire names are ordered with `compareWireNames`, not locale ordering.
- Durable private synchronization state lives beneath `.state`; it does not
  enter authored trees or portable account configuration.
- Tests use `bun:test`, temporary workspace and state directories, and cleanup
  in `afterEach` or `finally`. Follow `tests/unit/discovery.test.ts` for
  discovery fixtures and `tests/unit/wire.test.ts` for snapshot/materialization
  round trips.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused filesystem tests | `bun test tests/unit/discovery.test.ts tests/unit/wire.test.ts tests/integration/workspace.test.ts` | all pass |
| Synchronization tests | `bun test tests/integration/self-sync.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Product suite | `bun run test` | all pass |
| Protocol suite | `bun run test:protocol` | all pass |
| Diff hygiene | `git diff --check` | exit 0, no output |

Do not run `git add`, commit, push, a long-lived daemon, or a formatter over
unrelated files. If a dependency is added, use Bun's lockfile tooling narrowly
and verify that `bun.lock` contains only the intended package change.

## Scope

**In scope**:

- a focused ignore-policy module under `packages/fs/src/` and its export;
- `packages/fs/src/discovery.ts`;
- `packages/fs/src/workspace-fs.ts`;
- `packages/fs/src/wire-tree.ts`;
- the narrow Arbor Sync state/coordinator changes required to supply accepted
  tracked membership consistently;
- `package.json` and `bun.lock` only if a maintained Git-ignore matcher is used;
- `tests/unit/discovery.test.ts` and `tests/unit/wire.test.ts`;
- focused cases in `tests/integration/workspace.test.ts` and
  `tests/integration/self-sync.test.ts`;
- `packages/fs/README.md`, `docs/local-system.md`, and
  `spec/02-directory-format.md`; and
- `plans/README.md` and this plan's eventual move to `_done/`.

**Out of scope**:

- Git index integration, shelling out to Git, `.git/info/exclude`, global Git
  configuration, or reproducing Git's staging UI;
- widening `placements.yaml` or adding device-local pattern configuration;
- a sidebar toggle, ignored-files browser, or general `arbor ignore` command;
- changing Wire object shapes, TreeID identity, Canopy merge behavior, ACLs,
  or nested-tree boundary semantics;
- following symlinks or permitting ignore negation to expose Arbor-private
  state; and
- opportunistic search-index, watcher, or snapshot refactors beyond what the
  shared policy requires.

## Git workflow

- Branch: `codex/security-005-ignore-policy`.
- Make focused commits with short imperative messages matching current history,
  for example `Keep ignored files outside Arbor trees`.
- Do not push or open a pull request unless the operator explicitly asks.

## Steps

### Step 1: Freeze ignore and tracked-membership behavior in tests

Add table-driven policy tests before integrating it. Cover root and nested
`.arborignore` and `.gitignore`, comments, escaped leading `#`/`!`, anchored
patterns, directory patterns, `**`, negation, Unicode names, and `/` path
normalization. Prove that mandatory internal exclusions cannot be negated and
that both ignore control files remain included.

Add tracked-membership cases with three states: no accepted base, a path in the
accepted base, and the same path absent from the new accepted base. The same
matching path must respectively be excluded, included, and excluded. Keep this
pure and independent of Git installation or process environment.

**Verify**: run the focused filesystem-test command. The new pure-policy tests
pass; existing integration failures caused by incomplete wiring are acceptable
only if their names correspond exactly to later steps.

### Step 2: Introduce one immutable workspace ignore policy

Create a focused module under `packages/fs/src/` that loads the complete
root-relative policy for one coherent filesystem operation. Prefer a small,
maintained matcher with documented Git-compatible semantics over a new partial
glob engine; pin it through the normal Bun lockfile if needed. The policy must
offer at least:

- an inclusion decision for a root-relative file or directory path;
- the matched source file and pattern for diagnostics/tests;
- mandatory/private versus user-pattern classification;
- a stable policy revision derived from the exact control-file bytes and
  placement root; and
- a way to combine policy matching with the accepted tracked path set.

Do not cache based only on mtimes. Load exact bytes, reject undecodable control
files, and keep path containment and symlink rules in the existing filesystem
authority.

**Verify**: run the pure-policy tests and `bun run typecheck`; both pass.

### Step 3: Put discovery, listing, watching, and indexing behind the policy

Make `discoverWorkspace()` receive or load one policy view and use it for both
directory descent and file admission. Make `WorkspaceFS.list()` and path
resolution apply the same view; an ignored untracked path must not become a
node merely because it was addressed directly. Keep arbitrary filesystem
browsing with `discovery: "none"` path-addressable and path-only: ignore policy
limits managed Arbor-tree membership, not the user's ability to open an
ordinary absolute local file outside a placement.

For watching, static mandatory globs may remain an optimization, but dynamic
patterns cannot rely solely on `@parcel/watcher` ignore globs because ignore
files themselves must be observed. Filter queued events through the current
coherent policy; an ignore-file event reloads the policy, rebuilds discovery,
identity maps, search/backlinks, and generated types once, then emits the
appropriate tree-level invalidation. Preserve the last valid policy and emit a
diagnostic if reload fails.

Do not add matching to `packages/stores/src/indexer.ts`; prove that its existing
discovery input contains no ignored untracked files.

**Verify**: `bun test tests/unit/discovery.test.ts tests/integration/workspace.test.ts` passes, including external creation/removal and live ignore-file edits.

### Step 4: Make snapshot and materialization use the identical policy

Change `snapshotDirectory()` to consume the same immutable policy and tracked
membership view as discovery. All Arbor Sync snapshot call sites must pass the
coherent view rather than allowing the snapshotter to rediscover different
ignore bytes mid-operation.

Change `materializeTree()` to determine cleanup protection before deleting any
entry. It must never delete an ignored untracked local path. It must still
materialize and update an accepted tracked entry even when a current pattern
matches it. When the authority deletes such an entry, preserve any matching
local bytes as ignored/untracked and verify the physical projection against the
remote root using the new accepted membership, so the placement becomes idle
instead of repeatedly re-uploading the preserved copy.

Keep nested mounts and mandatory exclusions stronger than user rules. Do not
change the Wire snapshot shape.

**Verify**: `bun test tests/unit/wire.test.ts` passes with new round trips for
new ignored files, tracked matching files, remote deletion, pull preservation,
and matching-root verification.

### Step 5: Persist and advance accepted tracked membership safely

Extend Arbor Sync's private per-tree state so restart and offline edits know
which physical paths belong to the last accepted root. Derive membership by
walking validated Wire directory objects, excluding boundary entries; never
trust an unvalidated path manifest from a server response. Update membership at
the same durable boundary as accepted root/object retention, including accepted
local candidates, reconciled server results, watch transitions, and conflict
resolution.

Do not let the path view get ahead of the accepted root. If an optimized
hash-only transition lacks enough objects to derive its complete membership,
retain the previous view only when the transition is proven content-only;
otherwise fetch/reconstruct the accepted graph or fall back to the existing
full reconciliation path. Do not guess from the current filesystem after a
remote deletion.

On first activation of a tree with no accepted base, apply ignores before its
first snapshot. For an existing placement upgrading from state without tracked
membership, reconstruct it from the accepted remote snapshot before permitting
an ignore-matched omission; never reinterpret the current disk as proof that a
path was untracked.

**Verify**: `bun test tests/integration/self-sync.test.ts` passes with restart,
offline edit, watch-transition, remote deletion, and legacy-state upgrade
cases. Each ends with the expected accepted root and `sync: "idle"`.

### Step 6: Document the contract and run maintained gates

Update `spec/02-directory-format.md` with `.arborignore`, its nested pattern
scope, control-file inclusion, tracked-membership rule, and the distinction
between tree content and opaque placement files. Keep `.gitignore` compatibility,
the fixed implementation exclusions, policy-error recovery, and unsupported
global/local Git sources in `packages/fs/README.md` and
`docs/local-system.md` rather than presenting them as universal Wire protocol.

Update the plan index, run the product and protocol suites, run a repository-wide
relative Markdown-link check, and run `git diff --check`.

**Verify**: every command in "Commands you will need" passes; the link checker
reports no broken repository-relative links; `git status --short` contains only
the intended implementation, test, documentation, lockfile, and plan changes
plus the operator's preserved pre-existing changes.

## Test plan

Add tests proving all of the following:

1. A fresh ignored `.env`, credential fixture, ignored directory, and ignored
   Markdown page never appear in discovery, child listing, PageID maps, search,
   backlinks, generated types, snapshots, or pending Wire objects.
2. Root/nested `.arborignore` and `.gitignore` patterns, negation, anchoring,
   escaping, directory rules, `**`, Unicode names, and normalized separators
   match deterministically without a Git executable.
3. `.arborignore` and `.gitignore` remain included and their live edits trigger
   exactly one coherent policy/discovery refresh.
4. Mandatory exclusions, transaction files, symlinks, and nested tree mounts
   remain excluded even under negated patterns.
5. A matching path already in the accepted root remains listed, indexed,
   snapshotted, uploaded when edited, and updated by a pull.
6. Deleting that tracked path removes it from the accepted tree. A matching
   local copy subsequently created or preserved by pull cleanup remains on disk
   but does not make the placement dirty or re-enter synchronization.
7. Materialization never deletes ignored untracked files and still reaches the
   authority's exact root according to accepted tracked membership.
8. Restart/offline behavior restores the accepted membership atomically with
   the accepted root. Legacy private state reconstructs membership before
   omitting anything.
9. An unreadable or undecodable ignore file retains the last valid policy,
   exposes a safe diagnostic without file contents, and blocks initial upload
   when there is no valid prior policy.
10. Global Git ignores and `.git/info/exclude` have no effect.

## Done criteria

- [ ] One shared policy controls managed-tree discovery, direct resolution,
      children, watching, indexing inputs, snapshots, and materialization.
- [ ] `.arborignore` is specified portably and `.gitignore` works as documented
      compatibility without consulting Git or machine-global configuration.
- [ ] Fresh matching paths and their contents never enter Wire objects or
      diagnostics.
- [ ] Accepted matching paths remain tracked until explicit removal; changing
      a pattern alone cannot delete accepted content.
- [ ] Ignored untracked local bytes survive pulls and cannot keep a placement
      dirty or be re-uploaded.
- [ ] Mandatory exclusions, symlink safety, and nested-tree boundaries retain
      precedence.
- [ ] Policy/membership state is crash-safe and upgrades existing placements
      without treating missing private metadata as permission to omit content.
- [ ] Focused tests, `bun run typecheck`, `bun run test`,
      `bun run test:protocol`, the relative-link check, and
      `git diff --check` all pass.
- [ ] No global Git configuration, placement schema, Wire shape, Canopy API,
      or unrelated working-tree file changed.

## STOP conditions

Stop and report back rather than improvising if:

- a coherent implementation requires making ignore rules or local absolute
  paths part of Wire objects, synchronized account configuration, or Canopy;
- an accepted tracked path cannot be distinguished from an ignored untracked
  path after restart without storing or reconstructing a validated membership
  view tied atomically to the accepted root;
- materialization would need to delete ignored local bytes to verify the remote
  root, or would need to include them and thereby re-upload them;
- the matcher cannot implement the documented nested, negation, escaping, and
  Unicode behavior deterministically on macOS and Linux;
- ignore-file reload races can produce a snapshot from one policy and an index
  or candidate from another;
- the necessary change widens `placements.yaml`, changes Wire shapes, follows
  symlinks, or weakens nested-tree boundaries; or
- any focused gate fails twice after a reasonable correction.

## Maintenance notes

- Reviewers should scrutinize the transitions between accepted tracked content
  and ignored opaque content more than the pattern parser itself. The dangerous
  failures are silent upload, silent deletion, and a placement that can never
  return to its accepted root.
- Any future placement-private ignore option must compose as a local projection
  mask without changing canonical tree membership or leaking absolute paths.
- If Arbor later supports multiple writable local placements of one TreeID,
  accepted membership remains tree-wide while placement-private masks remain
  local; do not infer canonical deletion from one masked placement.
- New consumers of workspace enumeration must receive the shared policy view or
  the already filtered discovery result. They must not invent another list of
  ignored names.
