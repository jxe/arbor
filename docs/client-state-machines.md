# Client state machines: document admission and working-tree updates

Two state machines sit between an editor and accepted canopyd history. The
**document admission machine** runs between an editor's undo history and its
working tree's document session; this document is its reference: its states,
the data each retains, its transitions, and the rules a new editor host must
follow. The
**update machine** runs inside a working tree against Overstory and is
specified in [working-tree updates](../spec/09-client-synchronization.md);
section 8 below describes its runner, the update coordinator, and what it
adds around the reducer: the durable head, recovery, and watching.

The reference implementations are `DocumentAdmissionMachine` in `CanopyAppKit`
(Swift) and `reduceAdmission` in `@overstory/protocol` (TypeScript). Both are pure
reducers that execute every `document-admission` scenario in
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json);
the editor host (`ArborDocumentBinding` today; the Plan B web editor later)
runs the effects.

The target admission policy is [exact authored basis](../spec/09-client-synchronization.md#exact-authored-basis).
Both reducers capture base source and revision in each admission effect. The
durable source admission queue (`SourceAdmissionQueue` in `CanopyWorkingTree`
and `@overstory/client`; journals described in [the local system](local-system.md#source-admission-journals))
retains tree bases and explicit dependencies. Installed Canopy clients use it;
the TypeScript session and publisher are library APIs not yet connected to an
editor host. The `conflict` phase and `mergeLocally` effect below are legacy
compatibility behavior, not the target policy for concurrent host edits.

## 1. Three layers, three clocks

- **Local editor history** may keep every movement. Undo grouping is the
  editor's own clock (the web editor groups at 750 ms) and never influences
  what is sent.
- **Locally durable authored intent** is what the working tree holds once an
  admission succeeds. The machine coalesces a burst of edits into one
  admission behind a trailing 250 ms debounce, and never has two admissions
  in flight for one document session.
- **Accepted canopyd history** is produced later by the update machine, which
  publishes the working tree's durable heads. Admission is complete when the
  working tree holds the bytes; the editor does not wait for canopyd.

A rapid sequence of 15 Option-arrow moves is therefore 15 undo entries, one
admission, and normally one accepted canopyd update.

Swift document sessions expose an admission policy. The source-enabled working-tree
session uses `retainedBasis`: it durably queues exact intent before acknowledgement,
and recovered drafts retain their original basis and patch without local review.
The default `compareAndSwap` policy preserves legacy provider behavior during the
transition. This is a local provider contract, not canopyd operation advertisement.

## 2. States and retained data

Every state carries the accepted `{ source, revision }` and the monotonic
editor `generation`. There is one transport: the working tree's document
session.

| State | Retained data | Meaning |
|---|---|---|
| `clean` | accepted source/revision | No authored generation is newer than the locally durable acknowledgement. |
| `dirty` | latest source and generation; a timer is armed | Edits are coalescing; no request contains them yet. |
| `submitting` | the immutable submitted source/generation | Exactly one admission is in flight. |
| `submitting-dirty` | the immutable submission plus one replaceable latest source | Edits arrived during the request; they are one successor, not another request. |
| `conflict` | the submitted source, the current observation when known, any newer local source | The working tree rejected admission; nothing is discarded. |
| `failed` | the exact pending source and an error classification, any newer source | Transport or provider failure; the UI must not say saved. |
| `closed` | nothing | Terminal after a drain or an explicit failed close. |

`dirty`, `submitting`, `submitting-dirty`, `failed`, and `conflict` are
"dirty" for lifecycle purposes: a navigation guard must drain them.
`dirty`, `submitting`, and `submitting-dirty` are "unsettled": `flush`
waits until none of them remains.

## 3. Events and effects

Events: `edit(source)`, `debounceElapsed`, `flush`, `admitted(generation,
result)`, `admissionConflicted(generation, current?)`,
`admissionFailed(generation, error)`, `observed(observation, anchor?)`,
`retry`, `resolveConflict(use-current | keep-submitted)`, `close`.

Effects the host runs: `schedule(delay)`, `cancelTimer`, `admit(generation,
source, baseRevision, baseSource)`, `acknowledge(result)`, `apply(source, revision)`,
`mergeLocally(current?, submitted, base)`, `surfaceFailure(error)`, `stop`.

Both reducers accept an admission policy. The legacy/default compare-and-swap
policy retains the conflict transition below. A `retained-basis` session instead
turns an unexpected `admissionConflicted` into `failed` plus `surfaceFailure`,
retaining its exact accepted basis, pending generation and successor. It never
emits `mergeLocally` or treats equal peer bytes as proof of durable admission.
The Native bridge captures this policy from the session at open, including draft
recovery. The shared fixture covers both languages; the live protocol test drives
Quagmire through the real session/coordinator and disposable canopyd.

```text
clean ──edit──▶ dirty ──debounceElapsed/flush──▶ submitting ──admitted──▶ clean (acknowledge)
  ▲               │                                 │  ▲
  │               └──edit (resets timer)            │  └── admitted with a retained successor:
  │                                          edit   │      acknowledge, then admit
  │                                                 ▼
  │                                        submitting-dirty
  │                                                 │
  └──────── observed (newer revision): apply ◀──────┤
                                                    ├──admissionConflicted──▶ conflict ──resolveConflict──▶ clean | submitting
                                                    └──admissionFailed─────▶ failed ────retry/flush──────▶ submitting
```

## 4. Transition rules

1. **`edit` never performs I/O.** It increments the generation, replaces the
   latest source, and arms the trailing debounce (from `clean` or `dirty`).
   During a request it only replaces the successor. In `conflict` or `failed` it is retained as the newer local
   source.
2. **One admission in flight, one successor.** `debounceElapsed` or `flush`
   moves `dirty` to `submitting`. Edits during the request accumulate into one
   successor; when the request succeeds the machine acknowledges it and
   immediately admits the successor against the returned revision.
3. **Empty change is a local success.** If the latest source equals the
   accepted source when a request would start, the machine returns to `clean`
   without a request.
4. **Admission is durability.** A successful admission returns to `clean`
   at the admitted revision. The working tree is the editor's authority:
   read-your-writes holds, so an observation of an older accepted prefix
   never replaces a newer admitted generation (the host reads through the
   session and the revision matches).
5. **Stale reads are discarded.** A host captures `anchor = { generation,
   revision }` before an asynchronous read and passes it with `observed`. If
   either moved, the observation is ignored. Hosts must also hold an
   uncommitted keystroke themselves: the machine has no generation for it.
6. **External change under coalescing intent** (`observed` while `dirty`)
   cancels the timer and admits now, so the authority, not the editor,
   reconciles.
7. **Legacy compatibility: a rejected admission emits `mergeLocally`.** The working tree rejected
   the write at its base revision; the host may run its explicit merge
   helper or surface the retained conflict for review (Canopy surfaces
   it). Accepted canopyd conflicts are accepted-state data, not an admission failure
   or a publication hold. Native has retired the old rejected-update path; unexpected retained legacy records fail safely for recovery.
8. **Failures keep the exact pending source.** `retry` or `flush` resubmits
   the newest retained source; the UI shows failure until then.
9. **Lifecycle.** `flush` cancels the timer, starts the latest admission,
   awaits it, and submits one coalesced successor if edits arrived
   meanwhile. Navigation, focus loss, backgrounding, eviction, and close call
   `flush` and surface failure. Disposal never starts an unobservable save:
   the web coordinator drains the machine before closing and exposes its
   state until then; browsers have no reliable synchronous drain on unload,
   so pending state stays visible instead of being claimed durable.

## 5. Host responsibilities

- Serialize the editor tree to the exact source the machine will submit, and
  compute the guarded UTF-8 patch from the last acknowledged exact source.
- Capture base source and revision from the `admit` effect, never from mutable
  reducer state when an asynchronous callback resumes. Validate that the patch
  applied to this captured source produces the candidate exactly.
- Run `admit` through the session's declared admission policy. A retained-basis
  session durably binds the original intent and classifies success as `admitted`;
  a stale/CAS response is `admissionFailed`, never local conflict review. During
  compatibility, compare-and-swap providers retain their guarded-write and
  `admissionConflicted` behavior, including exact-source race handling. Equal
  projected bytes do not prove acceptance for a retained-basis session.
- On `acknowledge`, advance source authority without reparsing when the
  acknowledged source is the tree already mounted; rebase the editor only when
  the provider returned a transformation.
- On `apply`, replace the editor with authoritative content while preserving
  selection where the codec allows.
- Feed the same `observed` event from working-tree notifications and from the
  session's read-your-writes snapshot; the reducer decides.

## 6. Where the machines meet

An editor runs the admission machine against its own working tree: admission
is working-tree durability, and the working tree's update machine (spec
[working-tree updates §2](../spec/09-client-synchronization.md#2-the-update-machine))
publishes durable heads behind a trailing delay and materializes only accepted
state. Arbor Sync admits no editor generations; its folder is always a
source (the reducers have no filesystem role), and every daemon request is
one filesystem head. A native or future browser client starts from a sparse
snapshot rooted at canopyd's accepted root and owns its own later heads and
requests. The daemon's mutable folder head, pending request, conflict, and
availability state neither seed nor block that client. Clients using the same
credential still converge through ordinary canopyd request reconciliation and
watch evidence; they do not share a local state machine.

The prefix rule applies to filesystem-authored work that moves during a
request. If canopyd merged the transmitted candidate while newer local bytes
were already durable, Arbor Sync must not turn those bytes into a fresh request
against the original stale base. It persists a longer request containing the
exact transmitted prefix plus the latest successor once. canopyd deduplicates
the prefix by request digest and reconciles only the successor transition. If
that transition conflicts, Arbor Sync retains Base, Current, Mine, and Draft
immediately because its base may be a submitted candidate rather than a
snapshot-addressable accepted root.

Every editor runs both: admission into its working tree first, publication by
the update machine second. Do not combine them or skip local durability.

When a plural Overstory update string stops at a conflict, the update machine does
not turn the complete final local root into one replacement request. The
successful prefix is already authority history, the element at `failedIndex`
is the only element under review, and the suffix has not yet been attempted.
The thick client retains those boundaries across restart, submits the reviewed
failed element first, and then replays the exact later local changes in order.
Most conflicts therefore produce one content review; another review appears
only if a later guarded replay or canopyd submission independently conflicts.

## 7. Conflict review for Arbor Sync clients

Treat tree status and review evidence as separate facts. `sync: "conflict"`
means automatic synchronization stopped; it does not authorize a choice.
Fetch `/v1/conflicts?tree=...` and offer resolution only after that request
returns the durable, identity-fenced Base, Current, Mine, and canopyd Draft
values. A missing or unavailable workspace is an error state, never an empty
conflict and never permission to keep local or remote implicitly.

The UI may present Current, Mine, `Both` when `offersBoth` is true, and Edit
when at least one returned value is textual. It submits those semantic choices
and the opaque workspace identity to Arbor Sync. The daemon owns graph
replacement, validates every resulting object hash, rechecks both the remote
accepted update and local candidate, and durably records the reviewed result
before clearing the conflict. On a stale-identity response, discard the open
review and fetch it again.

Persist review material before depending on it for recovery. A restart must
not turn remembered status into fabricated evidence, and losing connectivity
after the first successful review fetch must not make the four graphs vanish.
If `unattemptedCount` is nonzero, keep the suffix untouched and disable submit;
the failed element and later update-string elements are distinct authored
history boundaries.

## 8. The update machine and its coordinator

The update machine is the pure reducer `UpdateMachine` (`CanopyWorkingTree`)
and `reduceUpdate` (`@overstory/client`). Both execute the `working-tree-updates` scenarios in
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json).
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

## 9. Admission invariants and trace compaction

These rules hold in both queues and are checked by
`conformance/source-admission-queue.json`:

- Root equality never chooses which parent an author meant. A candidate graph
  must equal its child's basis; matching bytes are not lineage.
- A retried suffix repeats the original accepted prefix. It never rebases onto
  a visible peer state, and a client never rebases a successor locally to
  bypass the host's guard; that is the host's decision.
- The first save of an empty directory body creates an explicit snapshot. A
  client never invents an empty file hash to use as source material.
- Source edits against an accepted basis may ship the edited file as an object
  delta when that is smaller. Chained authored records always send the whole
  file, because the host resolves delta bases against the accepted base root
  before the request's own objects are stored.

<a id="trace-compaction"></a>
**Trace compaction.** A debounced burst is one admission and normally one
frame per editor generation. Adjacent plain frames compact: every operation
must be a lineage-free `editSource` over `basis` material with a range, the
generations compose per path through `composeSourceEdits`, the composed
operations are keyed `edit-<k>-<i>` in output order, and a run that returns to
its starting root yields no frame. Frames carrying lineage, copies, or
operation material name the generation they were captured against and are
never merged. A trace that would exceed the protocol's 64 frames or 1024
operations is dropped to `trace: null`; exact bytes stay authoritative. The
same rule runs in the host's `composeFrames`, which proves a composition by
executing it.
