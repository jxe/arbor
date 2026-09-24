# The update machine and its runner

This guide describes the reference implementation, not additional portable requirements.

Every working tree runs one machine, specified in
[working-tree updates](../overstory-spec/09-client-synchronization.md). Its
sources append **local changes** to a durable **change log**; the machine
decides when and how the log is published; the **runner** performs what the
machine decides. An editor generation, a structural action, a review
resolution, and (after [Clients 001](../../plans/clients/001-reconcile-client-state-machines.md)
phase 4) a folder scan are all local changes. The Canopy app's
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
| `persistRequest(base, tip, extends)` | Cut `ChangeLog.request(through: tip)`: the chain from the oldest unsettled change's accepted basis through the tip, settled changes repeated without objects. Persist it as the immutable `UpdateAttempt`, then dispatch `requestPersisted`. An `extends` whose digests are not a prefix is retried exactly instead. |
| `submit(request)` | Send the persisted body; validate every result digest and tree; read the host's current head (from the response when it carries one, otherwise a descriptor); dispatch `accepted` with that head. |
| `apply(result)` | Install the host's current state (the reconciliation replayed onto the change's candidate when it is exactly that state, otherwise the sparse spine walked from the current root, otherwise a snapshot), mark the request's changes settled, compact the log, tell the machine the next tip, dispatch `applied(installed:)`. Without a stashed response (watch evidence, restart) it replays the exact request first. |
| `catchUp(cursor)` | Replay the watch batch that cursor names when it chains from the installed state, otherwise install the host's current state; dispatch `applied(installed:)`. |
| `settle(tip)` | Mark the chain through `tip` settled without a request. |
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
- a **transport**: `WireClient`'s `submitUpdates` and `descriptor`, and
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
last held and that basis. A clean earlier `sync/<tree>.json` is removed on
first open; one with pending work or a conflict is refused.

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
- **`sync/update-control.json`** (`UpdateControl`, schema 4): the exact
  `UpdateAttempt` and the change it ends at, the held reason, the settled
  changes the log has not yet compacted, and the accepted unresolved signal.
  The accepted `{ root, update, cursor }` is the working tree's own state.
  Every write appends a line to `sync/events.jsonl`.
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

**Watching.** `CanopyWatchRunner` (`OverstoryClient`) follows one tree's watch
stream, feeds every event to the coordinator, reconnects with backoff, and
recovers an expired cursor through `recoverWatchGap`. iOS, the Mac, and visits
share it. A watch frame under a transport failure is evidence that transport
works and retries at once.

**Structural gating.** Structural actions, imports and assets are available
only when unsettled changes form one chain from the installed accepted graph;
otherwise they report `awaitingCanopyReconciliation`. Provider capabilities
advertise that restriction; the coordinator enforces it. Local Trash nodes and
locally held file objects are private recovery material in the same structural
record, excluded from Overstory candidates.

## Reference timing

The reference publication delays are 250 ms after the latest local change and
1 s from the first unsent change. The app polls every 30 s, which catches a
clean tree up and retries a transport failure while the network is believed
available. These are configurable per client and are not Overstory
compatibility values; changing them requires request-count evidence and
matching test updates.
