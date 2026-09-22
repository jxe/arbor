# canopyd 011: Traced page creation with an `addEntry` authored operation

Status: IMPLEMENTED 2026-09-22 (deploy with the canopyd 013 cutover). Written the same day
after f83194c8 made snapshot checkpoints cheap again; the remaining cost of a snapshot is the
evidence it does not carry.

As built:
- Clients emit `addEntry` straight from the creation record (`add-<i>`), which already names
  the added branch and proves it; `EntryActions` gained no `creations` list.
- A directory's first `_index.md` body is an `addEntry` frame in both clients.
- Sidebar `createMarkdown`/`createDirectory` actions still publish snapshots; converting them is
  a follow-on (their records have no editor document for `creation.document`).
- A concurrent same-name addition leaves the existing whole-directory choice, exactly as two
  `moveEntry` into one name do; no new per-name placement decision was added.
- `addEntry` takes the fast-forward path when its parent is basis material.


## Context

Creating a page in the Mac app publishes two candidates: a traced `editSource`
on the parent's `_index.md`, then a snapshot (`trace: null`, full new
directory objects) for the new page. The snapshot is deliberate: the authored
contract has seven operation kinds (`editSource`, `moveSource`, `copySource`,
`moveEntry`, `copyEntry`, `removeEntry`, `replaceEntry`) and none can introduce
an entry that does not already exist in the basis. `replaceEntry` binds
`source` to an existing entry. The Swift queue falls back to a snapshot at
`SourceAdmissionQueue.swift:411-414`, and the same fallback covers a
directory's first `_index.md` body (`:124-133`, `:219-221`).

Snapshots are evaluated as `kind:"checkpoint"` (`canopy.ts:1310`). After
f83194c8 that is cheap again, but a checkpoint still rebinds the whole tree
(`checkpointIntent`: `engine.initial(projection)` + per-file `project`),
records a `changes` entry with `operations: null`, and gives later merges no
evidence: a concurrent create of the same name, or a create beside a rename of
the parent, can only surface as a whole-directory snapshot ambiguity. A traced
creation goes through the fast-forward path, is O(touched paths), and merges
by entry identity like `moveEntry`.

## Design

One new operation, symmetric with `removeEntry`:

```
{ key, kind: "addEntry",
  destination: { parent: MaterialRef, name: component },
  value: { file: hash } | { directory: hash } }
```

- `destination.parent` is an entry reference (basis or same-change operation
  material), never ranged; `name` must not exist in that parent after the
  preceding operations of the frame.
- `value` names an object the update carries in `objects` (or already stored).
  A directory value imports its subtree, as `replaceEntry`'s directory branch
  already does via `importNode`.
- No `MaterialRef` value form: adding existing material is `copyEntry`.
- Node identity: `key` (the operation key, like `copy`), pieces for a file
  value get `origin: key` exactly as `replaceEntry` mints them
  (`intent-engine.ts:1135-1143`), so later `editSource` lineage works.
- Conflict semantics: two `addEntry` at the same `(parent, name)` with
  different objects is a placement decision on that name, like two
  `moveEntry` into one destination. Same object twice is idempotent.

Sole user, wire changes are clean breaks: bump nothing on the wire, just add
the kind. Mac, iPhone, web and server ship together.

## Steps

### 1. Protocol
- `packages/protocol/src/updates/authored-contract.ts:12-19` add the union
  member; `operation()` switch at `:64-110` add validation
  (`keys(v, ["key","kind","destination","value"])`, `reference(parent, true)`,
  `component(name)`, `hash(file|directory)`).
- `docs/overstory-spec/10-source-intent.md`: document the operation next to
  `replaceEntry`; add cases to
  `docs/overstory-spec/conformance/protocol-authored-updates.json`.

### 2. Merge engine
- `packages/canopyd-merge/src/intent-model.ts:203-212` allowlist; the
  `SourceOperation` type if it is separately declared.
- `intent-engine.ts` `apply`, entry branch (~`:1054`): today it first binds
  `operation.source`; `addEntry` has no source, so branch before that bind.
  Implement as: bind `destination.parent` (must be an active directory, not
  ranged, no pieces), fail if a child with `name` exists, create the node
  with id `key`, `parent`, `name`, `object`, `kind`, and reuse the
  `replaceEntry` value branch for pieces/`importNode` of a directory value.
  Set `result = { node, view }` like move/copy so later ops can reference it
  as `{kind:"operation", change, operation: key}`.
- Effects: the generic before/after diff at `:1182-1188` records it.
  `enforceDeletions` ignores non-`editSource` kinds. Check `contributions`
  and the placement-decision code that handles `moveEntry` destinations for
  a name collision, and extend it to `addEntry`.
- Fast-forward: `editFastForward` (`:2614-2672`) currently declines unless
  every operation is `editSource`. Either extend it to `addEntry` (cheap:
  one node insert, directory re-projection along one path) or accept the
  full path for creations. Recommend extending, it is the whole point.
- Tests: `tests/unit/canopyd-merge/intent.test.ts` (apply, idempotence,
  name collision decision, directory value, later editSource on the added
  file), `tests/integration/canopyd/source-acceptance.test.ts` (end to end
  through the host), `formats.test.ts` if it enumerates kinds.

### 3. Swift
- `swift/Packages/Overstory/Sources/Overstory/WireAuthoredContract.swift:86-118`
  mirror validation.
- `swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/EntryActions.swift`:
  add `creations: [EntryCreation]` (`parent`, `name`, file bytes or a
  directory snapshot) beside `transfers`/`removals`; `prepare` emits
  `addEntry` ops (`key: "add-<i>"`), inserts the entry into the working
  directory chain, and includes the new objects in the candidate.
- `SourceAdmissionQueue.swift:389-416`: for `creation`, build `EntryActions`
  with creations instead of the removal round-trip proof, so `captured` is
  non-empty and `trace` is a real frame. Drop `SourcePageCreation.removals`
  once nothing reads it.
- `UpdateCoordinator.swift:1106-1124`: pass creation as entry actions.
- Directory first body (`SourceAdmissionQueue.swift:124-133`, `:219-221`):
  emit `addEntry` for the first `_index.md` instead of forcing a snapshot,
  then the `evidence = false` fallback is only for genuinely opaque records.
- Journals keep the wire element verbatim, so no journal schema change.

### 4. Web client
- `packages/client/src/source-admission-queue.ts` and `entry-transfer.ts`
  mirror the Swift queue; add the same creation path so the browser stops
  publishing snapshots for new pages.

### 5. Deploy
Server first (accepts both forms), then Mac + iPhone + web. Old snapshots in
history stay valid; nothing to migrate.

## Verification
- Unit and integration tests above; `bun run test`.
- Create a page in the Mac app: the update log line shows `updates=1`
  (or 2 traced), `trace-frames>=1`, `w-path=1`, `w-reads` in the hundreds,
  and no checkpoint evaluation.
- Concurrent create of the same name from two devices produces one
  placement decision, not a whole-directory snapshot ambiguity.
