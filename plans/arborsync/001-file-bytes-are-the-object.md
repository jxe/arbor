# Arbor Sync 001: File bytes are the object

> **Executor instructions**: Follow this plan phase by phase. Run every
> verification command and confirm the expected result before moving to the
> next phase. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. Preserve unrelated working-tree changes. Phase 1
> (the live migration) never starts without Joe's explicit go-ahead in chat.
> When the implementation is complete, move this file to
> `plans/_done/arborsync/` with its identifier unchanged, record the
> verification evidence there, and update both plan indexes.
>
> **Drift check (run first)**:
> `git diff --stat 231d16a..HEAD -- packages/wire/src packages/fs/src/wire-tree.ts packages/stores/src/object-index.ts packages/canopy/src packages/canopy-client/src packages/arborsync/src packages/arborsync-client/src packages/wire-projection/src packages/core/src/protocol.ts native/Packages/ArborWire native/Packages/ArborObjectStore native/Packages/ArborWorkingTree native/Packages/ArborSyncClient native/Packages/CanopyClient native/ArborApp spec/01-tree-operations.md spec/09-client-synchronization.md conformance tests/fixtures/arborsync docs/arborsync-api.md docs/local-system.md docs/reference-implementation.md`
> If the object encoding, the bundle rules, the bootstrap shape, or the index
> schema changed, refresh the current-state excerpts and the file:line
> references below before writing code. A changed line is not automatically a
> stop, but a changed invariant is.

## Status

- **Priority**: P1 (the first piece of "Rearchitect Arbor Sync" in
  `plans/README.md`)
- **Effort**: XL
- **Risk**: HIGH (every stored object, root, and accepted update changes hash;
  live migration of Canopy, the Mac, and the iPhone)
- **Depends on**: none
- **Followed by**: [Arbor Sync 002](002-object-directory.md), which needs this
  plan's code and migration landed and soaked
- **Coordinate with**: [Reliability 007](../reliability/007-reify-composable-canopy-conflicts.md).
  Both rewrite `packages/canopy/src/updates/*` and the Swift update
  coordinator. Land this plan first, or rebase 007 onto the new object model.
  Never interleave the two.
- **Category**: wire format, Canopy storage, migration, client behavior
- **Planned at**: commit `231d16a`, 2026-09-11

## Why this matters

Arbor Sync's job is to make part of the disk content-addressable and keep it
equal to Canopy's accepted root. The intended end state
([Arbor Sync 002](002-object-directory.md)) is a directory
`objects/<TreeID>/<hex>` in which a file object is a hardlink to the real
inode. That only works if a file on disk *is* its object.

Today it is not. A wire file object is canonical CBOR `{type: "file", bytes}`
and its hash is the SHA-256 of that encoding
(`packages/wire/src/objects.ts:5-8, 61-67`). A hardlink would hand a reader
the pre-image of a wrapper, and every reader would have to know the
convention, wrap, and re-hash. That is a permanent trap.

Directory entries carry no kind: a `WireDirectoryEntry` is `{name, hash}` or
`{name, tree}` (`objects.ts:10-14`). Every reader learns whether a child is a
file or a directory by decoding the child, and three mechanisms exist only to
compensate for that gap:

- `WireObjectSource.kind` (`objects.ts:48-53`), produced by the folder walker
  and consumed only by `sparseSpine` (`packages/arborsync/src/service.ts:206-241`);
- the bootstrap `files` size/mtime map, which the Swift client cross-checks so
  it can tell a deliberately omitted file from a missing directory
  (`ArborSyncRESTClient.swift:180-200`, `SnapshotBridge.swift:125-141`);
- Swift `WireObjectCodec.kind(ofPrefix:)`, which sniffs the first bytes of
  CBOR to classify an object without decoding it (`WireObjects.swift:119-138`),
  used by `ObjectOverlay.swift:53`, `DirectoryObjectStore.swift:64-75`, and
  `WorkingTree.swift:262-265`.

The change is two coupled decisions: a file object's bytes are the file's
bytes and its hash is the SHA-256 of those bytes; directory entries name the
kind of what they point at. After this, `shasum -a 256 photo.png` agrees with
Canopy, a hardlink is exactly the object, no reader ever decodes an object to
learn what it is, and Canopy's reachability walks skip file bytes entirely.

Joe is the sole user, so this is a clean break: no decoder accepts both
shapes, and the live data moves in one gated migration.

## Design decisions

### D1. The wire model

TypeScript, `packages/wire/src/objects.ts`:

```ts
export type WireDirectoryEntry =
  | { name: string; file: Hash }        // an ordinary file: bytes are the object
  | { name: string; directory: Hash }   // a directory object
  | { name: string; tree: TreeID };     // a nested tree boundary
// Exactly two keys, as today; the target key names the kind.

export interface WireDirectory {
  type: "directory";
  entries: WireDirectoryEntry[];
  childrenSource?: CollectionFileDescriptor;   // source and schemaSource must be `file` entries
}

export function hashObject(bytes: Uint8Array): Hash;              // unchanged: sha256 of the exact bytes
export function encodeWireDirectory(directory: WireDirectory): Uint8Array;
export function decodeWireDirectory(bytes: Uint8Array): WireDirectory;   // strict, canonical round-trip
export type WireEntryKind = "file" | "directory";
export function wireEntryObject(entry: WireDirectoryEntry): { kind: WireEntryKind; hash: Hash } | undefined;
```

- Directory objects stay canonical CBOR and keep `type: "directory"`, so a
  directory read from disk is self-describing in the one direction that
  matters: a reader that expected a directory can confirm it.
- A snapshot root is always a directory.
- Deleted: `WireFile`, `WireObject`, `encodeWireObject`, `decodeWireObject`,
  `wireEntryObjectHashes`, `WireObjectSource.kind`. There is no "decode a file
  object"; the bytes are the object.
- Entry validation keeps every rule it has today (NFC names, no `.`/`..`, no
  separators, unique, strictly ascending by UTF-8 bytes, hash grammar) and
  adds: exactly one of `file`, `directory`, `tree`.

Swift, `native/Packages/ArborWire/Sources/ArborWire/WireObjects.swift`, same
names:

```swift
public struct WireDirectory: Hashable, Sendable {
    public var entries: [WireDirectoryEntry]
    public var childrenSource: WireCollectionFileDescriptor?
}
public struct WireDirectoryEntry: Hashable, Sendable {
    public var name: String
    public var target: WireEntryTarget
}
public enum WireEntryTarget: Hashable, Sendable { case file(String), directory(String), tree(String) }
public enum WireEntryKind: Sendable { case file, directory }
public enum WireDirectoryCodec {
    public static func encode(_ directory: WireDirectory) throws -> Data
    public static func decode(_ bytes: Data) throws -> WireDirectory
}
public func hashObject(_ bytes: Data) -> String
```

Deleted: `WireObject`, `WireObjectCodec` (encode, decode, hash, object,
`kind(ofPrefix:)`, `kindPrefixLength`). `WireObjectEnvelope` stays: an
envelope carries any object's hash and bytes over JSON.

### D2. Graph verification classifies by the referencing entry

One walk with one name in both languages: TypeScript
`verifyTreeSnapshotGraph(snapshot, mode: "complete" | "sparse-files")`
(`packages/wire/src/updates/json.ts:329-345`), Swift
`WireObjectGraph.validate(_:mode:)` (`WireObjects.swift:287-345`). Rules:

1. The root must be a present member and decode as a directory whose canonical
   re-encoding equals its bytes.
2. Walk entries depth-first. A `directory` reference with no member is an
   error in every mode. A `file` reference with no member is an error in
   `complete` mode and an omitted file in `sparse-files` mode. A present
   `file` member is never decoded; its hash was checked when the bundle was
   read.
3. One hash referenced as `file` in one place and `directory` in another is an
   error. A member reachable as a file whose bytes happen to be a canonical
   directory is fine: bytes are bytes.
4. Members not reached are an error. A directory cycle is an error.
5. Bundle-level checks stay exactly as today: canonical CBOR envelope,
   `version: 1`, members sorted by hash, no duplicates, hash of each member
   computed from its bytes.

`decodeSnapshotBundle` and `decodeSparseSnapshotBundle`
(`packages/wire/src/snapshots.ts:63, 90`) stop calling a per-member decoder;
the sparse decoder returns the raw member map and the caller runs the walk in
`sparse-files` mode. The rule "every `.md` file object is present in a sparse
spine" stays a bootstrap and `SnapshotBridge` rule, because Markdown source
must be inline; it is not a graph rule.

### D3. The bootstrap `files` map is deleted

Its only reason was classification. `size` is consumed at exactly one place:
`WorkingTreeProvider.swift:154` (`byteCount: record.ref?.size ?? 0`) feeding
`ArborRootView.swift:3622`. It is carried by
`ContentRef.hash(_, size:, mediaType:)` (`WorkingTreeModels.swift:51`) and
threaded back through `sparseFileMetadataByHash()`
(`WorkingTree.swift:248-256`) into `UpdateCoordinator.swift:495, 1136`.

- `ContentRef.hash(String, size: Int?, mediaType: String?)`; `size` decoded
  with `decodeIfPresent`. `WorkingTreeProvider` surfaces `byteCount: Int?` and
  the view shows nothing when unknown. When `WorkingTree.payload(of:)`
  (`WorkingTree.swift:666-678`) first reads a hash reference it records the
  size on the node.
- `SnapshotBridge.replacement(snapshot:tree:update:cursor:mode:)` takes
  `mode: WireObjectGraph.ValidationMode` (`.complete` or `.sparseFiles`) in
  place of `files:`/`filesByHash:`. A payload-less `file` entry becomes
  `.hash(hash, size: nil, mediaType: inferred)`; a payload-less `directory`
  entry is an error; an absent `.md` `file` entry is an error.
  `replaceFromSystem` and `integrateAccepted` keep the existing node's `size`
  and `mediaType` when the incoming reference has the same hash and no size.
- Deleted: `SparseFileMetadata`, `sparseFileMetadataByHash()`,
  `objectKind(hash:)`, `TreeBootstrap.files` (TypeScript
  `packages/arborsync/src/service.ts:89` and `packages/arborsync-client`,
  Swift `Protocol.swift:293` and `TreeBootstrapFile`), `checkSparseEntries`,
  `ArborVisitSnapshot.Sparse.files`.
- `sparseSpine` becomes a pure walk over entries: `directory` recurses, a
  `file` whose name ends in `.md` is included, any other `file` is skipped. No
  `stat` in the bootstrap path.

### D4. ObjectDelta for files

Nothing structural changes: delta instructions address the exact bytes of base
and result, and those bytes are now the file's payload. What changes:

- `spec/01-tree-operations.md:701-705` (the "canonical encoding carries its
  payload length" paragraph) is replaced by one sentence: a file delta
  addresses file bytes directly, so an editor edit is copies of unchanged
  ranges plus inserts.
- `UpdateCoordinator.swift:985-1000` drops the header arithmetic (`baseHeader`
  and the leading `.insert` of the header prefix); the reconstructed result is
  `Data(resultSource.utf8)`. `WorkingTree.swift:846-856` hashes
  `Data(source.utf8)` directly.
- `packages/wire/src/updates/delta.ts:73` comment; Canopy `reconstructDeltas`
  (`packages/canopy/src/objects.ts:137`) and `WireTransitionReplay.applying`
  (`WireTransitions.swift:70`) stop decoding results; the final graph walk
  validates kinds.
- `conformance/wire-object-deltas.json` uses synthetic hashes and is unchanged;
  `tests/unit/wire/object-delta.test.ts` fixtures that build `{type: "file"}`
  objects switch to raw bytes.

Model hashes hash `{content: bytes}` (`packages/canopy/src/updates/model-hash.ts:50`),
not the wire object, so `modelHash` values survive unchanged.

### D5. Canopy's object route serves `application/octet-stream`

`GET /.arbor/trees/{id}/objects/{hash}` (`packages/canopy/src/host.ts:575-584`)
serves any object as `application/octet-stream`; the hash does not tell you
the kind, and a file object is no longer CBOR. `schemaFingerprint` (SHA-256 of
the raw `schema.ts` bytes) now coincides with that file's object hash; the
spec remark at `spec/01-tree-operations.md:817-821` says so instead of
contrasting them.

## Current repository state

Confirm these facts during the drift check:

- `packages/wire/src/objects.ts:5-8` defines `WireFile` as `{type, bytes}`;
  `:61-67` hashes and encodes any object through canonical CBOR; `:69-128`
  decodes strictly; `:143-163` and `:170-212` branch on `object.type`.
- `packages/wire/src/snapshots.ts:63, 90` decode every bundle member;
  `packages/wire/src/updates/json.ts:329-345` requires a canonical re-encode
  of every reachable object and recurses only on directories.
- `packages/fs/src/wire-tree.ts:111-114` wraps `readFile` in `{type: "file"}`;
  `:107, 124` set `WireObjectSource.kind`; `:243-265` materializes by decoding.
- `packages/stores/src/object-index.ts:36-50` stores rows for files and
  directories with one `rememberObject`.
- `packages/canopy/src/objects.ts:67-87` decodes every reachable object in its
  walk; `canopy.ts:1690-1733` validates uploads the same way and `:1717-1725`
  requires `type === "file"` for collection sources; `host.ts:640-690`
  decodes children to classify them for public pages.
- `packages/canopy/src/schema.ts:12` is schema version 6.
- Swift `WireObjects.swift:50-71, 73-113` encode and decode `{type, bytes}`;
  `:119-138` sniff CBOR prefixes; `:287-345` validate graphs in `.complete` or
  `.sparseFiles`, assuming a missing member is a file (`:329`).
- `native/ArborApp/ArborAppModel.swift:212-223` writes the iOS `wire-format`
  marker, currently `4`; an older marker re-places the tree
  (`docs/local-system.md:73-81`).
- `tsconfig.json:41` already excludes `migrations/001-if-match-and-model-hash`
  because it compiles only against the build it shipped with.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| TypeScript typecheck | `bun run typecheck` | exit 0 |
| Product tests | `bun run test` | exit 0 (see the flaky-parallel note in `plans/testing/002-parallel-integration-isolation.md`) |
| Protocol conformance | `bun run test:protocol` | TypeScript, live, and Swift fixtures pass |
| Vector regeneration | `bun run tools/canonical-cbor-vectors.ts && git diff --exit-code conformance` | no diff: regeneration is a fixed point |
| Swift wire | `swift test --package-path native/Packages/ArborWire` | exit 0 |
| Swift object store | `swift test --package-path native/Packages/ArborObjectStore` | exit 0 |
| Swift working tree | `swift test --package-path native/Packages/ArborWorkingTree` | exit 0 |
| Swift sync client | `swift test --package-path native/Packages/ArborSyncClient` | exit 0 |
| Swift Canopy client | `swift test --package-path native/Packages/CanopyClient` | exit 0 |
| App tests | the `Arbor` scheme in `native/project.yml` through Xcode | green |
| Migration rehearsal | `bun run test:migration migrations/005-file-bytes-are-the-object` | exit 0 |
| Diff hygiene | `git diff --check` | no output |

Never run `swift build`, `swift test`, or `swift package resolve` against
`native/Packages/ArborQuagmire`; use `tools/test-arbor-quagmire-local.sh`
(`AGENTS.md:26-46`). Use the next migration number instead of `005` if another
migration lands first.

## Scope

### In scope

- `packages/wire/src/{objects,snapshots,client}.ts`,
  `packages/wire/src/updates/{json,delta,apply}.ts`
- `packages/fs/src/wire-tree.ts`, `packages/stores/src/object-index.ts`
- `packages/canopy/src/{objects,canopy,host,public-page,profile,account-policy,account-policy-v2,boundaries,schema}.ts`,
  `packages/canopy/src/updates/{merge,merge-rules,model-hash,transition}.ts`
- `packages/wire-projection/src/projection.ts`
- `packages/canopy-client/src/{tree-sync,sync-state}.ts`
- `packages/arborsync/src/{service,object-cache}.ts`,
  `packages/arborsync-client/src/index.ts`, `packages/core/src/protocol.ts`
- `tools/canonical-cbor-vectors.ts`, `tools/recovery/*`,
  `tools/recover-arborsync-tree.ts`
- `conformance/*`, `tests/fixtures/arborsync/*`, `tests/fixtures/canopy/*`,
  `tests/unit/**`, `tests/integration/**`, `tests/protocol/**`
- `native/Packages/{ArborWire,ArborObjectStore,ArborWorkingTree,ArborSyncClient,CanopyClient}`
  sources and tests; `native/ArborApp/{ArborVisits,ArborAppModel,ArborRootView}.swift`
- `spec/01-tree-operations.md`, `spec/09-client-synchronization.md`,
  `docs/arborsync-api.md`, `docs/local-system.md`,
  `docs/reference-implementation.md`, `conformance/README.md`
- `migrations/005-file-bytes-are-the-object/` and its rehearsal
- `tsconfig.json` (exclusions for immutable old migrations)

### Out of scope

- The object directory, the maintainer, and deleting `GET /v1/objects`
  (Arbor Sync 002). The route keeps working through this plan; it simply
  serves raw file bytes.
- Any compatibility shim: no decoder accepts both entry shapes or both file
  encodings, and no old fixture is kept alive.
- Editing `migrations/000` through `004`. They are immutable.
- Reliability 007's merge-state work. Sequence, do not interleave.
- Quagmire or its dependency pins.
- Canopy packing, retention, or the reachability index.

## Git workflow

- Branch `codex/arborsync-001-file-bytes` if needed.
- Commit by coherent step: wire and vectors, fs and stores, Canopy, clients,
  Swift, spec and docs, then the migration directory.
- Do not push, deploy, or run the production migration unless separately
  instructed. Phase 1 is gated on Joe in chat.

## Phase 0: the wire change in code, spec, and vectors (no live data)

Nothing in this phase touches a data root, `~/.arbor`, or the phone. Step 0.4
bumps the Canopy schema stamp so an old data root refuses the new build.

### Step 0.1: `@arbor/wire`

- `objects.ts`: D1. `resolveWireLogicalNode` returns
  `{ kind: "file"; bytes; objectName } | { kind: "directory"; directory; objectName; body?; bodyOrigin?; shadowedBody }`.
  Callers: `packages/canopy/src/host.ts:640-690`,
  `tools/recovery/arborsync-recovery.ts:242`.
- `updates/json.ts:329-345`: D2. `decodeTreeSnapshotJSON` keeps its hash
  check only.
- `snapshots.ts`: remove the per-member decode at `:63` and `:90`;
  `encodeSnapshotBundle` and `decodeSnapshotBundle` run the D2 walk in
  `complete` mode.
- `updates/delta.ts`, `updates/apply.ts`: comments (D4).
- `client.ts`: `WireClient.object()` returns verified bytes and never decodes.
- Tests: `tests/unit/wire.test.ts` (vector consumers at `:132-165`),
  `tests/unit/wire/{snapshot-bundle,accepted-transition,object-delta,update-intent}.test.ts`,
  `tests/unit/wire-client.test.ts`, `tests/unit/protocol.test.ts`.

### Step 0.2: conformance vectors

- Extend `tools/canonical-cbor-vectors.ts` so it regenerates *all* of
  `conformance/wire-objects.json` (file vectors become
  `{ name, bytesBase64, hash }` with no `canonicalCborBase64`; directory
  vectors use `file`/`directory`/`tree` entries), `wire-snapshot-bundles.json`
  (regenerated bytes and etags; add a `sparse` valid case and an `invalid`
  list: missing-directory-member, missing-file-in-complete, kind-conflict,
  unreachable-member), `wire-endpoints.json`, and `wire-update-intent.json`.
- Add invalid object vectors: `entry-with-hash-key` (the old shape must be
  rejected), `dual-target`, `file-and-directory`.
- `conformance/README.md` gains a paragraph on entry kinds.
- Swift `ArborWireTests.swift:36-90, 155-172` consume the same files; delete
  the `objectKindPrefix` test. `tests/protocol/conformance.ts` runs unchanged.

### Step 0.3: `@arbor/fs` and `@arbor/stores`

- `packages/fs/src/wire-tree.ts`: `readFileObject` returns raw bytes; entries
  are emitted kinded; `store()` encodes directories only; `materializeTree`
  branches on entry kind and never decodes a file.
- `SnapshotObjectIndex` (`wire-tree.ts:55-59`) becomes
  `{ fileHash(absolute, stat); rememberFile(absolute, stat, hash); rememberDirectory(absolute, hash, bytes); directoryHash?(absolute) }`.
  Directory bytes are passed now, even though only Arbor Sync 002's maintainer
  uses them, so that plan touches no walker code.
- `packages/stores/src/object-index.ts`: split `rememberObject` into the two
  port methods; the SQLite schema is unchanged.

### Step 0.4: `@arbor/canopy` and `@arbor/wire-projection`

- `objects.ts`: `walk` visits by entry kind and never reads a file member's
  bytes; `contains`, `completeSnapshot`, `verifyReachable` keep their
  signatures; `reconstructDeltas` stops decoding.
- `canopy.ts:1690-1733` validates by entry kind; `loadFile` returns the raw
  bytes of a `file` entry; `:1530`, `:1562-1566`, `profile.ts:22-26`,
  `account-policy.ts:52, 69`, `account-policy-v2.ts:51`, `boundaries.ts:69`,
  `updates/merge.ts:119-123`, `merge-rules.ts:205-240`,
  `model-hash.ts:37-50` (`object(hash, markdown)` becomes
  `file(hash, markdown)` and `directory(hash)`; the formula is unchanged),
  `updates/transition.ts:48-70` (`matchingEntry` compares kinds).
- `host.ts:575-584` (D5) and `:640-690`, `public-page.ts`.
- `packages/wire-projection/src/projection.ts:92-93, 166`.
- `schema.ts:12`: `CANOPY_SCHEMA_VERSION = "7"`.
- Tests: `tests/unit/canopy/*` (`update-merge.test.ts` builds file objects in
  fourteen places), `tests/fixtures/canopy/wire-merge.json` (regenerate if it
  bakes hashes), `tests/integration/canopy/*`,
  `tests/integration/self-sync.test.ts`, `protocol-faults.test.ts`.
  `tests/integration/server.test.ts:158-272` keeps passing: the route serves
  raw file bytes now.

### Step 0.5: `@arbor/canopy-client`, `@arbor/arborsync`, `@arbor/arborsync-client`, tools

- `packages/canopy-client/src/tree-sync.ts:45-57, 210-224, 379`;
  `sync-state.ts` envelopes are unchanged in shape.
- `packages/arborsync/src/service.ts:150-241`: conflict rewriting uses
  `encodeWireDirectory`; `sparseSpine` per D3; `TreeBootstrap.files` deleted
  at `:89` and in `packages/arborsync-client/src/index.ts`;
  `object-cache.ts` `encodeFile` returns raw file bytes.
- `tools/recovery/arborsync-recovery.ts:234-290`,
  `tools/recover-arborsync-tree.ts`: entry kinds.
- Regenerate `tests/fixtures/arborsync/bootstrap.json` and
  `bootstrap-pending.json` (every hash and the spine bytes change; `files` is
  gone) through a checked-in generator, and say where it lives in
  `tests/fixtures/README.md`. These fixtures feed `tests/unit/protocol.test.ts`
  and Swift `ArborSyncClientTests`/`LoopbackServicesTests`.

### Step 0.6: immutable old migrations

`migrations/002-collection-file-wire/run.ts` and
`migrations/004-profile-identity-challenges/run.ts` import the old codec.
Add both directories to `tsconfig.json` `exclude`, as `001` already is, and
add one line to each README saying it compiles only under the build it shipped
with. Do not edit their code.

### Step 0.7: Swift

- `ArborWire`: D1 and D2 in `WireObjects.swift`; `WireSnapshot.rootFile(named:)`
  and `replacingRootFile` use entry kinds; `WireTransitions.swift:60-108`
  stops decoding delta results; `ArborWireClient.object` verifies only.
- `ArborObjectStore`: `ObjectOverlay.reachableHashes` and
  `DirectoryObjectStore.reachableHashes` walk by entry kind (a `file` target
  is a leaf; a `directory` target is decoded); delete the prefix sniffing.
- `ArborWorkingTree`: `WorkingTreeWireObjects.swift` (`file(_:)` deleted;
  `directory(...)` emits kinds; inline references and Markdown store raw
  bytes), `SnapshotBridge.swift` (D3), `WorkingTreeModels.swift:51-95`
  (optional size), `WorkingTree.swift:248-265, 666-678, 846-856`,
  `WorkingTreeProvider.swift:154`,
  `UpdateCoordinator.swift:495, 985-1000, 1136, 1158-1175`
  (`retainedObjectHashes` by entry kind), `ConflictWorkspace.swift:60, 103, 124`.
- `native/ArborApp/ArborAppModel.swift:212-223`: bump `workingTreeFormat`
  from `4` to `5` so an old phone re-places from Canopy.
- `ArborSyncClient`: `Protocol.swift:293` (`files` gone),
  `ArborSyncRESTClient.swift:158-200` (`object` keeps working but stops
  decoding; `checkSparseEntries` deleted; sparse validation is
  `WireObjectGraph.validate(spine, mode: .sparseFiles)`).
- `CanopyClient/Sources/CanopyClient/Credentials.swift:792-794`: the
  configuration snapshot uses raw file bytes and kinded entries.
- `ArborApp`: `ArborVisits.swift:141-195`, `ArborAppModel.swift:836-845`
  (`mode: .sparseFiles`), `ArborRootView.swift:3622` (`byteCount: Int?`).
- Tests in every touched package: `ArborWireTests`, `ArborObjectStoreTests`,
  `ArborWorkingTreeTests` (`UpdateCoordinatorTests.swift:162-210, 977-995, 1493, 1534, 1739`,
  `WorkingTreeObjectTests`, the fixture at `ArborWorkingTreeTests.swift:45`),
  `ArborSyncClientTests`, `LoopbackServicesTests`, `ArborAppTests`.

### Step 0.8: spec and docs

These change in this phase because this phase makes them true.

- `spec/01-tree-operations.md`: `:115-121` (sparse install: a payload-less
  `file` entry is an omitted file; a payload-less `directory` entry fails the
  install), `:240-286` (the entry shape; "a file object's bytes are the file's
  bytes and its hash is the SHA-256 of those bytes; a snapshot root is always a
  directory"), `:396-405` (route content type), `:689-712` (D4),
  `:775-825` (§4.1: `objectBytes` is the file's bytes or the directory's
  canonical CBOR; the `schemaFingerprint` remark).
- `spec/09-client-synchronization.md:56-61` (sizes are no longer named by the
  bootstrap).
- `docs/arborsync-api.md:218-260` (bootstrap without `files`),
  `docs/local-system.md` (index paragraph wording), `docs/reference-implementation.md:34-39`,
  `conformance/README.md`.

### Phase 0 verification

- Every command in the table above except the migration rehearsal.
- `grep -rn "decodeWireObject\|encodeWireObject\|WireFile\b\|WireObjectCodec\|kind(ofPrefix\|SparseFileMetadata\|checkSparseEntries" packages native tools tests spec docs conformance`
  returns nothing outside `migrations/`.

## Phase 1: the gated live migration

**Gate**: Joe says go in chat. Nothing in this phase runs against Railway
`/data`, `~/.arbor`, or the phone before that. Backups, the Railway residue,
and the CLI quirks from the 2026-09 cutover are the precedent.

### Step 1.1: `migrations/005-file-bytes-are-the-object/`

- `run.ts` (Canopy, schema 6 to 7): refuses any other stamp and refuses to
  run twice. Vendors the pre-Phase-0 decoder into `migrate.ts` as
  `decodeLegacyObject` (as `002` did with `LegacyEntry`). For every tree, walks
  from `ref` with the legacy decoder and rewrites bottom-up: a file becomes its
  payload bytes; a directory becomes kinded entries with the new child hashes.
  Stores new objects through `ObjectStore.store`, updates `trees.ref`, resets
  `accepted_updates` to one `restored` update per tree with
  `transition_json = NULL`, clears `reflog` and `observations`, re-inserts one
  reflog row (`migrations/002-collection-file-wire/run.ts:216-222`), prunes
  objects reachable from no new ref, stamps `7`. The report lists tree ids,
  previous roots, new roots, and counts only.
- `migrate.test.ts`: builds a schema-6 data root with the vendored legacy
  encoder, runs the migration, asserts materialized equality of every tree and
  `Canopy.verifyIntegrity()`.
- `local.ts` (Mac data home): requires every placement `idle` with no
  conflict; deletes `<.state>/sync/*.json` and
  `<.state>/workspaces/*/index.sqlite`; clears `ref` and `update` for every
  placement in `placements.yaml`. `tree-sync.ts:370-376` then adopts the
  migrated root when the folder walk equals it. Precedent:
  `migrations/004-profile-identity-challenges/local.ts`.
- iPhone: a fresh placement under the bumped marker, exactly as
  `docs/local-system.md:73-81` describes; document it in the README.
- `README.md` runbook and `rehearsal.md` per `migrations/README.md`: back up,
  download, restore two copies, run, compare roots, serve the migrated copy
  with the new build, verify.

### Phase 1 verification

- `bun run test:migration migrations/005-file-bytes-are-the-object` exit 0.
- Rehearsal recorded green in `rehearsal.md`.
- After cutover: `GET /v1/trees` shows every placement `idle` with `root`
  equal to the report's new root; `arbor status` clean; the phone opens every
  placed tree.

### Soak

Before Arbor Sync 002 starts: several days of ordinary use on the Mac and the
iPhone with no resync, no conflict, and no `diagnostic` event from the object
index. Record the dates in the `_done` entry.

## Done criteria

- [ ] A file's object hash equals `sha256` of its bytes; `shasum -a 256` on a
      placed file agrees with the entry hash Canopy stores.
- [ ] Directory entries are `file`, `directory`, or `tree`; no code path
      decodes an object to learn its kind.
- [ ] `WireObjectSource.kind`, the bootstrap `files` map, and Swift prefix
      sniffing are gone.
- [ ] TypeScript and Swift agree on every regenerated conformance vector, and
      regeneration is a fixed point.
- [ ] Canopy's reachability walks never read a file member's bytes.
- [ ] Canopy schema 7; an unmigrated data root refuses the new build.
- [ ] Migration rehearsed, run, and verified on Canopy, the Mac, and the
      iPhone; evidence recorded.
- [ ] Spec, docs, and conformance README describe the new model.

## STOP conditions

Stop and report instead of improvising if:

- any decoder would need to accept both entry shapes or both file encodings
  (there is no shim; the migration is Phase 1);
- a fixture's expected hash cannot be regenerated by a checked-in generator;
- TypeScript and Swift disagree on a regenerated vector;
- `tests/fixtures/canopy/wire-merge.json` turns out to encode merge semantics
  that depend on file-object headers;
- Reliability 007 work has landed on `packages/canopy/src/updates/*` since the
  drift-check commit (rebase decision is Joe's);
- during Phase 1: any placement is not `idle` or holds a conflict; before and
  migrated materialized files differ for any tree; `verifyIntegrity` fails on
  the migrated copy; the phone holds unsynchronized edits.

## Maintenance notes

- The kind lives on the entry, never in the object store. A store is bytes by
  hash; `objects/<TreeID>/<hex>` in Arbor Sync 002 relies on that.
- `WireObjectEnvelope` is transport only. Do not reintroduce a typed object
  wrapper "for convenience"; that is the trap this plan removes.
- If a future format ever needs per-file metadata (media type, size), put it
  on the directory entry, not in the object.
