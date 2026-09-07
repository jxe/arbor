# Reliability 005: Standardize Arbor Sync and direct Canopy client state machines

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This is one cross-language reliability change: first freeze the
> two state machines and their shared scenarios, then put those machines on
> every current TypeScript and Swift path named below. Do not create a third
> synchronization model, port Canopy's merge algorithm into a client, or
> silently reinterpret every UI transaction as an accepted-history boundary.
> If anything in “STOP conditions” occurs, stop and report rather than
> improvising. When complete, move this file to
> `plans/_done/reliability/005-client-synchronization-state-machines.md`, add
> verification evidence to the historical index, and remove its active entry
> from `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat ccc96ec..HEAD -- \
>   packages/client packages/render packages/arborsync packages/wire \
>   native/Packages/ArborKit native/Packages/ArborProviders \
>   native/Packages/ArborQuagmire native/Packages/ArborSync \
>   native/Packages/ArborWire conformance tests docs spec/01-tree-operations.md
> git status --short
> ```
>
> This plan was written immediately after the focused 250 ms native admission
> debounce landed in `ccc96ec`. If that behavior is absent or substantially
> different, stop and reconcile this plan before implementing the broader
> state-machine work.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: the focused native admission-debounce change present in the
  working tree at planning time
- **Coordinates with**: Reliability 004 conflict presentation, but neither plan
  blocks the other if they retain the same durable conflict evidence
- **Category**: correctness, durability, architecture, and client documentation
- **Planned at**: commit `ccc96ec`, 2026-09-07

## Outcome

Arbor publishes and tests two explicit client state machines:

1. **Arbor Sync document admission** for an editor or other source-preserving
   client talking to Local Arbor REST. It debounces a burst into one guarded
   source patch, allows at most one admission in flight plus one replaceable
   latest successor, makes `flush` force and await local durability, and fences
   authoritative refreshes from newer local intent by waiting for that
   editor session's latest credential-scoped request digest to appear in an
   accepted sync observation.
2. **Direct Canopy synchronization** for a durable replica or Arbor Sync itself
   talking to Arbor Wire. It coalesces unsent durable local generations into
   one candidate head, persists an exact request before transmission, retries
   ambiguous requests without changing their semantic identity, preserves one
   newer local head behind an in-flight request, and advances the accepted base
   only after validating and durably applying the authority result.

Both machines have language-neutral transition scenarios. The TypeScript web
editor and Swift native editor run the first machine. TypeScript Arbor Sync and
Swift iOS replica synchronization run the second. Low-level REST and Wire
clients remain stateless transports. `docs/` presents these as the reference
best practice for client authors; the portable Wire specification continues to
permit plural update strings without recommending one Wire generation per UI
gesture.

A rapid sequence of 15 Option-arrow moves therefore has one normal result:

```text
15 in-memory editor/undo transactions
  -> 1 coalesced Local Arbor REST admission
  -> 1 durable direct-client candidate
  -> 1 Canopy candidate decision
  -> at most 1 accepted update for the burst
```

If a prior request has already crossed the network ambiguity boundary, the
machine may instead retain that immutable prefix and publish one final
successor. It must never rewrite a request which may already have been accepted.

## Why this matters

The code currently contains the right safety mechanisms but not one explicit
model. TypeScript web editing already debounces, Swift native editing is gaining
a debounce, TypeScript Arbor Sync immediately posts progressively longer
admission strings, and Swift direct sync can extend an attempt while its prefix
is still in flight. This makes behavior depend on which client and language is
used, creates unnecessary loopback and Canopy traffic, and records interaction
steps as accepted-history boundaries even when only the final authored state is
meaningful.

The intended distinction is between **local editor history**, **locally durable
authored intent**, and **accepted Canopy history**. They are three different
things. Undo may keep every movement; the Local Arbor REST client may coalesce a
short interaction burst into one locally durable admission; the direct Canopy
client may further coalesce unsent durable heads. Once a semantic Wire request
may have reached Canopy, however, exact replay and causal ordering outrank
compaction.

## Current state and evidence

### Arbor Sync document clients

- `packages/render/src/editor-coordinator.ts:74-366` owns the TypeScript web
  editor's implicit state machine. `markAuthored` resets a 750 ms timer;
  `save()` serializes behind `saveInFlight`; `flush()` forces pending work; and
  generation/revision anchors reject stale external reads. This is the closest
  existing TypeScript exemplar for debounce and one-in-flight/one-latest
  behavior.
- `packages/render/src/api.ts:69-84` currently implements web Markdown saves
  through ordinary `writeMarkdown` mutation followed by another node read. It
  does not request an `admissionBasis` or use `/v1/documents/admit`, so its
  guarded shared-tree behavior differs from Swift native.
- `packages/render/src/editor-coordinator.ts:300-333` invokes client-side
  `mergeBlocks` after a 409. That behavior must not compete with Canopy for a
  Canopy-backed document. Retain an explicit local-only conflict policy for
  untracked/non-Canopy content rather than deleting it indiscriminately.
- `packages/client/src/index.ts:300-313` already exposes the stateless
  `admitDocumentCandidate` transport with exact source, optional guarded
  `sourceEdits`, `admissionBasis`, base revision, and stable `editorID`.
- `native/Packages/ArborQuagmire/Sources/ArborQuagmire/ArborDocumentBinding.swift`
  owns Swift editor generations, exact-source ledger, patch construction,
  conflict evidence, accepted-prefix refresh fences, and flush. Commit
  `ccc96ec` holds the newest source for 250 ms, cancels/replaces that pending
  admission on another commit, and forces it from `flush()`.
- `native/Packages/ArborProviders/Sources/ArborProviders/ArborSyncWorkspaceProvider.swift:414-630`
  implements `ArborSyncDocumentSession`: it translates a guarded Swift patch
  into `/v1/documents/admit`, retains admitted snapshots for read-your-writes,
  and gates watch echoes. It should remain a transport/session adapter rather
  than growing another scheduler.
- `native/Packages/ArborQuagmire/Tests/ArborQuagmireTests/ArborQuagmireTests.swift:391-460`
  is the focused Swift pattern for coalesced admission, timer expiry, flush, and
  no-op writes. `tests/unit/editor-coordinator.test.ts:96-175` is the TypeScript
  clock-controlled pattern.

### Direct Canopy clients

- `packages/arborsync/src/tree-sync.ts:71-590` and
  `packages/arborsync/src/service.ts:1096-1160` together form the TypeScript
  direct-client state machine. Durable state is split among placement metadata,
  pending editor admissions, pending tree update, accepted-object retention,
  conflict storage, `syncing/syncRequested`, and in-flight editor-push maps.
- `packages/arborsync/src/tree-sync.ts:372-424` currently posts the entire
  durable editor prefix immediately. A later admission creates a different
  in-flight key and may post a longer overlapping prefix before the earlier
  request returns. Exact duplicate pushes share a promise, but unsent trivial
  interaction steps are not compacted.
- `packages/arborsync/src/sync-state.ts:117-218` serializes durable editor
  admission append/acknowledge/retirement per TreeID. Its crash-safe journal is
  valuable evidence; the new machine must change which unsent heads become Wire
  elements without erasing recoverable local intent before the appropriate
  durability boundary.
- `native/Packages/ArborSync/Sources/ArborSync/ReplicaSyncCoordinator.swift`
  is the Swift direct-client implementation. `DurableSyncControl` retains an
  attempt, conflict, next base, and presentation; `syncActive/syncAgain` coalesce
  scheduling; `inFlight` prevents duplicate local submissions; response/watch
  races replay the exact durable request.
- `ReplicaSyncCoordinator.syncImmediately` currently extends and sends a longer
  request while an older prefix is in flight. Its offline path already leaves
  many durable replica generations behind one latest head and extends an
  ambiguous prefix once on reconnection. Preserve that good compaction rule and
  apply it consistently while online.
- `native/Packages/ArborSync/Tests/ArborSyncTests/ArborSyncTests.swift:293-370`
  proves offline heads compact behind an ambiguous prefix, while the preceding
  full-duplex test currently expects two overlapping online requests. The
  latter expectation must be replaced by the standard scheduling contract.
- `tests/integration/self-sync.test.ts:380-535` currently expects progressively
  longer Arbor Sync editor admission requests and separate Canopy accepted
  updates. Replace timing/order assertions with state-machine invariants,
  candidate ancestry, bounded request count, and final accepted outcome.

### Existing contracts that must be reconciled

- `spec/01-tree-operations.md:412-500` normatively permits append-only plural
  update strings and concurrent longer requests. Keep that capability: it is
  required after a request becomes ambiguous. Clarify that each element is a
  client-chosen publication/accepted-history boundary, not automatically every
  editor transaction.
- `spec/01-tree-operations.md:703-739` is a non-normative editor round trip that
  currently recommends freezing and immediately posting every durable
  generation. Rewrite the example around one coalesced unsent head plus an
  immutable ambiguous prefix.
- `docs/client.md:23` and `docs/arborsync-api.md:339-354` say that every durable
  editor generation extends and is immediately posted as a longer string.
  These descriptions will be stale after this work.
- Historical plans Native 007, 009, 015, 016, and 021 are evidence of why exact
  retry, authority-owned merge, local durability, and accepted-prefix fencing
  exist. Do not rewrite those completed records; supersede only their current
  operational guidance in source, tests, spec, and docs.

## Required state machine A: Arbor Sync document admission

Implement one pure transition core in each language, with payload-bearing
states so impossible combinations are not represented by unrelated booleans.
Names may follow language conventions, but shared fixtures use these semantic
states:

| State | Required retained data | Meaning |
|---|---|---|
| `clean` | accepted source/revision, optional admission basis, editor ID | No authored generation is newer than the locally durable acknowledgement. |
| `dirty` | clean base plus latest source/generation and debounce deadline | One or more editor transactions are coalescing; no request contains them yet. |
| `submitting` | immutable submitted patch/source/generation plus base | Exactly one Local Arbor REST admission is in flight. |
| `submitting-dirty` | immutable in-flight submission plus one replaceable latest source/generation | New edits occurred while the request was in flight; they have not become another request. |
| `admitted-awaiting-authority` | admitted source/revision/basis, editor ID, and latest request digest | Arbor Sync made the generation locally durable; this editor retains its live tree until an accepted observation incorporates its digest. |
| `conflict` | base when available, current, submitted source, and any newer local source | Arbor Sync rejected admission; no local source or evidence may be discarded. |
| `failed` | retryable exact pending source/patch and error classification | Transport/provider failure; UI must not say saved. |
| `closed` | no timer or active work | Terminal after a successful drain or an explicit failed-close result. |

Required transitions and invariants:

1. `edit` increments editor generation and replaces the state's latest source.
   It never performs I/O synchronously and never changes undo grouping.
2. Use a trailing 250 ms publication debounce for the current native/web
   reference clients. A burst has one latest source. Use an injected clock in
   tests; production code must not sleep in tests.
3. `debounceElapsed`, explicit Save, retry, focus loss, navigation, scene
   backgrounding, and close may initiate admission. `flush` cancels the timer,
   starts the latest pending admission, awaits the in-flight request, and if a
   newer source appeared while awaiting, submits exactly one coalesced
   successor before returning.
4. Compute the patch from the last acknowledged/admitted exact source to the
   latest captured exact source. Send both the complete resulting source and
   guarded nonoverlapping UTF-8 edits. An empty resulting patch is an
   idempotent local success and performs no request.
5. Never have two Local Arbor REST admissions in flight for one document
   session. While one is in flight, retain only the latest successor source;
   after success, derive its patch from the returned admitted source/revision.
6. A successful shared-tree admission means **durable in Arbor Sync**, not
   accepted by Canopy. It returns the credential-scoped Wire request digest.
   Each editor session—not Arbor Sync globally—waits for its own latest digest,
   because multiple editors on one machine may have different causal heads.
   Arbor Sync emits accepted digests with materialization and keeps recent
   accepted digests queryable from subsequent node snapshots so a reconnect
   can recover a missed observation; that report is not a global pending gate.
   Project remote synchronization separately in UI/status.
7. An authoritative observation may replace the editor only from `clean`, or
   from `admitted-awaiting-authority` when the observation's authenticated
   accepted-digest set includes that editor's latest request digest, and
   only after a final non-suspending comparison of generation, accepted
   revision/source, authored source, conflict/error state, and active request.
8. A Canopy-backed 409 retains Arbor Sync/Canopy conflict evidence and never
   invokes a competing client merge. A local/untracked document may retain its
   existing explicitly local conflict helper, but the transport kind must be
   explicit rather than inferred from an English error.
9. Disposal must not start an unobservable fire-and-forget save. App-controlled
   navigation and lifecycle paths call drain/flush and surface failure. Browser
   `beforeunload` may only use a documented bounded mechanism; if no reliable
   synchronous drain exists, retain visible pending state and document the
   limitation instead of claiming durability.

## Required state machine B: direct Canopy synchronization

Implement a pure transition core in TypeScript and Swift, backed by each
platform's existing durable store. Shared fixtures use these semantic states:

| State | Durable data | Meaning |
|---|---|---|
| `current` | confirmed `{root, update, cursor}` | Materialized local state equals the last applied accepted Canopy root. |
| `locally-pending` | confirmed base plus latest durable local head | Local work exists but is not part of any possibly transmitted request. Intermediate local generations may be compacted. |
| `prepared` | exact semantic request/prefix, digests, required objects/deltas | Request is durable before its first network attempt. |
| `submitting` | same immutable prepared request | Outcome may become ambiguous; never mutate or replace this request. |
| `submitting-pending` | immutable in-flight request plus one latest durable local head | Later local work is a replaceable successor, not another concurrent request. |
| `accepted-pending-apply` | validated response/transition plus any later local head | Authority decision is known but the accepted graph/base is not yet durably applied. |
| `conflict` | complete validated conflict/draft and local root, plus any later head | Conflict is client-owned and restart-safe; Canopy stores no rejected history. |
| `offline` | one of the durable pending/prepared shapes plus classified availability failure | Retry resumes from durable state without changing semantic identity. |
| `terminal` | diagnostic reason and retained durable files | A validation/programming invariant failed; automatic mutation stops. |

Required transitions and invariants:

1. Local filesystem/replica admission becomes durable independently of network
   availability. The scheduler uses a trailing 250 ms remote-publication delay
   with a one-second maximum from the first unsent durable head. Explicit Sync,
   shutdown drain where supported, and reconnection bypass the trailing delay.
2. Before any POST, persist one exact request from the applied accepted base to
   the latest durable local head. Collapse all unsent intermediate generations;
   one candidate represents one intentional accepted-history boundary.
3. Once a request starts, its base, ordered elements, matching policies,
   candidates, and derived request digests are immutable. An ambiguous retry
   resends the exact semantic request; object/delta packaging may vary only as
   the Wire contract already permits.
4. New durable local work during `submitting` replaces one successor head. Do
   not send a concurrent longer prefix merely because another edit arrived.
   After the first request resolves and its result is durably applied, publish
   one successor against the new applied base. If the first outcome is unknown,
   a longer append-only request remains the recovery escape hatch and may be
   used only by the explicit ambiguous-recovery transition.
5. Treat response and matching watch observation as racing evidence for the
   same request. Deduplicate by request digest and accepted update/cursor; never
   depend on arrival order or exact request count.
6. Rehash and validate every returned object, root, transition chain, tree
   boundary, and request digest before materialization. Persist accepted result
   intent if needed for crash recovery. Advance `{root, update, cursor}` only
   after durable materialization succeeds.
7. A clean watch can apply a contiguous transition batch in memory and
   materialize its final state once. A watch arriving with local pending work
   triggers synchronization; it never overwrites the local head.
8. A conflict durably retains base/local/current/draft and reasons, allows
   further local work, and exits only through explicit resolution expressed as
   a new ordinary request against the verified current accepted update.
9. Authentication/revocation, offline transport, protocol validation, and
   programming errors have distinct transitions. Only availability failures
   retry automatically; validation failures become terminal diagnostics.

Canopy itself must not guess that several submitted elements are “trivial” and
rewrite accepted history. By the time an element reaches Canopy it is an
explicit client-selected accepted-history boundary. Canopy continues to trim
exact replayed prefixes and process plural strings deterministically. Traffic
and history reduction happen before request preparation in the direct client.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| TS focused editor | `bun test tests/unit/editor-coordinator.test.ts tests/unit/client.test.ts` | all pass |
| TS direct sync | `bun run test:sync-merge` | all Wire, Canopy, and Arbor Sync synchronization tests pass |
| Protocol/conformance | `bun run test:protocol` | TypeScript/Swift protocol fixture gate passes |
| Swift ArborQuagmire | `tools/test-arbor-quagmire-local.sh` | all ArborQuagmire tests pass and tracked lockfile is restored |
| Swift ArborSync | `swift test --package-path native/Packages/ArborSync` | all direct replica synchronization tests pass |
| Swift client/provider | `swift test --package-path native/Packages/ArborClient && swift test --package-path native/Packages/ArborProviders` | all pass |
| Product suite | `bun run test` | maintained unit/integration suite passes |
| Build | `bun run build` | web and CLI builds exit 0 |
| Documentation links | use the repository-wide relative-link checker required by `AGENTS.md`; if no maintained command exists, run a read-only script that resolves every relative Markdown link under the repository | zero missing relative targets |
| Whitespace | `git diff --check` | no errors |

## Scope

**In scope**:

- `conformance/client-state-machines.json` (create) and fixture validation
- `packages/render/src/editor-coordinator.ts`, `PageEditor.tsx`, `api.ts`
- `packages/client/src/index.ts` only for stateless transport shape needed by
  the integrated first machine
- focused TypeScript editor/client tests
- `native/Packages/ArborQuagmire/Sources/ArborQuagmire/ArborDocumentBinding.swift`
  and focused tests
- `native/Packages/ArborProviders/.../ArborSyncWorkspaceProvider.swift` only
  for session transport/read-your-writes integration
- a TypeScript direct-state reducer/module under `packages/arborsync/src/`, plus
  `tree-sync.ts`, `service.ts`, `sync-state.ts`, and focused tests
- a Swift direct-state reducer under `native/Packages/ArborSync/Sources/`, plus
  `ReplicaSyncCoordinator.swift`, `SyncModels.swift`, `SyncDurability.swift`,
  and focused tests
- `docs/client-state-machines.md` (create), `docs/README.md`, `docs/client.md`,
  `docs/arborsync-api.md`, `spec/01-tree-operations.md`, and `status.md`

**Out of scope**:

- changing Canopy merge, authorization, accepted-update storage, or request
  identity semantics
- server-side heuristic squashing of submitted update elements
- exposing accepted history as a public API
- a cross-language code generator or one framework shared between unrelated
  document-admission and tree-synchronization machines
- changing Quagmire undo grouping or treating view-only fold state as authored
- implementing Reliability 004's conflict-resolution UI
- altering Postgres observation/synchronization plans
- weakening exact Markdown/source fidelity, TreeID/path/stable-key scope, nested
  tree boundaries, or current graph authorization
- deployment, live Railway mutation, dependency release, or migration work

## Git workflow

- Branch: `codex/reliability-005-client-state-machines`
- Preserve unrelated changes and retain the focused native debounce behavior
  from `ccc96ec` while replacing its ad hoc task/tuple state with the designed
  Swift reducer.
- Use small imperative commits matching current history, for example:
  `Define client synchronization state machines`, `Adopt admission machine in
  web and native`, and `Adopt direct sync machine in TypeScript and Swift`.
- Protocol/spec/fixture changes land with the code that consumes them; do not
  leave a documented state machine that no runtime executes.
- Do not push, release Quagmire, deploy, or open a PR unless explicitly asked.

## Steps

### Step 1: Freeze vocabulary, transition tables, and shared scenarios

Create `conformance/client-state-machines.json` with a versioned schema and two
scenario groups: `arborsync-document-admission` and
`direct-canopy-synchronization`. Each scenario contains an initial abstract
state, ordered events, expected state after every event, expected side effects
(`schedule`, `cancelTimer`, `admit`, `persistRequest`, `submit`, `apply`,
`surfaceConflict`, `stop`), and retained identity fields represented by stable
fixture tokens rather than real hashes.

Cover at minimum:

- 15 edits before debounce -> one admission/submission containing the final
  source/head;
- edit, timer fires, edit while request is in flight -> one immutable request
  plus one latest successor, never two concurrent ordinary requests;
- flush before timer -> one forced request and a durable completion;
- edit back to accepted bytes -> no request;
- response/watch in both orders;
- stale observation captured before a newer generation -> ignored;
- exact response lost -> exact retry/replay;
- offline burst -> latest durable head only;
- restart in every durable direct-client state;
- accepted/merged result with later local work -> apply authority result, then
  submit the retained latest head against the new base;
- malformed result -> terminal without materialization/base advancement;
- conflict plus later local work -> preserve all evidence and latest head;
- explicit conflict resolution -> new request at verified current base.

Add a TypeScript schema/fixture validator before adding implementations. Keep
the fixture about semantic transitions, not milliseconds, task primitives, or
UI labels.

**Verify**: `bun test tests/unit/client-state-machines.test.ts` -> schema and all
fixture sequences validate.

### Step 2: Implement the Arbor Sync admission machine in TypeScript

Extract the scheduling/durability transition logic from `EditorCoordinator`
into a pure reducer with a small effect runner. Keep BlockNote capture,
serialization, history, and presentation in `EditorCoordinator`; keep HTTP in
`@arbor/client`. The reducer must be the only owner of timer, in-flight,
successor, flush, observation, failure, and conflict transitions.

Open shared-tree editor nodes with `admissionBasis=true`, retain one stable
`editorID` for the session, derive guarded UTF-8 source edits against the last
admitted exact source, and call `admitDocumentCandidate`. Retain the returned
request digest in that coordinator only. Update the returned
source/revision/basis through the same read-your-writes and observation fences
as Swift. Continue using ordinary mutation for local/untracked content lacking
an admission basis, but make the transport mode explicit and do not run
`mergeBlocks` for a Canopy-backed conflict.

Replace `dispose()`'s unawaited save with explicit app-owned draining. Preserve
the existing 750 ms history grouping independently from the 250 ms persistence
debounce; undo grouping and save batching are separate clocks even if both use
the injected test clock.

**Verify**:

```sh
bun test tests/unit/editor-coordinator.test.ts tests/unit/client.test.ts
bun run typecheck
```

Expected: TypeScript consumes every admission-machine fixture, 15 changes make
one admission, one in-flight plus many edits makes one successor, shared
conflicts never enter `mergeBlocks`, and stale reads never overwrite newer
intent.

### Step 3: Put the same admission machine in Swift native

Replace the ad hoc tuple/timer/task combination in `ArborDocumentBinding` with
a Swift payload enum/reducer that consumes the same fixture transitions. Keep
`ArborSourceLedger` and Markdown patch calculation in ArborQuagmire and
`ArborSyncDocumentSession` as the provider adapter. Do not move Arbor concepts
into Quagmire.

Use an injected clock/scheduler for deterministic tests. Preserve the accepted
prefix fences already present in `receiveAuthoritativeUpdate`. Verify that
each binding waits for its own latest request digest, that two bindings sharing
one Arbor Sync process advance independently, and that a merged result matches
by request digest rather than candidate content revision. Verify that
focus loss, navigation, backgrounding, workspace eviction, retry, conflict
choice, history/recovery, and close all use the state machine's force/drain
events and cannot report saved while a dirty successor remains.

**Verify**: `tools/test-arbor-quagmire-local.sh` -> all tests pass, including the
shared fixture scenarios and lifecycle drains, with no tracked lockfile change.

### Step 4: Implement the direct Canopy machine in TypeScript Arbor Sync

Create a pure TypeScript transition reducer under `packages/arborsync/src/` and
make `TreeSynchronizer` its effect runner. Consolidate `syncing`,
`syncRequested`, editor-push promise keys, pending update/admission inspection,
and conflict branching behind typed machine states and events. Durable
serialization stays per TreeID through `sync-state.ts`.

Change online editor admission scheduling so a new locally durable candidate
updates one unsent latest head and resets the trailing remote debounce. If a
request is already in flight, retain one latest successor without issuing a
concurrent longer POST. Keep append-only plural requests for exact ambiguous
recovery only. General filesystem watcher bursts use the same 250 ms trailing,
one-second maximum publication boundary rather than freezing every observed
intermediate root.

Do not collapse independent editor epochs into one speculative graph when they
share a base: they remain distinct candidates for Canopy merge. Compaction is
safe only within the same writer/document epoch or for successive snapshots of
the same single local materialization before request preparation. Encode this
scope in types and tests; never infer it from timing alone.

**Verify**: `bun run test:sync-merge` -> all tests pass; burst tests assert one
ordinary POST/accepted candidate, ambiguous retry tests assert exact identity,
and concurrent independent editors still reach Canopy as sibling candidates.

### Step 5: Put the direct Canopy machine in Swift replica synchronization

Add the corresponding Swift payload enum/reducer under `ArborSync` and integrate
it into `ReplicaSyncCoordinator`. Map `DurableSyncControl` to explicit durable
states rather than optional `attempt`, `conflict`, `nextBase`, presentation,
and unrelated transient flags that can form impossible combinations. Provide a
backward-compatible decoder/migration for the current schema-1 control file;
write the new form atomically and never discard malformed old state.

Route `syncImmediately`, `setTransportAvailable`, `observe`, `syncOnce`, exact
retry, result application, conflict resolution, and close through machine
events. Online bursts follow the same one-in-flight/one-latest policy as
TypeScript. The already-good offline compaction test remains and the current
“longer update string before prefix response returns” test becomes an
invariant test proving no concurrent successor POST until the prefix outcome is
resolved, except in the named ambiguous-recovery transition.

**Verify**: `swift test --package-path native/Packages/ArborSync` -> all shared
fixtures, restart/fault injection, two-peer convergence, offline compaction,
and response/watch races pass.

### Step 6: Prove actual runtimes use the reducers

Add integration assertions around effect boundaries rather than testing only
the pure reducers:

- web PageEditor -> actual Local Arbor REST route/body;
- native ArborDocumentBinding -> actual session admission count and patch;
- Arbor Sync -> actual Wire request bodies and durable state across restart;
- iOS replica coordinator -> actual prepared request bodies and materialized
  accepted head.

Add a lightweight source ownership check in the protocol test or a focused test
which fails if the four runtime entry points bypass their reducer/effect runner.
Do not rely on class names alone: exercise edit/admit/sync events and observe
the state/effects. Low-level `ArborSyncRESTClient` and `ArborWireClient` remain
transport-only and need not own machine state.

**Verify**:

```sh
bun run test:protocol
bun run test:sync-merge
tools/test-arbor-quagmire-local.sh
swift test --package-path native/Packages/ArborSync
```

Expected: both languages consume the same fixture scenarios and every current
reference runtime demonstrably transitions through the relevant machine.

### Step 7: Publish the client-authoring guidance

Create `docs/client-state-machines.md` with:

- the two state diagrams and complete transition tables;
- retained data and durability boundary for every state;
- pseudocode for reducer + effect-runner integration;
- rules for debounce, maximum publication delay, flush/drain, exact retry,
  observation races, conflict ownership, validation, and lifecycle handling;
- a decision guide: use Arbor Sync admission when a local daemon owns authored
  persistence; use direct Canopy synchronization when the client owns a durable
  replica; do not combine the two machines or skip local durability;
- examples for a web editor, macOS native editor, iOS native replica, and Arbor
  Sync daemon;
- an explicit statement that UI undo history, locally durable intent, Wire
  candidate boundaries, and Canopy accepted history are separate layers.

Link it from `docs/README.md`, `docs/client.md`, and `docs/arborsync-api.md`.
Update stale “post every generation immediately” prose. Clarify the portable
specification without removing plural strings or the ability to append after an
ambiguous request. Update `status.md` only after all four implementations and
cross-language fixtures pass.

**Verify**: repository-wide relative-link check -> zero missing targets;
`git diff --check` -> no errors.

### Step 8: Run complete gates and archive the plan

Run the focused commands first, then the maintained repository gates:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborProviders
swift test --package-path native/Packages/ArborSync
tools/test-arbor-quagmire-local.sh
git diff --check
```

If existing full-suite failures occur, reproduce them from a clean worktree at
the planned base before classifying them as regressions. Record exact passing
commands and any demonstrated baseline-only failure when moving this plan to
`_done`.

## Test plan

- **Shared scenarios**: both TypeScript and Swift decode and execute every case
  in `conformance/client-state-machines.json`; fixture schema rejects unknown
  states/events and incomplete expected effects.
- **Deterministic time**: fake clocks prove trailing debounce reset, maximum
  publication delay, forced flush, cancellation, and no timer firing after
  close. No correctness test depends on wall-clock sleeps.
- **Admission concurrency**: 15 edits -> one patch; edits during request -> one
  latest successor; accepted response before/after watch; stale observation;
  two editor sessions waiting on different digests; accepted prefix lacking the
  current editor's digest; merged result acknowledging the current digest;
  empty final patch; retryable error; conflict; edit after conflict; flush and
  close failure.
- **Direct concurrency**: online/offline bursts; request persisted before
  transport; ambiguous response loss; exact replay; watch-first and
  response-first; newer local head during upload/download/materialization;
  merged/current/accepted/conflict outcomes; malformed graphs; auth/revocation;
  restart at every durable state.
- **Identity and scope**: separate document editors at one base remain separate
  epochs; tree/path/stableKey mismatch is rejected; nested TreeIDs never compact
  together; account configuration and ordinary trees retain their policy.
- **History**: ordinary bursts normally create one accepted Canopy update;
  ambiguous prefixes may create the already-submitted update plus one final
  successor; exact replay creates no duplicate row.
- **Lifecycle**: browser navigation, native navigation, focus loss, background,
  workspace eviction, close, and daemon restart preserve or explicitly report
  pending work.

## Done criteria

- [ ] One versioned shared fixture defines both machines and is executed by
  TypeScript and Swift tests.
- [ ] TypeScript web and Swift native editors use the Arbor Sync admission
  machine in their actual save paths.
- [ ] TypeScript Arbor Sync and Swift `ReplicaSyncCoordinator` use the direct
  Canopy machine in their actual synchronization paths.
- [ ] Fifteen rapid Option-arrow moves produce one Local Arbor REST admission
  and normally one Canopy candidate/accepted update.
- [ ] Every machine permits at most one ordinary request in flight and retains
  at most one replaceable latest successor.
- [ ] An ambiguous request remains immutable and exactly retryable; plural
  append-only recovery remains supported.
- [ ] No Canopy-backed client performs a competing Markdown/tree merge.
- [ ] Every Arbor Sync editor client owns its own latest request-digest fence;
  Arbor Sync exposes authenticated accepted digests without imposing a
  machine-wide editor gate.
- [ ] Authority responses are validated and materialized before the accepted
  base advances in both direct clients.
- [ ] Conflict evidence and newer local work survive restart in both direct
  clients.
- [ ] `docs/client-state-machines.md` is linked and describes the two choices as
  client best practice without presenting reference timing as portable Wire
  compatibility.
- [ ] All commands in Step 8 pass, relative Markdown links resolve, and no
  unrelated files are modified.

## STOP conditions

Stop and report rather than improvising if:

- the focused native debounce is missing, rejected, or known to lose a
  lifecycle-triggered edit;
- a current client path cannot make its local authored intent durable before
  network submission;
- coalescing would require changing a semantic request which may already have
  reached Canopy;
- independent editors or separate tree boundaries cannot be distinguished
  before compaction;
- the implementation would need a client-side copy of Canopy's merge rules;
- Swift and TypeScript cannot express a shared fixture transition without
  weakening exact retry, conflict retention, or validation;
- migrating `DurableSyncControl` cannot preserve an existing pending attempt or
  conflict byte-for-byte;
- browser lifecycle requirements would require claiming a synchronous network
  durability guarantee the platform cannot provide;
- any protocol shape changes without matching TypeScript and Swift models,
  language-neutral fixtures, API/spec documentation, and focused tests;
- a step requires live Railway mutation, Quagmire release, or files outside the
  declared scope.

## Maintenance notes

- Treat the fixtures as compatibility tests for client behavior, not as a code
  generator. Cross-language agreement matters; identical internal class layout
  does not.
- Keep scheduling policy configurable for tests but centrally owned in each
  machine. Changing debounce values requires burst/request-count evidence and
  updates to both reference clients' tests and documentation.
- A future direct Canopy client should adopt the direct machine before gaining
  write access. A future Local Arbor REST editor should adopt the admission
  machine rather than copying `PageEditor` or `ArborDocumentBinding` state.
- Canopy storage packing may compact physical history representation, but it
  must not rewrite accepted semantic boundaries. Reliability 005 reduces those
  boundaries before submission; Canopy storage 001 optimizes their retained
  physical representation afterward.
- Reliability 004 may add richer conflict transitions and presentation, but it
  must consume the durable `conflict` state rather than create a third save or
  synchronization coordinator.
