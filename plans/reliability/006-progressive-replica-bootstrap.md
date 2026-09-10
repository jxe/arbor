# Reliability 006: Preview and resume initial working-tree bootstrap

> **Rescoped by [Native 022](../native/022-run-the-mac-app-as-a-working-tree-client.md)**:
> the client is `WorkingTree` (package `ArborWorkingTree`), placement is
> `WorkingTreePlacementService.place`, and steady-state synchronization is
> `UpdateCoordinator`. This plan applies to iOS placement and to visits, where
> the complete accepted snapshot still comes from Canopy in one body. On the
> Mac the bootstrap is loopback from the daemon (`GET /v1/bootstrap`: a sparse
> spine of directories and Markdown with every other file by hash) and is not
> progressive; nothing here changes it. "Replica" below reads as "working
> tree"; `Replicas/` is `WorkingTrees/`.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Keep
> the initial download separate from a usable `WorkingTree`: a verified
> root-page preview may appear early, but editing, offline-ready status, and
> normal synchronization begin only after the complete accepted snapshot has
> been validated and atomically installed. [Reliability
> 005](../_done/reliability/005-client-synchronization-state-machines.md) owns steady-state
> synchronization after that handoff. Do not build a second lazy replica or
> materialize a partial object graph into the normal replica store. If a STOP
> condition occurs, stop and report rather than improvising. When complete,
> move this file to
> `plans/_done/reliability/006-progressive-replica-bootstrap.md`, record exact
> verification evidence, and remove its active entry from `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 9b7da49..HEAD -- \
>   native/ArborApp \
>   native/Packages/CanopyClient native/Packages/ArborWire \
>   packages/canopy packages/wire tests docs spec/01-tree-operations.md
> git status --short
> ```
>
> This plan was written against `9b7da49`, where
> `ReplicaPlacementService.place` still waits for
> `ArborWireClient.snapshot`, that client still buffers the complete response
> with `URLSession.data(for:)`, and Canopy still encodes and returns a complete
> snapshot body without byte-range handling. If any of those facts changed,
> reconcile this plan with the current source before implementation.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: the current retained accepted-snapshot route and immutable
  object store; Step 2 deliberately widens tree-scoped object reads to retained
  accepted roots for preview and future Canopy-owned history
- **Coordinates with**: Reliability 005 and Native 022; this plan owns the
  bootstrap submachine for iOS placement and visits, and `UpdateCoordinator`
  owns the update machine after the `bootstrapInstalled` handoff. The Mac's
  loopback bootstrap is out of scope.
- **Category**: startup latency, transfer recovery, durability, and native UX
- **Planned at**: commit `9b7da49`, 2026-09-07

## Outcome

On first placement, iOS quickly fetches the current descriptor, then reads the
addressed root directory object and its `_index.md` object when present through
the tree-scoped object route. After verifying their hashes and relationship,
Arbor displays that root Markdown as a read-only preview while the complete
immutable snapshot downloads in the background. The UI shows distinct
server-preparation, byte-transfer, validation, installation, and catch-up
stages rather than one indefinite spinner.

The full snapshot download is checkpointed outside `Replicas/` and resumes
after a hotspot interruption with HTTP `Range` plus the immutable bundle ETag.
Progress resets the inactivity timeout; a slow connection which continues to
deliver bytes is not failed by a fixed whole-request deadline. After the entire
bundle is present, Swift validates canonical CBOR, every object hash, graph
reachability, and the pinned root before initializing a staging replica. A
successful atomic promotion produces exactly one typed
`bootstrapInstalled(root:update:cursor:)` result for Reliability 005. Only then
does Arbor enable editing and claim the tree is locally/offline available.

If Canopy accepts a newer root during download, the pinned accepted snapshot
remains valid. Arbor installs it and the ordinary direct synchronization
machine catches up from the pinned update/cursor. Cancellation, timeout, app
suspension, or relaunch retains a resumable partial download and never destroys
an already usable replica.

## Why this matters

The current path serializes all useful work:

```swift
let current = try await transport.descriptor(tree: tree.id)
let snapshot = try await transport.snapshot(tree: tree.id, root: current.tree.root)
let replica = try await ArborReplica.open(...)
try await replica.initializeFromSystem(replacement)
```

`ArborWireClient.snapshot` uses `URLSession.data(for:)`, so the app has no
transfer progress or durable partial bytes and decodes only after the whole
body arrives. `ArborWorkspaceState.place` may delete an incompatible replica
before replacement succeeds. The launch UI can only say “Syncing” until the
entire graph is ready. On a hotspot this makes a healthy slow transfer look
stuck, and a timeout starts it again from byte zero.

Canopy already exposes immutable retained accepted snapshots with ETags and
has a reachability-checked immutable object store. Step 2 deliberately permits
the existing tree-scoped object route to read an object reachable from any
retained accepted root, rather than only the current root, so the preview cannot
race with the current root changing. The caller must still have current read
access to the tree. This aligns object access with Canopy-owned retained history
and is enough to make the first page visible early without accepting partial
graphs as replicas or putting history back into the replica layer.

## Required bootstrap state machine

Implement one Swift payload-state reducer with an effect runner. State names
may follow Swift conventions, but tests and documentation use these semantics:

| State | Retained data | Meaning |
|---|---|---|
| `unplaced` | tree, origin, destination | No accepted root is pinned. |
| `fetching-descriptor` | request identity | Resolving one coherent accepted `{root, update, cursor}`. |
| `fetching-preview` | pinned descriptor | Fetching root directory and optional `_index.md` by hash. |
| `downloading` | pinned descriptor, ETag, expected/received bytes, partial-file identity | Immutable full bundle is streaming or resumable. |
| `paused` | exact checkpoint plus classified availability reason | Transfer stopped safely and may resume without changing identity. |
| `validating` | pinned descriptor, completed bundle path and ETag | Complete bytes exist but are not yet trusted. |
| `installing` | validated snapshot and staging-replica path | Building a complete normal replica before atomic promotion. |
| `installed` | root, update, cursor and final replica path | Terminal bootstrap success; emit `bootstrapInstalled`. |
| `failed` | diagnostic and retained safe evidence | Authentication, protocol, storage, or invariant failure requiring attention. |

The preview is orthogonal presentation data attached only after verified root
and body objects arrive. It is not a replica state, does not satisfy placement,
and cannot accept edits.

Required invariants:

1. Pin one descriptor result before preview or bundle requests. Every request
   is scoped to the same TreeID and root. Retain the update and
   `observedThrough` cursor for the final handoff.
2. Fetch the root directory through the existing
   `GET /.arbor/trees/{TreeID}/objects/{hash}` route, verify its URL hash and
   CBOR type, then fetch only its `_index.md` entry if present and verify that
   file object before rendering. Change that route to return an object when it
   is reachable from the current root or any retained accepted root for the
   same tree and the caller currently has read access to that tree. Absence of
   `_index.md` produces a valid empty preview. Never recursively fetch children
   for the preview.
3. Render the preview as inert Markdown/source through the existing safe
   read-only rendering path. Disable editor commands, mutations, Share actions
   which assume local placement, search, backlinks, and offline-ready claims.
4. Persist bootstrap control and partial bytes under a private staging root
   keyed by origin plus TreeID, not under the final replica's materialized
   state. Store no bearer credential or access-link secret. Write control
   atomically after response identity is known and after each bounded progress
   checkpoint.
5. Canopy returns `Accept-Ranges: bytes`, a strong immutable ETag, and exact
   `Content-Length` for accepted snapshot bundles. A resume uses
   `Range: bytes=N-` with `If-Range: <stored-etag>`. Accept only a correct `206`
   and `Content-Range` starting at N. A `200` means replace the partial body
   from byte zero. A `416`, ETag disagreement, impossible length, or overlapping
   body discards only that partial artifact and starts a fresh transfer of the
   same pinned root.
6. Stream response bytes to the partial file and publish throttled progress;
   do not append through repeated whole-file reads. Use an inactivity timeout
   which is rearmed by received bytes and a separate bounded server-response
   timeout before headers. Do not impose a fixed deadline on the entire body.
7. The complete file is untrusted until its length and ETag agree and
   `WireSnapshotBundleCodec` proves canonical encoding, ordered unique objects,
   every object hash, exact graph closure, and pinned root. Provide a file-based
   decoding entry point so transfer does not require a second network-sized
   allocation; retain the existing `Data` API as a compatibility wrapper.
8. Initialize a fresh staging `ArborReplica`, verify its materialized and
   accepted heads equal the pinned descriptor, fsync/atomically rename the
   completed directory where supported, then write the wire-format marker.
   Never remove or overwrite a usable final replica until staging has passed.
9. On success remove the partial bundle/control files asynchronously only after
   the promoted replica opens successfully. On retryable failure retain them;
   on terminal validation failure retain a bounded diagnostic but remove
   untrusted payload bytes through a recoverable staging-only cleanup.
10. If a descriptor refresh shows a newer accepted root before installation,
    do not switch roots mid-transfer. Finish the pinned immutable root, emit
    `bootstrapInstalled`, then let Reliability 005 catch up using watch or
    accepted transitions. If the pinned root or observation cursor is no longer
    retained, use the existing explicit resync-required path after installation.

## Scope

**In scope**:

- a bootstrap reducer, durable checkpoint types, and placement effect runner
  under `native/Packages/CanopyClient/Sources/CanopyClient/`
- `ReplicaPlacementService` migration to that runner and a typed progress/
  preview/result API
- `ArborWireClient` object fetch reuse plus streamed/resumable snapshot download
- a file-based Swift snapshot-bundle decoder which preserves all existing
  canonical and graph validation
- `ArborWorkspaceState.place`, iOS first-placement and add-tree UI, and focused
  native tests
- Canopy accepted-snapshot response range semantics, retained-root object-read
  authorization, and focused host tests
- language-neutral HTTP fixtures for full, partial, resumed, mismatched, and
  unsatisfiable immutable range responses
- `spec/01-tree-operations.md`, `docs/reference-implementation.md`, native
  client/state-machine documentation, `status.md`, and plan indexes

**Out of scope**:

- lazy or demand-paged steady-state replicas
- editing before the full graph is durably installed
- treating the preview/object cache as a complete or offline-ready replica
- retaining prior replica generations or adding History/Recover to Replica,
  Arbor Sync, or this bootstrap store
- changing Canopy's accepted-history, merge, authorization, root identity, or
  object reachability rules
- exposing retained objects after the caller loses current read access to the
  tree, or exposing objects which are not reachable from one of that tree's
  retained accepted roots
- a generic download framework, CDN, bundle pack format, or Canopy storage
  packing implementation
- Android, browser editor, deployment, release, or live production mutation

## Steps

### Step 1: Freeze bootstrap transitions and HTTP range behavior

Add versioned language-neutral fixtures covering bootstrap state/effects and
immutable snapshot range responses. Include first fetch, root preview with and
without `_index.md`, continuous slow progress, timeout before headers,
inactivity timeout, cancellation, suspension/relaunch, valid resume, ignored
Range returning `200`, bad `Content-Range`, ETag change, `416`, corrupt final
bytes, storage exhaustion, install crash, and Canopy advancing during download.

Specify exact reducer effects (`fetchDescriptor`, `fetchObject`,
`startDownload`, `checkpoint`, `validate`, `stageReplica`, `promote`,
`publishPreview`, `publishProgress`, `handoff`, `surfaceFailure`) and prove only
`handoff` can enter Reliability 005.

**Verify**: the new TypeScript fixture-schema test and Swift fixture decoder
both pass and reject unknown states/effects.

### Step 2: Add correct immutable byte ranges to Canopy

Widen the existing tree-scoped object route as described in invariant 2. Reuse
Canopy's retained-root registry, graph reachability, exact object read, hash
verification, current tree authorization, and access-sensitive cache partition.
Update the portable specification's current-only restriction explicitly; this
is an intentional access-policy change, not an implementation accident. Tests
must prove that a root which advances after descriptor pinning does not
invalidate reads for the retained pinned root, while revoked callers,
unretained-only objects, and objects belonging only to another tree remain
indistinguishable from missing content.

Extract a focused helper for single-range GET handling on accepted snapshot
bytes. Preserve authorization before snapshot lookup and preserve the existing
access-sensitive cache policy. Return full `200` or one valid `206`; reject
multiple/suffix ranges unless deliberately covered by the fixture. Include
strong ETag, `Accept-Ranges`, `Content-Length`, and `Content-Range` where
applicable. Honor `If-Range`; never return bytes for an unauthorized or
non-retained snapshot.

Measure snapshot preparation time separately from response transfer time. Add
structured timing/size fields without tree content or credentials so a slow
server encoding phase is distinguishable from a slow hotspot download. Do not
claim that Range avoids the current encoding cost; cache or packed-storage work
remains Canopy storage 001 unless measurement proves a small bounded cache is
needed here.

**Verify**: focused Canopy host tests cover all fixture cases, authorization,
ETag stability, exact reconstructed bytes, and unchanged full-response bytes;
`bun run test:protocol` passes.

### Step 3: Stream, checkpoint, and resume in ArborWire

Add a transport method which exposes response metadata and streams bytes to an
explicit staging URL. Implement strict resume validation from Step 1, atomic
checkpoint writes, progress throttling, cancellation, and progress-aware
timeouts. Keep `ArborWireClient` stateless with respect to product placement:
the bootstrap effect runner owns checkpoint policy and supplies the byte offset,
ETag, and destination.

Add file-based snapshot decode/validation. The decoder must reject noncanonical
CBOR, duplicate or unordered objects, bad hashes, unreachable extras, missing
children, cycles, and a root mismatch exactly as the existing in-memory API
does. Make `snapshot(tree:root:)` call the same validation core so there is one
security boundary.

**Verify**: `swift test --package-path native/Packages/ArborWire` passes with
stubbed split-body delivery, progress, resume, cancellation, response timeout,
inactivity timeout, malformed ranges, and all existing codec vectors.

### Step 4: Implement durable bootstrap and atomic replica promotion

Implement the reducer/effect runner in ArborSync. Use a schema-versioned control
file and deterministic staging/final paths. On relaunch, validate the control
against the partial file before resuming. Fetch/publish the root preview in
parallel with starting the full bundle only after the descriptor is pinned.

Decode and validate the completed bundle, bridge it to one system replacement,
initialize a staging replica, reopen and inspect its heads, then promote it.
Change `ArborWorkspaceState.place` so a wire-format mismatch or replacement
never deletes the current replica/sync state before the new staging replica is
ready. Emit a typed installed handoff containing the pinned root/update/cursor.

**Verify**: `swift test --package-path native/Packages/CanopyClient` passes with
restart/fault injection at every durable boundary, exact partial reuse, corrupt
partial recovery, no mutation of an existing replica on failure, exact snapshot
round-trip, and one handoff only after successful promotion.

### Step 5: Surface immediate preview and honest progress on iOS

Replace the single `.syncing` launch phase with payload states driven by the
bootstrap API. As soon as verified root Markdown is available, show it in the
normal visual language but clearly label it as a read-only preview. Show:

- “Preparing snapshot on Canopy…” before response headers;
- “Downloading X of Y MB…” with determinate progress when length is known;
- “Downloading X MB…” when length is unknown, without fake percentages;
- “Validating downloaded snapshot…” and “Preparing offline copy…”;
- “Catching up…” after the installed handoff while Reliability 005 applies a
  newer accepted state.

Offer retry for paused/offline states and resume automatically when network
reachability returns. Preserve the preview and received-byte count across a
retry. Add-tree placement uses the same component/API. VoiceOver announces
stage changes without announcing every byte tick.

**Verify**: native view/model tests prove the preview appears before bundle
completion, every action remains read-only until install, progress is monotonic,
retry resumes, terminal errors are distinct from offline pauses, and ready is
set only after the complete replica opens.

### Step 6: Hand off to Reliability 005 and document ownership

Wire `bootstrapInstalled(root:update:cursor:)` to Reliability 005 state machine
B's `current` entry transition. Test a server which advances from A to B while
A downloads: the preview remains A, A installs, then ordinary transition/watch
logic catches up to B without restarting bootstrap or losing the UI.

Document the lifecycle and storage boundary: Canopy owns accepted history;
bootstrap owns only an incomplete current-snapshot transfer; Replica owns one
complete local current graph plus pending authored work; Reliability 005 owns
steady-state synchronization. Update `status.md` only after the actual runtime
uses the new path.

**Verify**: state-machine integration tests and repository-wide relative-link
check pass; `git diff --check` reports no errors.

### Step 7: Run maintained gates and archive the plan

Run:

```sh
bun run typecheck
bun run test:protocol
bun run test
bun run build
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/CanopyClient
tools/test-arbor-quagmire-local.sh
git diff --check
```

For iOS, build the ignored `native/Arbor.local.xcworkspace` so the sibling
Quagmire checkout overrides the exact published package pin. Test a fresh
placement with Network Link Conditioner or a throttled local server, interrupt
it after measurable progress, relaunch, and verify the second request resumes
from the checkpoint. Record first-preview latency, bytes reused, total bytes,
server preparation time, and transfer time. If a maintained full gate fails,
reproduce it from a clean worktree at the planned base before calling it a
regression.

## Done criteria

- [ ] Verified root `_index.md` is visible read-only before the full snapshot
  finishes downloading.
- [ ] Initial placement exposes honest preparation, byte progress, validation,
  installation, paused, failure, and catch-up states.
- [ ] A progressing slow transfer does not hit a fixed whole-body timeout.
- [ ] An interrupted transfer resumes with strict Range/ETag validation and
  reconstructs byte-identical canonical snapshot bytes.
- [ ] Relaunch retains a valid checkpoint without retaining credentials.
- [ ] Partial or corrupt data never appears in `Replicas/`, enables editing, or
  produces an offline-ready claim.
- [ ] Existing usable replica and sync state survive every failed replacement.
- [ ] Complete validation and staging promotion precede exactly one
  `bootstrapInstalled(root:update:cursor:)` handoff.
- [ ] A remote update during hydration is caught up by Reliability 005 without
  restarting the pinned download.
- [ ] Canopy range responses remain authorization-scoped and byte-identical to
  the existing complete immutable bundle.
- [ ] Server preparation and client transfer timings are separately observable.
- [ ] Focused, maintained, link, whitespace, and manual throttled-network gates
  pass with recorded evidence and no unrelated file changes.

## STOP conditions

Stop and report rather than improvising if:

- the widened object route cannot prove that the requested object is reachable
  from at least one retained accepted root for this tree without widening
  access across trees or past current read revocation;
- Range support would expose an unauthorized/non-retained snapshot or weaken
  the current access-sensitive cache policy;
- the response cannot provide one stable strong ETag and total length for the
  same immutable bytes across resume requests;
- safe file-based decoding would accept a different graph than the existing
  canonical in-memory decoder;
- atomic promotion cannot preserve an existing usable replica on failure;
- a UI requirement would allow mutation, offline-ready status, search, or
  backlinks from a partial graph;
- the Reliability 005 handoff would require a second direct sync machine or
  advancing its accepted base before replica durability;
- a protocol change lacks matching TypeScript/Swift models, neutral fixtures,
  API/spec documentation, and focused tests;
- implementation requires live production mutation, a Quagmire release, or
  files outside declared scope.

## Maintenance notes

- Keep preview latency, server preparation time, transfer throughput, retries,
  and reused bytes measurable separately. “Sync took N seconds” is not a useful
  diagnosis for this path.
- The partial bundle is a bounded current-transfer artifact, never user-visible
  history. Successful installation reclaims it; retryable interruptions retain
  only the one pinned current transfer.
- Preserve the canonical bundle bytes and validation boundary. If Canopy
  storage 001 later serves packed objects or prebuilt bundles, it may optimize
  preparation without changing this client's bootstrap states or ETag/Range
  semantics.
- If future measurements justify demand-paged replicas, write a separate plan
  with explicit offline, editing, search, link, and conflict semantics. Do not
  gradually turn this preview into an undocumented partial replica.
- A future native client should reuse the bootstrap reducer/effect contract,
  but platform presentation remains outside ArborWire and ArborReplica.
