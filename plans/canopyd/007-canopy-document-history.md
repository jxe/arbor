# canopyd 007: Surface accepted document history from canopyd

Historical identifier: **Smaller project 007**. The filename number is preserved; this plan now belongs to canopy.

> **Executor instructions:** Read this plan completely before editing. Preserve
> unrelated working-tree changes. Run every verification gate before moving on.
> Stop rather than weakening durability, authorization, or exact-source fidelity
> when a STOP condition applies.
>
> **Drift check (run first):** This plan was refreshed against commit
> `670a240`, after local replica history removal landed in `b610d40` and the
> retained-root object-read decision was recorded in Native 006. Before
> implementation run:
>
> ```sh
> git diff --stat 670a240..HEAD -- \
>   packages/canopyd packages/protocol packages/arborsync packages/fs \
>   canopy-swift/Packages/Overstory canopy-swift/Packages/CanopyAppKit \
>   canopy-swift/Packages/ArborReplica canopy-swift/Packages/ArborSyncClient \
>   canopy-swift/Packages/CanopyEditor canopy-swift/CanopyApp canopy-swift/CanopyAppTests \
>   spec docs conformance tests migrations plans/canopy plans/postgres plans/cleanups plans/cli plans/native plans/web
> git status --short -- \
>   packages/canopyd packages/protocol packages/arborsync packages/fs \
>   canopy-swift/Packages/Overstory canopy-swift/Packages/CanopyAppKit \
>   canopy-swift/Packages/ArborReplica canopy-swift/Packages/ArborSyncClient \
>   canopy-swift/Packages/CanopyEditor canopy-swift/CanopyApp canopy-swift/CanopyAppTests \
>   spec docs conformance tests migrations plans/canopy plans/postgres plans/cleanups plans/cli plans/native plans/web
> ```
>
> Reconcile every pre-existing edit before touching an overlapping file. The
> executor must not overwrite or silently absorb user work. A semantic mismatch
> in accepted-update storage, session history, or recovery
> behavior is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** XL
- **Risk:** HIGH — this adds an authenticated canopyd protocol and changes the
  authority and meaning of a visible restore action
- **State:** PLANNED
- **Depends on:** no implementation milestone; execute before
  [canopyd 006](006-line-provenance.md), and coordinate retained-root
  policy with [canopyd 001](001-pack-object-storage.md)
- **Category:** performance, product, protocol, migration
- **Planned at:** `670a240`, 2026-09-07

## Target result

**History → Recover** is an authenticated canopyd feature. It lists accepted
versions of the current Markdown document and restores a selected exact source
as an ordinary new edit. Replica history production was removed and legacy
archives became automatically reclaimable in `b610d40`; that completed cleanup
is not part of this plan.
Arbor Sync keeps its filesystem write journal and `/v1/recovery` repair
operations because those recover lost/purged blocks and Trash entries after
filesystem events; they are not presented as accepted document history.

## Why this matters

Replica snapshot history grew linearly with every edit and mixed local
generations with shared accepted history. Commit `b610d40` removed it. This
plan supplies the correct product replacement: canopyd already owns accepted
roots and therefore must own document history and recovery.

## Current state

- `b610d40` removed `ReplicaHistoryRecord`, per-generation state writes, and
  replica-backed `WorkspaceHistoryEntry` synthesis. Opening a replica now
  tombstones and asynchronously reclaims only recognized legacy history
  directories after journal recovery; new edits create no history archive.
- Crash completion remains independent: `recoverPendingIntents()` replays
  `ReplicaMutationIntent` files from `journals/pages`; current state is
  `materialized/tree.json`, and accepted/pending heads remain in
  `control/heads.json`.
- Replica-backed and Overstory-Sync-backed `history()` / `recover(revision:)`
  currently fail with `canopyd history is not available yet`. They no longer
  map Arbor Sync `/v1/recovery` hashes into product History or submit
  `restoreRecovery` from that surface.
- `packages/fs/src/journal.ts` and `packages/arborsync/src/workspace.ts` retain
  per-block lost/purged content and Trash recovery. This journal is required for
  crash and external-filesystem recovery and stays in place.
- canopyd already stores the linear accepted chain in
  `packages/canopyd/src/updates/store.ts` and retains accepted roots. In
  `packages/canopyd/src/canopy.ts`, `acceptedUpdates(treeID)` is explicitly
  internal, and `snapshotForRoot` accepts a known retained root. No Overstory route
  currently enumerates history.
- `spec/05-access-control.md` defines historical snapshots as known-root and
  non-enumerable. Native 006 records the separate decision that a caller
  with current read access may fetch a known object reachable from any retained
  accepted root of that same tree. That does not authorize history enumeration:
  this plan adds only document-scoped listing under a write-capable credential.
- `ArborHistoryView` already uses **History**, explains that canopyd history is
  not available yet, and says **Restore as New Change**. This plan replaces the
  placeholder with loading, empty, offline, error, and accepted-version states.

## Contract to freeze first

Add a document-scoped canopyd contract, not a generic accepted-update listing:

```ts
type DocumentHistoryEntry = {
  update: string;
  root: ObjectHash;
  path: LogicalPath;
  stableKey: string | null;
  contentHash: ObjectHash;
  acceptedAt: number;
};

type DocumentHistoryPage = {
  entries: DocumentHistoryEntry[]; // newest first
  nextCursor: string | null;
};

type DocumentHistoryVersion = DocumentHistoryEntry & {
  source: string; // exact decoded UTF-8 Markdown source
};
```

Use routes consistent with existing tree routes:

```text
GET /.arbor/trees/{TreeID}/history?path={logical-path}&stableKey={key}&cursor={cursor}
GET /.arbor/trees/{TreeID}/history/{accepted-update-id}?path={logical-path}&stableKey={key}
```

Freeze these semantics in `spec/01-tree-operations.md` and
`spec/05-access-control.md` before implementation:

1. History is Markdown-document scoped. It is ordered newest first and emits a
   row only when the exact file-object hash differs from the preceding version.
   A move without a source change does not create a content version.
2. A unique stable Markdown `id`/PageID is the continuity key across moves and
   renames. Path fallback is permitted only for an explicitly identified legacy
   document with no stable ID and stops at the first move, disappearance, or
   ambiguity. Never infer identity from title or similar source.
3. Listing and fetching through the document-history routes require a currently valid,
   authenticated **write-capable device credential** for the tree. Public,
   access-link-only, and read-only callers cannot enumerate deleted source.
   Unknown, wrong-tree, unauthorized, and unretained entries are
   indistinguishable `404`s. Restore also passes through ordinary current write
   authorization and canopyd admission.
4. Pagination has a stable opaque cursor with a fixed maximum page size. The
   server bounds document bytes, history rows scanned, and total work and
   returns a typed error rather than a partial page that looks complete.
5. `source` preserves the exact UTF-8 string, including line endings and final
   newline. Non-Markdown, invalid UTF-8, missing, duplicate-ID, and corrupt
   historical bodies fail explicitly.
6. Restore does not rewind canopyd, mutate an old root, or bypass conflict
   handling. The client fetches one historical version and submits that source
   through the existing document admission path as a new current change.

The write-only history-enumeration choice is security-sensitive. Reliability
006's broader known-hash object read does not provide a history listing and does
not weaken this rule. If product wants read-only, public, or access-link history
enumeration, STOP for an explicit threat-model and retention decision before
changing it.

## Storage and indexing design

Add one private, rebuildable `document_versions` table owned by canopyd. Use the
next available migration number at execution time; schema version is currently
`6`, and both may drift. The logical columns are:

```text
tree_id, stable_key, historical_path, update_id, root,
content_hash, accepted_at
```

Use a primary/unique key that prevents duplicate rows for one document and
accepted update, plus an index supporting newest-first `(tree_id, stable_key,
accepted_at, update_id)` pagination. Reference the accepted update so retention
cannot leave orphan metadata.

For each accepted root, derive Markdown identities and file-object hashes from
the validated Overstory graph before acknowledgement, then insert only changed
document versions inside the same SQLite transaction as the accepted update
and observation. Reuse `AcceptedUpdateStore.commit(..., withinTransaction:)` or
an equally small existing transaction seam; do not create a second commit log.
Object bytes must already be hash-verified and durable before their metadata is
committed.

The disposable migration backfills by walking each retained accepted chain in
order and reading the retained roots. It must preserve all accepted IDs, order,
roots, transition JSON, observations, accounts, ACLs, and object bytes. Report
counts only. Rehearse on copies; never silently migrate a live canopyd at
startup. If retained roots are incomplete, record an explicit earliest-history
boundary rather than inventing continuity, or STOP if the contract has no such
representation.

Do not copy Markdown source into SQLite. The index stores the existing file
object hash; the detail route resolves and verifies that immutable object when
requested. Coordinate the retained-root/object requirement with canopyd storage
001. canopyd 006 must reuse this accepted document-version index for
line provenance rather than add a competing historical scan or schema.

## Native and Arbor Sync ownership

Keep `WorkspaceDocumentSession.history()` / `recover(revision:)` as the UI seam
and replace the current unavailable result with these production semantics:

- the replica implementation delegates to an injected canopyd document-history
  service and stores no history itself;
- the Arbor Sync provider obtains the same canopyd result either through the
  existing authenticated placement channel or a thin local REST proxy;
- any Arbor Sync proxy owns no history database, cache, retention policy, or
  restore semantics—it only uses the selected placement's canopyd origin and
  credential; and
- `recover(revision:)` fetches exact historical source, verifies the returned
  tree/stable key/content hash, then calls the normal session admission/write
  flow. It does not call `restoreRecovery`.

If direct native canopyd transport can reuse credentials without moving secret
ownership or duplicating synchronization state, prefer it. Otherwise the thin
Arbor Sync proxy is acceptable. Do not introduce a general provider framework
until a second concrete history authority exists.

Retain `restoreRecovery`, `/v1/recovery`, the filesystem `WriteJournal`, and
Trash recovery for diagnostics or a separately labelled lost-content repair
surface. Their mapping into `WorkspaceHistoryEntry` is already removed; keep it
removed and document the distinction in `docs/arborsync-api.md` and the
reference implementation docs.

Update `ArborHistoryView` and its loading/error states:

- title: **History** (the action sheet may remain **Recover**);
- empty: **No accepted history yet**;
- offline/unpaired: explain that canopyd history requires a connection and do
  not fall back to replica or filesystem history;
- rows use acceptance timestamps and stable, literal labels such as
  “Accepted change”; and
- confirmation remains **Restore as New Change** and says the restored source
  will be submitted as a new edit, preserving later accepted history.

## Scope and git workflow

Expected implementation scope:

- `spec/01-tree-operations.md`, `spec/05-access-control.md`, Overstory/reference API
  docs, and language-neutral conformance fixtures;
- `packages/canopyd/src/`, `packages/protocol/src/`, focused tests, and the next
  disposable `migrations/NNN-document-history/`;
- `packages/arborsync/src/` and `packages/fs/src/` only to preserve and relabel
  filesystem recovery and, if required, add the thin authenticated proxy;
- `canopy-swift/Packages/Overstory`, `CanopyAppKit`, `ArborSyncClient`, and `CanopyEditor`
  session/binding code and tests; and
- `canopy-swift/CanopyApp`, `canopy-swift/CanopyAppTests`, `docs/arborsync-api.md`,
  `docs/reference-implementation.md`, and the two coordinated plan files.

Out of scope:

- changing Overstory object hashes, root identity, accepted ordering, merge policy,
  or request replay;
- exposing a generic tree history, rejected candidates, pending local edits,
  credentials, request digests, or document-history enumeration to current
  read-only callers; known-hash retained-object reads are owned by Reliability
  006;
- deleting Arbor Sync filesystem journals, Trash recovery, or crash recovery;
- snapshot deltas, replica compaction, canopyd pack-file implementation, diffs,
  branching, history editing, or cross-canopyd federation; and
- recreating replica history or changing replica cleanup behavior.

Use branch `codex/canopy-document-history` unless the operator supplies another
name. Make focused commits for contract/schema, canopyd API, native
integration/UI, and documentation. Match the repository's
imperative commit style. Do not push, deploy, migrate live canopyd data,
stop/restart Arbor Sync, or launch the app unless Joe separately authorizes it.

## Implementation order and verification

### Phase 1 — freeze the protocol and authorization boundary

1. Update the portable specs and reference documentation with the exact
   document-scoped routes, models, pagination, errors, authorization, source
   fidelity, and restore-as-new-change semantics.
2. Add matching strict TypeScript and Swift Overstory models/decoders plus
   language-neutral fixtures. Unknown required fields, malformed hashes/paths,
   invalid cursors, and mismatched tree/document identity must fail closed.

**Verify:**

```sh
bun run typecheck
bun run test:protocol
swift test --package-path canopy-swift/Packages/Overstory
```

Expected: all commands exit zero and TS/Swift accept and reject the same cases.

### Phase 2 — index and serve accepted document versions in canopyd

1. Implement the private `document_versions` store and atomic accepted-update
   indexing. Add the explicit disposable migration and copy-only rehearsal.
2. Implement authorization, stable-ID/path resolution, bounded pagination, and
   exact-source detail fetch separately from HTTP, then add the two host routes.
3. Cover initial history, repeated identical source, edits, moves/renames,
   delete/recreate, duplicate/missing IDs, merged accepted updates, pagination,
   wrong-tree IDs, revoked credentials, read-only/public/access-link denial,
   bounds, retained-history boundaries, and migration equivalence.

**Verify:**

```sh
bun test tests/unit/canopyd/update-store.test.ts tests/integration/canopyd/update-host.test.ts
bun run typecheck
```

Expected: focused tests and typecheck exit zero; the migration equivalence test
shows unchanged accepted rows, observations, roots, and object hashes.

### Phase 3 — switch native History to canopyd and uncouple Arbor Sync repair

1. Overstory both replica-backed and Overstory-Sync-backed sessions to the same canopyd
   document-history contract without storing results durably.
2. Change restore to fetch and verify exact source, then use normal admission.
   Cover stale/current races and prove a conflict preserves live editor text.
3. Keep filesystem recovery endpoints/tests but remove their use from History.
   That production separation landed in `b610d40`; preserve it and rename any
   remaining repair-only documentation or visible labels which could still be
   confused with accepted history.
4. Update History UI, loading, empty, offline, error, and confirmation behavior.

**Verify:**

```sh
swift test --package-path canopy-swift/Packages/ArborSyncClient
tools/test-arbor-quagmire-local.sh
bun test tests/integration/server.test.ts
rg -n 'client\.recovery|restoreRecovery|No local recovery history' \
  canopy-swift/Packages/ArborSyncClient canopy-swift/CanopyApp
```

Expected: tests exit zero; the final `rg` has no production History mapping
matches (repair-only protocol code outside those paths may remain).

### Phase 4 — run maintained gates and document evidence

Run the repository gates from `DEVELOPMENT.md`, including the native platforms
affected by the session/API changes:

```sh
bun run typecheck
bun run test:protocol
bun test
swift test --package-path canopy-swift/Packages/Overstory
swift test --package-path canopy-swift/Packages/ArborSyncClient
tools/test-arbor-quagmire-local.sh
xcodebuild -workspace canopy-swift/Canopy.local.xcworkspace -scheme Canopy -sdk macosx \
  -derivedDataPath /tmp/arbor-canopy-history-macos CODE_SIGNING_ALLOWED=NO build
xcodebuild -workspace canopy-swift/Canopy.local.xcworkspace -scheme Canopy -sdk iphonesimulator \
  -derivedDataPath /tmp/arbor-canopy-history-ios CODE_SIGNING_ALLOWED=NO build
git diff --check
```

Expected: every command exits zero. Also run the repository-wide relative-link
audit used by current documentation work and record its exact command/output in
`status.md` before deleting the plan.

Manual acceptance on iPhone and macOS:

1. Open History while online, restore an older accepted source as a new change,
   and confirm the prior latest version remains listed after acceptance.
2. Repeat offline and confirm History reports canopyd unavailability rather than
   showing replica or Arbor Sync recovery entries.

## Done criteria

- [ ] canopyd provides bounded, document-scoped accepted history and exact source
  under current write-capable device authorization, with strict 404 privacy.
- [ ] Restore submits historical exact source through ordinary current
  admission and retains every later accepted version.
- [ ] Arbor Sync filesystem/Trash recovery remains functional but is not used
  or labelled as product History.
- [ ] TypeScript/Swift Overstory models, fixtures, specs, reference docs, and focused
  tests agree.
- [ ] Native UI has correct online, empty, offline, error, and restore states on
  macOS and iOS.
- [ ] All focused and maintained gates, platform builds, relative-link audit,
  and `git diff --check` pass.
- [ ] `plans/README.md` and canopyd 006 reflect the final dependency and
  shared history-index ownership; completed evidence is moved to `_done`.

## STOP conditions

Stop and report rather than improvising if:

- current uncommitted changes overlap an in-scope file and their ownership or
  intended result cannot be reconciled safely;
- accepted roots or required objects are not retained enough to backfill and no
  explicit earliest-history boundary exists;
- the next canopyd schema/migration number differs and a supported exact-source
  migration cannot be identified;
- document-history enumeration would be available to public, access-link,
  read-only, or unauthenticated callers without a new explicit product/security
  decision; known-hash retained-object access from Native 006 is not
  enumeration;
- direct native history access would require duplicating credential ownership,
  or the Arbor Sync proxy would begin storing a second history archive;
- restore cannot use ordinary admission without losing exact Markdown,
  bypassing canopyd conflict authority, or overwriting live text before durable
  acceptance; or
- a focused gate fails twice or the work expands into pack storage, generic
  history, diffs, revision DAGs, or federation.

## Deliberate absences and maintenance notes

- Replica/local-only edit history removal and legacy archive reclaim were
  completed in `b610d40`. Pending unsynchronized work remains durable but is
  not retrospectively presented as accepted.
- No removal of filesystem crash/lost-block/Trash recovery.
- No generic accepted-update browser, historical tree checkout, diff view,
  branching, or history rewriting.
- No claim that DeviceFS block-accounting output is physical bytes; use logical
  byte totals and, where available, allocated-byte resource values.
- Review future canopyd packing/pruning, account authorization, cross-canopyd
  moves, stable-ID cleanup, and line provenance against this plan's retention,
  authorization, exact-source, and restore-as-new-change invariants.
