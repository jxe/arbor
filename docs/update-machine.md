# The update machine and its coordinator

The update machine runs inside every working tree against an Overstory host:
the daemon's folder synchronizer and the Canopy app's `CanopyWorkingTree`
both run it. Its states and transitions are specified in
[working-tree updates](../spec/09-client-synchronization.md); this document
describes its runner, the update coordinator, and what the coordinator adds
around the reducer: the durable head, recovery, and watching. The editor-side
machine above it is [the document admission machine](canopy/document-admission.md).


The update machine is the pure reducer `UpdateMachine` (`CanopyWorkingTree`)
and `reduceUpdate` (`@overstory/client`). Both execute the `working-tree-updates` scenarios in
[`spec/conformance/client-state-machines.json`](../spec/conformance/client-state-machines.json).
Its transitions are the spec's; this section is about the runner around it.

`UpdateCoordinator` (Swift) runs the reducer over a `WorkingTree` and an Overstory
transport and keeps `UpdateControl` (`sync/update-control.json` under the tree's
state root, schema 3 for source admission and schema 2 for snapshot publication). The control retains:

- **The durable head** `UpdateHead { base, root, generation, objects }`,
  written by `syncImmediately` before the reducer sees `localHead`. Its
  objects are the tree's own bytes (inline state plus overlay) the base does
  not retain; above roughly 32 MiB they spill to `sync/objects/<hash>` and are
  referenced by hash. The head is cleared when an attempt supersedes it or the
  tree returns to current.
- **The attempt** `UpdateAttempt`: one exact request body with every envelope
  it carries and its element digests. The transport is handed
  the body and nothing else. Overlay collection between prepare and resend
  therefore cannot change a resubmission; a test wipes the overlay and asserts
  byte-identical bodies.
- **The next base** for pending snapshot publication, source-journal publication
  identity and receipts, and the accepted unresolved signal. Conflicts and holds
  are not current control fields.

**Sparse bodies.** A candidate's objects are the local graph (validated as a
sparse spine) minus every hash reachable from the base through directory
objects; file hashes are collected from directory entries without fetching
files. The immediate-delta fast path reads the base file through the object
store and falls back to the full object on a miss. Reconciliation and
watch-transition replay run on a sparse basis: the local graph plus every
delta base, fetched once each, replayed in `.sparseFiles` mode and bridged
back with the tree's own file metadata.

**Recovery.** On entry, a retained attempt maps to `prepared`, and a head with no attempt becomes a one-element
attempt (its objects make it self-contained) and also maps to `prepared`.
When an accepted result arrives for a candidate the tree no longer holds and
the tree has no pending work (it was re-seeded from canopyd while the durable
record carried the work), the coordinator applies the decision, clears the
attempt and next base, and pulls the current snapshot; it never re-submits
the seed.

**Rejected requests and old records.** A rejected submission keeps its exact
attempt for retry and reports the error. It never creates a conflict workspace,
changes the authored basis, or submits an implicit resolution. Before decoding a
control file, the loader rejects any non-null legacy `conflict` or `hold` field,
even an unfamiliar payload, without rewriting the file. Historical backups and
the previous client provide recovery for unexpected old work.

**Watching.** `CanopyWatchRunner` (`OverstoryClient`) follows one tree's watch
stream, feeds every event to the coordinator, reconnects with backoff, and
recovers an expired cursor through `recoverWatchGap`. iOS, the Mac, and
visits share it.

Native's source-enabled provider routes structural actions, imports and assets
through the same coordinator-owned admission journal as document edits. It stages
an action against an immutable candidate, retains the snapshot before returning,
and supplies pending candidate views for navigation and document sessions. These
snapshot records preserve explicit predecessor identity alongside source-operation
records. Local Trash nodes and locally held file objects are private recovery
material in the same structural record, excluded from Overstory candidates. Publication
and watch still install only canopyd's accepted projection into the accepted tree.
Native always enables source admission. Its constructor refuses old pending
snapshot work rather than selecting a legacy conflict workflow, and source journals
cannot downgrade to snapshot mode. Clean older controls can activate source mode.
Local filesystem document CAS and
divergent editor-recovery drafts remain separate from accepted canopyd conflicts.

For source-enabled Native, structural admission is available only when pending
records form one predecessor chain whose starting graph matches the installed
accepted graph. This comparison is a local display/action policy, not a change to
any authored identity or publication basis. Source and structural retention share
one serialization tail so a structural capture cannot race an arriving branch.

If the queue branches, navigation retains the pending structural candidate and its
contiguous successors; if that prefix has settled, navigation uses the installed
accepted projection. Individual document sessions keep their own retained source
generations. Structural actions, imports and assets report
`awaitingCanopyReconciliation` before preparing more work. Provider capabilities
advertise that restriction; the coordinator enforces it independently of UI state.
Publication continues and the restriction is recomputed as canopyd accepts work.
The queue and accepted-change receipts reconstruct this policy after restart;
there is no separate view cache, local merge engine or client-owned conflict.
