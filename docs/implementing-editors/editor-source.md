# Editors as sources of local changes

This guide describes the reference implementation, not additional portable
requirements. The portable rules are in
[working-tree updates §4](../overstory-spec/09-client-synchronization.md#4-local-changes-from-editors).

There is no state machine between an editor and its working tree. An editor
is a **source**: it appends each generation it commits to its document
session, the session's working tree retains it durably in its
[change log](../implementing-sync-services/update-machine.md#durable-state),
and the generation is acknowledged once that append returns. The working
tree's [update machine](../implementing-sync-services/update-machine.md)
publishes the change log later; the editor never waits for the host.

The reference implementation is `EditorSource` (`CanopyAppKit`, provider
agnostic) with `CanopyDocumentBinding` (`CanopyEditor`) as its Quagmire
plumbing. No TypeScript editor source exists yet; Web 025 adds one.

## 1. Three clocks

- **Editor history** may keep every movement. Undo grouping and the typing
  checkpoint are the editor's own clocks (Quagmire commits a typing run after
  750 ms of inactivity) and are independent of publication timing.
- **Durable local changes** are what the change log holds. Each committed
  generation is appended at once; there is no second debounce.
- **Accepted host history** is produced later by the update machine, which
  coalesces a burst of changes behind its own publication delay.

A rapid sequence of 15 Option-arrow moves retains each committed generation
locally (generations committed during an append travel together). After idle,
repeated pure moves of the same span publish as one move in one authored update.
Editor undo grouping remains independent.

## 2. The source

`EditorSource` holds the **basis**, the latest durable snapshot the next
change is authored against, and the generations captured since.

- **Appends are serialized.** The first generation is appended at once.
  Generations captured while an append is in flight wait, then go out
  together as one change with one frame per generation, each restated against
  the basis the previous append returned. Nothing is re-derived against an
  older basis. A chain whose patches no longer replay exactly becomes one
  exact replacement.
- **An append is durability.** When it returns, the basis becomes the
  snapshot it returned: for a working-tree session, the change's candidate
  view of the document, so later reads see the editor's own writes.
- **A failed append keeps its generations** in memory and reports the
  failure; later generations wait behind it rather than racing past. `retry()`
  sends them again against the same basis. The UI must not say saved.
- **Adoption waits.** A newer accepted snapshot becomes the basis only when
  nothing is captured or in flight.
- **An append in flight completes** even if the editor is dropped.

## 3. Host responsibilities

The Quagmire binding does what only the editor can:

- **Capture exactly.** Each generation's patch is captured against the
  previous generation's ledger, so it states what the editor did, including
  lineage and explicit copies; the source restates it against its basis.
- **Capture the selected identity.** Quagmire exposes the blocks actually moved
  during the synchronous commit callback, including moved descendants. The binding
  passes that evidence into the codec so moving A down is described as moving A,
  rather than inferring that its neighbors moved up. The codec falls back to an
  order comparison only when explicit movement evidence is unavailable.
- **Move, don't retype.** A generation that only rearranges blocks (a reorder,
  a drag, an indent or outdent, a move under another parent) is captured as
  moves of each relocated block's exact source, beside a block that stays or
  an earlier move, plus edits to the leading spaces of lines whose depth
  changed. A peer's concurrent edit to a moved block then follows it. The
  result must reparse to the editor's tree; anything else (new or edited
  blocks, tab indentation) is an ordinary edit. `source-moves.json` gives the
  exact meaning shared with canopyd.
- **Move to Document is one change.** Moving blocks to another page of the same
  tree appends one record over both pages: the blocks' recorded source leaves
  one and lands after the other's last block, re-indented to its top level,
  with a blank line added where one would run into another. Its basis is the
  one retained tree holding both pages as the editor read them, decided from
  record ancestry. When the two pages' local work sits on different chains,
  the editor publishes it, adopts the byte-identical accepted view and tries
  again. If one transfer cannot represent the selection, both pages stay
  unchanged and the editor reports the failure. A separate copy and deletion
  can conflict with each other and must not substitute for a same-tree move.
  Destination validation folds appended blocks under existing headings, including
  a newly created page’s title. Until the editor removes the moved blocks, no
  capture of the origin is taken.
- **Guard uncommitted input.** Quagmire can hold a keystroke before its commit
  callback fires. `flush()` captures it first; an acknowledgement that finds
  the mounted tree ahead of the latest capture appends it as a successor
  before reconciling; a live update never replaces it.
- **Acknowledge without reparsing.** When the acknowledged source is the tree
  already mounted, only the ledger's revision advances, so focus, selection,
  typing and undo coalescing are undisturbed. A transformed result, or a
  host-authored replacement, is rebased into the editor preserving block IDs.
- **Re-read under an anchor.** A live update only signals a change. The
  binding re-reads through the session, and discards the result if an append
  or a capture happened meanwhile.
- **Host-authored replacements** (a structured frontmatter form) show in the
  editor at once and are appended like any other generation.
- **Lifecycle.** Navigation, focus loss, backgrounding, eviction and close
  call `flush()` and surface failure. A browser has no reliable synchronous
  drain on unload, so a web host must keep pending state visible instead of
  claiming it durable.

## 4. Recovery

The change log is the only recovery record. A working-tree session serves a
document's newest unsettled change, so an editor reopened after a crash or a
relaunch shows every appended generation exactly as it was left, and later
edits continue the same chain. What can still be lost is input Quagmire had
not committed when the process stopped.

## 5. Sessions without a change log

In-memory providers and the disk editors of
[Filesystem 024](../../plans/filesystem/024-disk-editors-for-non-tree-folders.md)
accept a guarded write instead of a change. A stale revision is an append
failure like any other: the edit stays in the editor and is reported. The
editor never merges locally and never treats equal bytes as acknowledgement.

## 6. Change invariants and trace compaction

These rules hold for every change a source appends and are checked by
`docs/overstory-spec/conformance/source-admission-queue.json`:

- Root equality never chooses which parent an author meant. A candidate graph
  must equal its child's basis; matching bytes are not lineage.
- A retried suffix repeats the original accepted prefix. It never rebases onto
  a visible peer state, and a client never rebases a successor locally to
  bypass the host's guard; that is the host's decision.
- The first save of an empty directory body creates an explicit snapshot. A
  client never invents an empty file hash to use as source material.
- Source edits against an accepted basis may ship the edited file as an object
  delta when that is smaller. Chained authored changes always send the whole
  file, because the host resolves delta bases against the accepted base root
  before the request's own objects are stored.

<a id="trace-compaction"></a>
**Trace compaction.** A change normally carries one frame per editor
generation. Adjacent plain frames compact: every operation must be a
lineage-free `editSource` over `basis` material with a range, the generations
compose per path through `composeSourceEdits`, the composed operations are
keyed `edit-<k>-<i>` in output order, and a run that returns to its starting
root yields no frame. Frames carrying lineage, copies, moves or operation
material name the generation they were captured against and are not merged by
this admission-time plain-edit compactor. Publication-time composition below is
separate. A trace
that would exceed the protocol's 64 frames or 1024 operations is dropped to
`trace: null`; exact bytes stay authoritative. The same rule runs in the
host's `composeFrames`, which proves a composition by executing it.

## 7. Publication batching and preparation costs

The update machine publishes the furthest contiguous pending successor of the
oldest unsettled change. A sibling or independent accepted basis starts
another request. The shared reference cases are in
`tests/fixtures/source-publication.json`. The runner persists the exact
request before sending it; new changes cannot extend an uncertain in-flight
attempt except through the ambiguous-recovery transition. Retrying repeats its
original body and change identities.

Before freezing the request, both runners compile eligible contiguous local
records into one publication with a fresh change ID and unique operation keys.
Mixed edits, copies and moves retain their frames. Repeated pure moves of the same
unchanged original span collapse to one original-source move at the final anchor.
The final bytes are checked, and original operation-result names map to the
published result. Snapshots, resolutions and guarded changes remain boundaries; large generic
traces split at the protocol limits. The originals remain durable for recovery.

Publication mappings and the exact body are persisted together. Later descendants
use the mapped identities; acceptance and discard account for all covered local
records. A successor waits for idle, including after an earlier request succeeds.
Idle already elapsed during submission does not incur another wait. Explicit sync
can force publication, but watch events and polls do not interrupt a move burst.

Accepted ancestry remains in a batch to preserve attribution, but its objects
and deltas are omitted. canopyd uses the credential-bound receipt to avoid
reconstructing deltas for that already-accepted prefix. New suffix elements
still undergo normal validation and reconciliation.

For plain source generations, the change log composes the edits before
building intermediate trees. It validates each original generation, including
UTF-8 boundaries, and preserves the original capture digest. Copies and
lineage retain their generation frames.

The merger reuses an already-validated matching base/current state and avoids
copying the authored graph when no resolution removes decisions. Local synthetic
measurements on 2026-09-21 showed 60 plain generations over a 30 KB document
preparing in 20 ms instead of 918 ms, with the same candidate, digest, and trace.
A conflicted tree with 40 history steps and 500 sibling files evaluated in
87 ms instead of 110 ms, with identical result, authored state, decisions, and
evidence. These measurements do not predict production latency.

### Repeated movement on the main thread

Source capture validates the rearranged Markdown before queuing its durable append.
Its ledger caches context-free block parses by exact UTF-8 bytes. Each move still
scans block boundaries, rebuilds indentation and heading nesting, checks the tree's
shape, and verifies the patch against the exact source. Unchanged inline Markdown
can reuse its parse; changed bytes must parse again. Ordinary captures carry the
last validated cache without adding entries, so typing does not make the next move
reparse every unchanged block. A fresh parse refreshes the cache to contain only
the new source's leaves; it does not accumulate earlier document versions.
Incoming accepted replacements, transformed acknowledgements and structured source
replacements use the same cache before their existing BlockID reconciliation.
Initial opens and Move to Document still start with a fresh parse. macOS continues
to determine keyboard repeat timing.

A local debug benchmark on 2026-09-29 moved one paragraph 20 times through pages
of 50, 200 and 500 paragraphs containing bold text and links. Mean synchronous
transaction plus capture cost fell from 5.9/24.0/60.0 ms per move to
1.2/4.4/11.2 ms. This excludes SwiftUI rendering and durable append work; it is
not a measurement of installed-app key-to-screen latency. Reproduce with
`CANOPY_MEASURE_MOVES=1 swift/scripts/test-canopy-editor-local.sh --filter measureMovePipeline`.

The follow-up diagnostic (`CANOPY_MEASURE_MOVES=1
swift/scripts/test-canopy-editor-local.sh --filter measureCacheReuse`) compares
cold and cached parsing in one run over a 500-paragraph page. Mean capture cost
for the first move after an edit was 60.0 ms cold and 11.0 ms cached; parsing a
replacement with one added paragraph was 53.4 ms cold and 7.9 ms cached. Replacement
timings exclude BlockID reconciliation, UI rendering and durability. Cache tests
compare full trees, exact source, patches and ledger ranges with a fresh parse,
including changed block boundaries, indentation, fences, frontmatter and Unicode.
