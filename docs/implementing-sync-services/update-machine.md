# The update machine and its runner

This guide describes the reference implementation, not additional portable requirements.

Every working tree runs one machine, specified in
[working-tree updates](../overstory-spec/09-client-synchronization.md). Its
sources append **local changes** to a durable **change log**; the machine
decides when and how the log is published; the **runner** performs what the
machine decides. An editor generation, a structural action, a review
resolution, and a folder scan are all local changes. The Canopy app's
`CanopyWorkingTree` runs the Swift runner; Arbor Sync runs the TypeScript
runner in `@overstory/working-tree` once per placed folder (`FolderSync`).
Both pass the same runner vectors.

The machine is the pure reducer `UpdateMachine` (`CanopyWorkingTree`) and
`reduceUpdate` (`@overstory/working-tree`). Both execute the
`working-tree-updates` scenarios in
[`docs/overstory-spec/conformance/client-state-machines.json`](../overstory-spec/conformance/client-state-machines.json).
Both runners execute
[`tests/fixtures/update-runner.json`](../../tests/fixtures/update-runner.json),
implementation vectors that drive a runner over a scripted host and check
what the host received, the change log, and what the editor reads.

## The runner's contract

`UpdateCoordinator` is the runner, in Swift (`CanopyWorkingTree`) and in
TypeScript (`@overstory/working-tree`). Its rule is **the machine decides;
the runner performs**:

- A runner turns I/O results into events and executes every effect it is
  given. It never writes the machine's phase and keeps no flag that
  duplicates a machine rule. State it keeps is what an effect needs to be
  performed: the exact persisted request, the validated response an `apply`
  installs, the watch batch a `catchUp` replays, file handles and caches.
- Effects run strictly in order on one worker, except `submit`, which runs on
  its own task so that a hanging request never blocks its own ambiguous
  extension or a catch-up. `schedule` and `cancelTimers` take effect at once.
- Failures are classified into the machine's events: HTTP 401 or 403 is
  `authenticationFailed`; an `unsupported-operation` response is
  `unsupported`; a 409 conflict or any other 4xx refusal of the request
  except 408 and 429 is `rejected`; a response that fails validation is
  `validationFailed`; anything else (no response, 408, 429, 5xx) is
  `transportFailed`.
- Presentation is derived from the machine's phase and the change log, never
  stored.

Each effect, and what the runners do for it:

| Effect | Runner |
|---|---|
| `persistRequest(base, tip, extends)` | Cut `ChangeLog.request(through: tip)`: the chain from the oldest unsettled change's accepted basis through the tip, settled changes repeated without objects. Compile eligible unsent records into publications, retaining their local-change and operation-result mappings. Persist the mappings and immutable `UpdateAttempt` together, then dispatch `requestPersisted`. An `extends` whose digests are not a prefix is retried exactly instead. |
| `submit(request)` | Send the persisted body in its persisted encoding; validate every result digest and tree; read the host's current head (from the response when it carries one, otherwise a descriptor); dispatch `accepted` with that head. |
| `apply(result)` | Install the host's current state (the reconciliation replayed onto the change's candidate when it is exactly that state, otherwise the sparse spine walked from the current root, otherwise a snapshot), mark all local changes covered by the request's publications settled, compact the log, tell the machine the next tip, dispatch `applied(installed:)`. Without a stashed response (watch evidence, restart) it replays the exact request first, except while that same request's POST is still on the network: then the apply waits for that submission, which supplies the response or, if it fails, leaves the replay to retrieve the stored receipts. A watch that reports a request before its response therefore never causes a second POST. |
| `catchUp(cursor)` | Replay the watch batch that cursor names when it chains from the installed state, otherwise install the host's current state; dispatch `applied(installed:)`. |
| `settle(tip)` | Mark an unchanged snapshot chain through `tip` settled without a request, only when it carries no trace, resolution declaration or accepted-state guard. |
| `stop(reason)` | Record the terminal diagnostic and cancel timers. |

Public operations are events: `syncOnce` dispatches `syncRequested` and waits
for the effects it causes; `observe` dispatches `watch`; `recoverWatchGap`
dispatches `watchGap` (or `syncRequested` under pending work);
`setTransportAvailable` and `credentialsRefreshed` dispatch their events; and
`discardHeldChanges` removes a held request's changes and every change
authored on them from the log, then dispatches `heldDiscarded`.

## The TypeScript runner's ports

`@overstory/working-tree` is browser-safe; `@overstory/working-tree/node` adds
the file-backed `ChangeLog` and `FileControlStore`. The runner takes:

- a **change log** (`ChangeLogPort`): `retained`, `nextPublication`,
  `request`, `compact`, `discard`;
- a **control store** (`ControlStore`): the `UpdateControl` record below;
- a **transport**: `ProtocolClient`'s `submitUpdates` and `descriptor`, and
  `object` or `snapshot` for installs;
- an **accepted tree** (`AcceptedTree`): its installed accepted state, its
  local objects, `install`, and `recordAccepted`.

`install` receives an `AcceptedSource` (objects the runner already holds, then
the tree's own, then the host's, each verified) and whether local changes
remain pending. An editor's tree installs the accepted base and derives its
view from the log; a folder writes accepted bytes to disk only when nothing is
pending and the folder still holds what it last wrote or scanned (spec 09 rule
13). A source appends to the log and then calls `noteLocalChange()`.

**The folder as a source.** `FolderSync` (`packages/arborsync`) is the folder's
accepted tree and its only source. A watcher event schedules a scan through the
stat index; a scan whose root differs from what the folder last held appends a
`trace: null` change whose basis is what the folder held (the accepted state it
was last written with, or its previous change). Folder records are sparse:
directories plus the candidate's new files, and the element carries exactly
the objects its basis lacks. `sync/folder.json` records the root the folder
last held and that basis; without one, a placement whose accepted base was
recorded outside the machine (an account checkout) starts from that base.

## Durable state

Under a tree's state root:

- **`sync/change-log.json`** and **`sync/change-log-objects/`**: the
  `ChangeLog` (schema 4 journal). Each record is one `LocalChange`: its
  authored identity, basis (accepted `{ root, update }` or the authored
  identity of its predecessor), sparse basis graph, sparse candidate, the wire
  element verbatim (`trace` or `null`, `resolves`, objects the basis does not
  retain, or deltas), and a capture summary. Records never retain document
  sources or editor transactions. Appends are fsynced and flock-serialized; a
  corrupt journal fails without being rewritten. A journal written under the
  earlier name `source-admissions.json` is moved in place on first open.
- **`sync/update-control.json`** (`UpdateControl`, schema 5): the exact
  `UpdateAttempt` and the change it ends at, the held reason, the settled
  changes the log has not yet compacted, the accepted unresolved signal, and
  publication groups mapping original change and operation identities to their
  immutable wire representation. Schema-4 controls read with no groups.
  The accepted `{ root, update, cursor }` is the working tree's own state.
  Every write appends a line to `sync/events.jsonl`. An attempt's `body` is
  its exact request bytes and `contentType` their encoding: new attempts are
  CBOR (`application/cbor`), and an attempt without `contentType` is JSON, so
  one written before bodies could be CBOR replays unchanged, as JSON
  ([tree operations §4.4](../overstory-spec/01-tree-operations.md#44-request-and-response-encodings)).
- **`sync/conflict-review.json`** (schema 3): review drafts, and the draft
  fingerprint each submitted resolution change carries.

**Upgrading.** A schema-3 control that still holds a snapshot head, a next
base, or an attempt outside the change log, and a review journal with its own
pending attempt, are refused with `UpdateError.earlierPendingWork` and never
rewritten; open the tree with the earlier build to finish publishing, then
upgrade. A clean earlier control converts.

## Behaviour worth knowing

**Sparse bodies.** A record carries only objects its basis does not retain;
an edit against an accepted file travels as a delta when that is smaller.
Reconciliation replay runs on the change's sparse candidate plus every delta
base, fetched once each through the working tree's object store.

**One chain.** A change authored on a change that is not yet settled names it
as its basis, so the request repeats that prefix exactly (without objects once
it is settled) and appends the new changes once. A change made after its
predecessor settled starts from the new accepted state. Sibling branches (edits to different documents from the
same accepted basis) publish one after another; the host reconciles them.

**Re-seed.** A working tree rebuilt from the host while the durable request
carried the work (a Mac relaunch) replays the exact request, installs the
host's current state, and never re-submits from the seed.

**Held.** A rejected or unsupported request stays durable with its reason and
survives restart; later changes authored on it wait with it. The app offers
"Discard Refused Changes", which is the explicit way out. A review resolution
refused while it is being applied is discarded at once, because its draft is
retained.

**Watching.** `HostWatchRunner` (`OverstoryClient`) follows one tree's watch
stream, feeds every event to the coordinator, reconnects with backoff, and
recovers an expired cursor through `recoverWatchGap`. iOS, the Mac, and visits
share it. A watch frame under a transport failure is evidence that transport
works. An exact retry can proceed immediately; extending an ambiguous
request with active local work waits for idle.

**Structural gating.** Structural actions, imports and assets are available
only when unsettled changes form one chain from the installed accepted graph;
otherwise they report `awaitingHostReconciliation`. Provider capabilities
advertise that restriction; the coordinator enforces it. Local Trash nodes and
locally held file objects are private recovery material in the same structural
record, excluded from Overstory candidates.

## Idle publication and coalescing

Both machines wait for **250 ms of quiet after captured source work has drained**
by default. `sourceActivity(pending:)` holds automatic publication while an editor
has captured generations awaiting admission; a gap between journal appends is
not editor idle. Sessions have separate activity identities, and closing one
releases only its own claim. The last active source draining starts the quiet
period. Durable local changes also reset the timer, including while a request is
in flight or transport is unavailable. Once idle elapses, the successor is ready; acceptance does not add
another wait. Watch traffic and freshness polls do not cut an active burst short.
Explicit synchronization forces publication. Arbor Sync's folder source opts
into a **1 s maximum** so continuously changing files still make progress; the
maximum starts with the first pending change and remains due across submission.
The app polls every 30 s for freshness. These are configurable implementation
values, not protocol compatibility constants.

`ChangePublication.swift` and `publication.ts` compile one contiguous unsent
chain into a fresh authored update. Mixed operation-bearing records retain their
ordered frames with unique operation keys. Repeated pure moves of the same
original span reduce to one move from that original span to its final anchor;
coordinates are transported through the moves, never inferred from equal text.
Snapshots, resolutions and guarded changes are boundaries, and generic batches split at 64 frames
or 1024 operations. Local records and undo history remain intact.

A known local branch point ends a batch. A later editor can still branch from
inside a batch that was already published. The runner can carry that branch
across the remaining batch frames only when both sides contain source operations
whose complete read/write footprints name disjoint existing files. It preserves
the operations and references, adjusts the surrounding tree roots, and records a
fresh deterministic publication identity for each carried change. Original local
records stay intact; retries repeat the frozen batch and continuation identities.
Overlapping files, operation-result references, structural suffixes, resolutions,
and guards are not covered by this proof and remain retained for explicit recovery.
When any batch member is retained, compaction retains the whole batch and its
ancestry. If a carried candidate differs from the original local candidate, the
runner loads the accepted graph instead of applying a reconciliation to the wrong
basis. No host protocol extension is needed for these disjoint branches.

Before freezing the first publication in a new request, both clients compress final reachable object
envelopes against objects at the same paths in the request's original accepted
basis. Rolling-block copy/insert deltas preserve moved bytes without resending
the whole document. The final directories are compressed too. Compression does
not change traces, candidate roots, operation identities, or request digests.
Delta bases never come from an unpublished prefix; intermediate objects needed
by trace frames stay available. Later batch elements retain their envelopes because their preceding candidate
may not yet be retained by the host. Frozen request bodies are never recompressed.

Generic batching retains intermediate object material. A delta survives only
when its result reaches the final candidate; otherwise its intermediate object
is retained. Fewer update elements therefore do not guarantee fewer bytes for
mixed or plain-edit sequences. Eliminating those intermediate versions is the
first follow-up priority.

The compiler persists original-to-published change and operation-result mappings
with the prepared request. A later descendant uses those names, and acceptance
or explicit discard covers every original record represented by the publication.
Prepared or ambiguously transmitted prefixes are immutable, including across
restart. Mapping retention follows the retained local chain. A semantic change
with unchanged final bytes still publishes: equal roots do not prove equal identity.
This includes snapshot resolutions (`trace: null` with `resolves`) and `ifCurrent`
guards. Both clients must send them to canopyd; local byte equality cannot
acknowledge a resolution or evaluate an authority guard.

Shared `coalesced-publication.json` fixtures check the compiler in both languages;
the TypeScript tests also run the real merge engine against concurrent peer edits.
The runner vectors cover exact retries, restart, ambiguous extensions and discard.
Further byte reductions are ordered in [Clients 002](../../plans/merge/002-identity-preserving-coalescing.md),
starting with plain edits across records, then moves with edits and selections.
