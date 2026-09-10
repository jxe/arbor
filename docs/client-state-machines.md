# Client state machines: document admission and working-tree updates

Two state machines sit between an editor and accepted Canopy history. The
**document admission machine** runs between an editor's undo history and its
working tree's document session; this document is its reference: its states,
the data each retains, its transitions, and the rules a new editor host must
follow. The
**update machine** runs inside a working tree against Arbor Wire and is
specified in [working-tree updates](../spec/09-client-synchronization.md);
section 8 below describes its runner, the update coordinator, and what it
adds around the reducer: adoption, the durable head, recovery, holds, and the
adopted-prefix rule.

The reference implementations are `DocumentAdmissionMachine` in `ArborKit`
(Swift) and `reduceAdmission` in `@arbor/core` (TypeScript). Both are pure
reducers that execute every `document-admission` scenario in
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json);
the editor host (`ArborDocumentBinding` today; the Plan B web editor later)
runs the effects.

## 1. Three layers, three clocks

- **Local editor history** may keep every movement. Undo grouping is the
  editor's own clock (the web editor groups at 750 ms) and never influences
  what is sent.
- **Locally durable authored intent** is what the working tree holds once an
  admission succeeds. The machine coalesces a burst of edits into one
  admission behind a trailing 250 ms debounce, and never has two admissions
  in flight for one document session.
- **Accepted Canopy history** is produced later by the update machine, which
  publishes the working tree's durable heads. Admission is complete when the
  working tree holds the bytes; the editor does not wait for Canopy.

A rapid sequence of 15 Option-arrow moves is therefore 15 undo entries, one
admission, and normally one accepted Canopy update.

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
source, baseRevision)`, `acknowledge(result)`, `apply(source, revision)`,
`mergeLocally(current?, submitted, base)`, `surfaceFailure(error)`, `stop`.

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
7. **A rejected admission emits `mergeLocally`.** The working tree rejected
   the write at its base revision; the host may run its explicit merge
   helper or surface the retained conflict for review (native Arbor surfaces
   it). Canopy-side conflicts belong to the update machine, not to admission.
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
- Run `admit` through the session as a guarded write at the accepted revision
  and classify the outcome as `admitted`, `admissionConflicted`, or
  `admissionFailed`. An exact-source race (the provider already holds the
  submitted bytes) is `admitted`.
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
one filesystem head. When the daemon materializes accepted Canopy state it
emits the incorporated request digests with its tree-wide `updated` event,
which a working-tree client under the same credential uses as evidence for a
request it adopted from the daemon.

The prefix rule applies to filesystem-authored work that moves during a
request. If Canopy merged the transmitted candidate while newer local bytes
were already durable, Arbor Sync must not turn those bytes into a fresh request
against the original stale base. It persists a longer request containing the
exact transmitted prefix plus the latest successor once. Canopy deduplicates
the prefix by request digest and reconciles only the successor transition. If
that transition conflicts, Arbor Sync retains Base, Current, Mine, and Draft
immediately because its base may be a submitted candidate rather than a
snapshot-addressable accepted root.

Every editor runs both: admission into its working tree first, publication by
the update machine second. Do not combine them or skip local durability.

When a plural Wire update string stops at a conflict, the update machine does
not turn the complete final local root into one replacement request. The
successful prefix is already authority history, the element at `failedIndex`
is the only element under review, and the suffix has not yet been attempted.
The thick client retains those boundaries across restart, submits the reviewed
failed element first, and then replays the exact later local changes in order.
Most conflicts therefore produce one content review; another review appears
only if a later guarded replay or Canopy submission independently conflicts.

## 7. Conflict review for Arbor Sync clients

Treat tree status and review evidence as separate facts. `sync: "conflict"`
means automatic synchronization stopped; it does not authorize a choice.
Fetch `/v1/conflicts?tree=...` and offer resolution only after that request
returns the durable, identity-fenced Base, Current, Mine, and Canopy Draft
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

The update machine is the pure reducer `UpdateMachine` (`ArborWorkingTree`)
and `reduceUpdate` (`@arbor/canopy-client`, moving to `@arbor/working-tree`
in Plan B). Both execute the `working-tree-updates` scenarios in
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json).
Its transitions are the spec's; this section is about the runner around it.

`UpdateCoordinator` (Swift) runs the reducer over a `WorkingTree` and a Wire
transport and keeps `UpdateControl` (`sync/control.json` under the tree's
state root, schema 2; schema 1 files from placed iOS devices decode with the
new fields absent). The control retains:

- **The durable head** `UpdateHead { base, root, generation, objects }`,
  written by `syncImmediately` before the reducer sees `localHead`. Its
  objects are the tree's own bytes (inline state plus overlay) the base does
  not retain; above roughly 32 MiB they spill to `sync/objects/<hash>` and are
  referenced by hash. The head is cleared when an attempt supersedes it or the
  tree returns to current.
- **The attempt** `UpdateAttempt`: one exact request body with every envelope
  it carries, its element digests, and `adoptedCount`. The transport is handed
  the body and nothing else. Overlay collection between prepare and resend
  therefore cannot change a resubmission; a test wipes the overlay and asserts
  byte-identical bodies.
- **The conflict**, **the next base**, and **the hold**.

**Sparse bodies.** A candidate's objects are the local graph (validated as a
sparse spine) minus every hash reachable from the base through directory
objects; file hashes are collected from directory entries without fetching
files. The immediate-delta fast path reads the base file through the object
store and falls back to the full object on a miss. Reconciliation and
watch-transition replay run on a sparse basis: the local graph plus every
delta base, fetched once each, replayed in `.sparseFiles` mode and bridged
back with the tree's own file metadata.

**Adoption.** `adoptInFlight(base:updates:requestDigests:objects:)` installs
another working tree's persisted request (the daemon's, at a dirty
bootstrap) as the first attempt. It refuses while an attempt or conflict is
retained, packs the supplied envelopes into the elements, recomputes the
digests, and requires them to equal the supplied ones. The machine enters
`prepared`; a later admission is the retained successor, and an offline
admission is appended once by the ordinary reconnection extension.

**Recovery.** On entry, a retained conflict maps to `conflict`, a retained
attempt to `prepared`, and a head with no attempt becomes a one-element
attempt (its objects make it self-contained) and also maps to `prepared`.
When an accepted result arrives for a candidate the tree no longer holds and
the tree has no pending work (it was re-seeded from Canopy while the durable
record carried the work), the coordinator applies the decision, clears the
attempt and next base, and pulls the current snapshot; it never re-submits
the seed.

**Holds.** `setSubmissionHold(_:)` pauses submission: heads and attempts stay
durable, `presentation` reports `conflict` with the reason, and nothing is
sent until the hold is lifted and `syncOnce` runs.

**Adopted-prefix rule.** When a conflict's `failedIndex` lies inside the
adopted prefix, the coordinator does not open its own review: it raises a
hold whose `foreignConflict` flag is set ("The folder's change conflicts;
review it in Sync Status."), keeps the attempt, and dispatches `conflicted` to
the reducer. The app routes that flag to the daemon's review flow; the
client's conflict sheet is reserved for elements it authored.

**Watching.** `CanopyWatchRunner` (`CanopyClient`) follows one tree's watch
stream, feeds every event to the coordinator, reconnects with backoff, and
recovers an expired cursor through `recoverWatchGap`. iOS, the Mac, and
visits share it.
