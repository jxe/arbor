# Arbor Sync document admission

An editor that talks to Local Arbor REST runs one state machine between its
undo history and the daemon. This document is the reference for that
machine: its states, the data each retains, its transitions, and the rules a
new editor host must follow. The direct Canopy machine that Arbor Sync and a
durable replica run against Arbor Wire is specified separately in
[client synchronization](../spec/09-client-synchronization.md); this page
only says where the two meet.

The reference implementations are `DocumentAdmissionMachine` in `ArborKit`
(Swift) and `reduceAdmission` in `@arbor/arborsync-client` (TypeScript). Both
are pure reducers that execute every scenario in
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json);
the editor hosts (`ArborDocumentBinding`, `EditorCoordinator`) run the
effects.

## 1. Three layers, three clocks

- **Local editor history** may keep every movement. Undo grouping is the
  editor's own clock (the web editor groups at 750 ms) and never influences
  what is sent.
- **Locally durable authored intent** is what Arbor Sync holds once an
  admission succeeds. The machine coalesces a burst of edits into one
  admission behind a trailing 250 ms debounce, and never has two admissions
  in flight for one document session.
- **Accepted Canopy history** is produced later by the direct machine. An
  admission returns a credential-scoped Wire request digest; the editor keeps
  its live tree until an accepted observation incorporates that digest.

A rapid sequence of 15 Option-arrow moves is therefore 15 undo entries, one
admission, and normally one accepted Canopy update.

## 2. States and retained data

Every state carries the accepted `{ source, revision, admissionBasis? }`, the
monotonic editor `generation`, and the transport kind (`canopy` or `local`).

| State | Retained data | Meaning |
|---|---|---|
| `clean` | accepted source/revision, optional basis | No authored generation is newer than the locally durable acknowledgement. |
| `dirty` | latest source and generation; a timer is armed | Edits are coalescing; no request contains them yet. |
| `submitting` | the immutable submitted source/generation | Exactly one admission is in flight. |
| `submitting-dirty` | the immutable submission plus one replaceable latest source | Edits arrived during the request; they are one successor, not another request. |
| `admitted-awaiting-authority` | admitted source/revision/basis and the request digest | Locally durable; the editor retains its tree until an observation carries its digest. |
| `conflict` | the submitted source, the current observation when known, any newer local source | Arbor Sync rejected admission; nothing is discarded. |
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
source, baseRevision, admissionBasis?)`, `acknowledge(result)`,
`apply(source, revision)`, `mergeLocally(...)`, `surfaceConflict`,
`surfaceFailure(error)`, `stop`.

```text
clean ──edit──▶ dirty ──debounceElapsed/flush──▶ submitting ──admitted──▶ admitted-awaiting-authority
  ▲               │                                 │  ▲                          │
  │               └──edit (resets timer)            │  └── admitted with a         │ observed carrying
  │                                          edit   │      retained successor:      │ the digest
  │                                                 ▼      acknowledge, then admit  ▼
  │                                        submitting-dirty ───────────────────────▶ clean (apply)
  │                                                 │
  └────────── admitted without a digest ◀───────────┘
                                                    ├──admissionConflicted──▶ conflict ──resolveConflict──▶ clean | submitting
                                                    └──admissionFailed─────▶ failed ────retry/flush──────▶ submitting
```

## 4. Transition rules

1. **`edit` never performs I/O.** It increments the generation, replaces the
   latest source, and arms the trailing debounce (from `clean`, `dirty`, or
   `admitted-awaiting-authority`). During a request it only replaces the
   successor. In `conflict` or `failed` it is retained as the newer local
   source.
2. **One admission in flight, one successor.** `debounceElapsed` or `flush`
   moves `dirty` to `submitting`. Edits during the request accumulate into one
   successor; when the request succeeds the machine acknowledges it and
   immediately admits the successor against the returned revision.
3. **Empty change is a local success.** If the latest source equals the
   accepted source when a request would start, the machine returns to `clean`
   without a request.
4. **The digest fence.** A successful admission with a request digest enters
   `admitted-awaiting-authority`. Observations are applied only when their
   accepted-digest set contains that digest; an observation at the accepted
   revision that carries it clears the fence without replacing the editor. A
   new edit supersedes the fence: the editor then waits for its next digest.
5. **Stale reads are discarded.** A host captures `anchor = { generation,
   revision }` before an asynchronous read and passes it with `observed`. If
   either moved, the observation is ignored. Hosts must also hold an
   uncommitted keystroke themselves: the machine has no generation for it.
6. **External change under coalescing intent** (`observed` while `dirty`)
   cancels the timer and admits now, so the authority, not the editor,
   reconciles.
7. **Conflicts are transport-specific.** A Canopy-backed conflict surfaces
   evidence and never runs a client merge. A `local` transport may run the
   host's explicit merge helper (the web editor's block merge for untracked
   documents); the transport becomes `canopy` the moment an admission
   returns a basis.
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
- Run `admit` through the session (`/v1/documents/admit` when the accepted
  snapshot carried an `admissionBasis`, an ordinary guarded write otherwise)
  and classify the outcome as `admitted`, `admissionConflicted`, or
  `admissionFailed`. An exact-source race (the provider already holds the
  submitted bytes) is `admitted`.
- On `acknowledge`, advance source authority without reparsing when the
  acknowledged source is the tree already mounted; rebase the editor only when
  the provider returned a transformation.
- On `apply`, replace the editor with authoritative content while preserving
  selection where the codec allows.
- Feed the same `observed` event from watch notifications and from the
  provider's read-your-writes snapshot; the reducer decides.

## 6. Where the machines meet

Arbor Sync answers `admit` with `admissionRequestDigest` once the generation
is durable. Its direct machine (spec [client synchronization
§2](../spec/09-client-synchronization.md#2-direct-canopy-synchronization))
compacts unsent generations from one editor before request preparation,
publishes behind a trailing delay, and materializes only accepted state. When
that state is written, Arbor Sync emits the incorporated digests with the
`updated` event and keeps recent ones on later node snapshots, which is how
a reconnecting editor recovers its fence.

Choose this machine when a local daemon owns authored persistence. Choose the
direct machine when the client owns a durable replica. Do not combine them or
skip local durability.
