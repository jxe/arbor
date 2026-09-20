# Native editor durability and recovery

Native Mac editor changes go from Quagmire through the in-memory working tree
and native update coordinator directly to Canopy. Arbor Sync bootstraps that
working tree and supplies objects; it later materializes accepted Canopy changes
into the placed folder. Its filesystem journal is therefore not a backup of
unsubmitted native editor text.

## Local protection

Before a committed editor generation enters the admission debounce, Arbor saves
its exact source and its exact accepted base in a private device-local recovery
store. Sources are SHA-256 addressed and verified on read. Immutable revision
records retain the tree, stable identity, logical path, time and base revision.
Writes synchronize the file and atomically publish it, then synchronize the
containing directory. The store does not depend on the network or Arbor Sync.

The application injects `Application Support/Arbor/EditorRecovery` as the store
root (currently `~/.arbor/EditorRecovery` on this Mac through the support-directory
symlink). Each document gets an identity-hashed directory: stable keys follow
moves within a tree, while identical keys in separate trees remain separate.
`*.json` records reference exact UTF-8 `sources/*.md` objects. A `*.saved` marker
records local provider acknowledgment, not server acceptance. Neither markers
nor later versions delete older source objects. Local History lists these editor
copies and restores a selected copy as a new ordinary edit.

Reopening an unacknowledged draft restores it into the editor. If its accepted
base still matches, normal admission retries it. If the current page changed,
Arbor keeps the recovered text and exposes the existing edit-conflict review,
with the original base and both alternatives. A recovery-store read failure
prevents silently opening a clean editor over unreadable recovery evidence.
Checkpoint write failures remain visible independently of provider save success.

The provider now waits for the native coordinator's head and required object
bytes to reach disk before acknowledging a document admission. A failed write
remains retryable through `flush`; matching in-memory bytes alone cannot turn
that failure into a successful save. Source and patch admissions share this
boundary. Publication remains asynchronous and never requires a network round
trip to acknowledge local durability. Head persistence commits its in-memory
control only after its disk write succeeds, so retry cannot skip a failed write.

The Mac, like iOS, monitors transport availability. Reconnection retries pending
native synchronization and failed editor saves. Lifecycle flush also captures
edits whose editor commit callback has not fired. Admission acknowledgments
capture such an edit as a successor before reconciling an older result.

## Diagnostic evidence and limits

Each document's `events.jsonl` records admission phase changes, generation, draft
ID and time. Each working tree's `sync/events.jsonl` records persisted sync state,
head, generation, request digest, candidate and accepted roots, and conflict/hold
flags. These streams omit authored source and credentials; source recovery is
kept separately with private permissions. Successful saves do not erase evidence.
There is currently no automatic pruning; storage grows with edited source
versions and diagnostic events.

Recovery checkpoints begin at the editor commit callback; a crash before that
callback and before lifecycle flush can still lose the final uncommitted input.
Disk failure can prevent both primary persistence and recovery, and must remain
visible. Local recovery is device-local history, not Canopy's accepted history.

The September 16 report involved edits written offline and visible for hours,
then absent after a Mac restart. Local recovery journals, retained server objects
and available local backup evidence did not identify the reported grocery list;
no local Time Machine snapshots existed. The missing reconnection monitor,
unawaited head handoff and ignored persistence failures are verified code gaps,
not proof of the precise historical failure sequence. Private evidence remains
outside the repository under Joe's Arbor Recovery directory.

## Verification

`EditorRecoveryTests` covers interruption before debounce, continued editing after
failure, restart and conflict review, acknowledged history retention and restore,
exact bytes and tree/stable-key isolation, checkpoint failure, lifecycle capture,
and a keystroke racing an earlier admission acknowledgment.

`UpdateCoordinatorTests` covers failed head writes with retry, source-admission
durability, offline coalescing/reconnection, and Mac in-memory restart recovery.
The [native progress investigation](native-sync-progress.md) tracks the remaining
live automatic-publication checks. Rebuild the app and test a disposable page:
edit offline, reconnect without Sync Now, verify server/peer convergence, then
verify the page's local History survives reopening. Preserve real user text
before intentionally testing process interruption.

Automated verification for this change: all 47 CanopyEditor tests and all 62
CanopyWorkingTree tests pass; the protocol gate passes; the macOS app/test target
build and iOS Simulator app build pass. The repository-wide relative-link check
finds no new broken references (24 pre-existing), and `git diff --check` passes.
The running user app was not replaced or restarted. Live offline/reconnect
verification remains with the user after rebuilding.
