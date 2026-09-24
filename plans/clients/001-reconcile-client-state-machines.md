# Clients 001: One update machine for every working tree

Status: DESIGN AGREED 2026-09-24, not started. No priority assigned. Replaces the earlier
version of this plan, which reconciled two machines (document admission and
working-tree updates) with their runners; see git history.

This plan changes:
- [spec 09](../../docs/overstory-spec/09-client-synchronization.md) and
  [`client-state-machines.json`](../../docs/overstory-spec/conformance/client-state-machines.json);
- both update reducers;
- the Swift `UpdateCoordinator` and editor binding;
- the TypeScript runner and the daemon's folder synchronization.

## Outcome

One pure machine decides how every working tree syncs with Overstory. An editor
that captures intent and a folder that captures only bytes feed it the same way.
Both append **local changes** to a durable **change log**, and a shared runner
executes the machine's effects. The practices the clients learned the hard way
live in that runner and in two library sources:
- `EditorSource`: per-generation frames, keystroke guards, self-acknowledgement.
- `FolderSource`: stat-indexed scans, safe materialization.

A new client (the browser in [Web 025](../canopy-web/025-arbor-web.md), a CLI,
an agent) picks a source and a set of ports. It does not re-derive policy.

There is no state machine between an editor and its working tree. An editor's
generation is acknowledged once its change-log record is durable.

## Why

**On the wire, intent and no intent differ only in `trace`.** An editor sends
one frame per generation. The daemon sends `trace: null`. The route, the
request digest, and the host's reconciliation are the same
([spec 10](../../docs/overstory-spec/10-source-intent.md),
[tree operations §2.1](../../docs/overstory-spec/01-tree-operations.md#21-the-update-request)).

**The durable queue already holds both kinds.**
- `prepareSourceAdmission` falls back to `trace: null`
  (`packages/client/src/source-admission-queue.ts`), and Swift's
  `SourceAdmissionRecord` does the same when `evidence` is false.
- `publicationTip` and `request(through:)` replay an authored chain from its
  accepted base. That is the daemon's `appendPendingTreeSuccessor` and
  spec 09 rules 4 and 10, written a third time.

**Today's layering is the problem.** Audit of 2026-09-24:

- **Editor to host.** Nine layers decide something between a keystroke and a
  request, with three stacked delays (750 ms Quagmire typing checkpoint,
  250 ms admission debounce, 250 ms–1 s publication). The layers are:
  1. the typing checkpoint;
  2. `DocumentAdmissionMachine`;
  3. the binding's admission task chain;
  4. `EditorRecoveryStore`;
  5. the document session's policy and snapshot cache;
  6. the coordinator's `admissionTail`;
  7. `SourceAdmissionQueue`;
  8. `UpdateMachine`;
  9. the coordinator's own flags.
- **Swift's `UpdateCoordinator` runs the reducer but decides most things itself.**
  - It writes `machine.phase` or `machine.base` in nine places.
  - It treats `submit`, `apply`, `catchUp` and `stop` as no-ops, and ignores
    `persistRequest`'s base and candidate.
  - It never dispatches `watch`, `watchGap`, `credentialsRefreshed` or
    `transportAvailable(false)`, and handles watch, gap and catch-up by hand.
  - It keeps `syncActive`/`syncAgain`/`inFlight`/`terminal`/`transportAvailable`
    beside the machine.
  - It chooses between a review pass, a source pass and a legacy snapshot pass.
  - The source pass reports every error as a transport failure.
- **The daemon's `TreeSynchronizer` (`packages/client/src/tree-sync.ts`) runs no machine.**
  - It keeps no durable head before publication.
  - Local edits don't trigger a pass: the watcher only invalidates index rows,
    so an edit waits for the 30 s tick, a remote event or an explicit sync.
  - It doesn't classify failures.
  - A 409 opens a Base/Current/Mine/Draft conflict workspace, clears pending
    and pauses the tree, which contradicts rule 8.
  - The unsupported-operation latch is in memory only.
- **TypeScript's machine code runs only in tests.** That is `reduceUpdate`,
  `reduceAdmission`, `DocumentAdmissionController`, `SourceAdmissionQueue` and
  `SourceAdmissionPublisher`. `packages/canopy-web/src/editor-coordinator.ts`
  targets APIs and daemon routes that no longer exist.

## Decisions (Joe, 2026-09-24)

1. **One machine.** `UpdateMachine` is the only client synchronization machine.
   The document admission machine, its fixture section and both reducers are
   deleted, together with the compare-and-swap admission policy.
2. **Editor generations go straight into the change log.** A generation is
   acknowledged when its record is durable. The following are deleted, and
   recovery on open reads unpublished log records:
   - the exact-bytes recovery journal (`EditorRecoveryStore`) and its saved
     markers;
   - the 250 ms admission debounce;
   - the second flush step.
3. **Rejection is held.** A definitive rejection keeps the rejected chain
   durable and stops publishing it. The daemon's conflict workspace and
   `/v1/conflicts*` routes are retired.
   [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md)
   becomes a later rule of the held state.
4. **Swift first.** The Swift runner and editor move first and soak. The
   TypeScript runner and the daemon follow, then Web 025.

## Design

### Vocabulary (identical in Swift and TypeScript)

"Admission" leaves the client vocabulary.

- **Local change.** One durable authored record:
  - `change`, and `basis` (`accepted{root, update}` or `authored{change}`);
  - `candidate` and `objects`;
  - `trace: Frame[] | null`, `resolves`, and `provenance`.

  The forms it takes:
  - an editor generation carries one frame;
  - a folder scan carries `trace: null`;
  - a structural action (page creation, move, import) carries entry
    operations, or an explicitly chosen snapshot;
  - a review resolution carries `resolves`.

  Records keep hashes and the wire element, never document bytes.
- **`ChangeLog`.** The durable, append-only store of local changes for one
  tree. It is renamed from `SourceAdmissionQueue` and keeps that queue's:
  - flock and fingerprint reload;
  - compaction and trace compaction;
  - `publicationTip`;
  - `request(through:)`.
- **`UpdateMachine`.** The pure reducer; the name is unchanged.
- **`UpdateCoordinator`.** The runner. It executes every effect through ports.
- **Source.** Anything that appends local changes. The two library sources are
  `EditorSource` and `FolderSource`. Structural actions and review drafts
  append through the same API. Sources are not machines.

### Machine

- **Input.** The machine learns of work only through `localChange(tip)`,
  dispatched after the record is durable (rule 1). `localHead` and
  `UpdateHead` are deleted, because the log tip is the head.
- **One chain rule.** A request is the log chain from the accepted base to the
  tip. Elements that were already transmitted are repeated exactly, and later
  records are appended once. This replaces the separate wording of rules 4, 10
  and 11. It also replaces the daemon's successor append and the Swift
  "fresh single request against the old base".
- **Events the runner must dispatch:**
  - `watch` and `watchGap`;
  - `poll` (freshness is a machine `schedule`, not a runner interval);
  - `rejected` (a new event) and `unsupported`;
  - `transportAvailable(true|false)` and `credentialsRefreshed`.
- **Failure taxonomy:**
  - transport → `offline`, retried automatically;
  - authentication or revocation → `offline(auth)`, resumed by
    `credentialsRefreshed`;
  - validation → `terminal`;
  - definitive rejection → **`held`**, which keeps the chain and reports it,
    and resumes on an explicit discard or a replacing change;
  - unsupported operation → `held(upgrade)`.

  Reconnect backoff is one runner setting.
- **Complete effects.** No runner reconstructs an input from its own state.
  The effects are:
  - `persistRequest(chain range)`, `submit(request digest)`;
  - `apply(result)`, `catchUp(cursor)`, `materialize(root)`;
  - `schedule` and `cancelTimers`;
  - `report(status)`.

  Presentation is derived from machine state.
- **One materialization rule.** An accepted result becomes the accepted base
  immediately. The working tree's view is the log tip's candidate while
  changes are pending, and the accepted root otherwise.
  - A folder writes accepted bytes to disk only when the log has nothing
    pending and the disk still equals the tip; otherwise it scans first.
  - An editor overlay derives its view. That gives read-your-writes and
    re-seed (rule 12) without runner code.
- **Conflicted acceptance** stays ordinary (rule 8).
- **Kept:** installation entry, racing evidence (rule 5) and
  validate-before-advance (rule 6).

### Sources

**`EditorSource`** (Swift in phase 3, TypeScript in phase 5) takes over the
practices from `ArborDocumentBinding` and `ArborEditorHost`:
- Per-generation patch capture against the predecessor's ledger, validated by
  replay, with a byte-diff fallback to `trace: null`.
- Appending at the typing checkpoint, which is the only editor-side delay.
- Guards for keystrokes the editor has not committed yet, at flush, at a stale
  acknowledgement and at a live update.
- Self-acknowledgement without reparsing, which preserves selection and undo.
- A re-read under an anchor when an update arrives.
- `flush()`, which appends now and dispatches the machine's flush.

The snapshot cache shrinks to the log's own records.

**`FolderSource`** (TypeScript, phase 4):
- A watcher event triggers a debounced scan through the stat index (`ObjectIndex`).
- A root that differs from the log tip appends a `trace: null` change.
- The revalidation walk and the bootstrap, credential and object-cache
  loopback services are unchanged.

**Structural and review sources.** Page creation, `addEntry`, moves, imports
and resolution drafts each append a record. The coordinator's separate review
pass and `sync/conflict-review.json` attempt disappear, and the drafts
themselves stay with [Native 010](../swift/010-client-conflict-review.md).

### Runner

`UpdateCoordinator`, in both languages.

**Ports:**
- `ChangeLog`: file-backed, and IndexedDB for the web.
- `ControlStore`: accepted `{root, update, cursor}`, the exact attempt, the held record, and the event log.
- `Transport`.
- `WorkingTree`: install, view, materialize.
- `Clock`.

**Rules:**
- It executes every effect it is given.
- It never writes the phase.
- It keeps no flag that duplicates a machine rule. State it needs to *perform*
  an effect (file handles, caches) is fine; state that decides *what happens
  next* belongs in the machine.
- `CanopyWatchRunner` only turns stream frames into events.

**Runner vectors.** Shared vectors in `tests/fixtures/update-runner.json`
drive a coordinator with a fake transport, log and working tree. They check
the effects performed and the durable state that results, including crash
points between effects. These vectors are implementation fixtures, not spec.

### Portable versus replaceable

Spec 09 keeps the observable contract: what may be sent, when a change is
durable, and what held and conflicted mean. Timer values, backoff, scan
debounce and store layouts stay in the implementation guides.

### Durable-state upgrade

New builds refuse, with a diagnostic, to open old state that still has pending
work. Old state with nothing pending converts. That old state is:
- Mac: `sync/update-control.json`, `sync/source-admissions.json`,
  `sync/conflict-review.json` and editor recovery copies.
- Daemon: `sync/<tree>.json` and its conflict material.

The upgrade procedure is to drain with the old build, then install. Installing
any build on the Mac, the iPhone or the daemon needs Joe's go-ahead.

## Phases

Each phase lands the spec, doc and plan changes that it makes true.

### Phase 0: correct the documentation now

This can land first, independently of the rest.

- `docs/implementing-sync-services/update-machine.md` says the daemon runs the
  machine, and presents `reduceUpdate` as a production reference.
- `status.md` lists the client state machines as installed in both languages.
  Only Swift's are.
- The conformance README says a rejected admission "runs the host's local
  merge helper", and lists adoption scenarios the fixture lacks. The spec
  README (conflict ownership with adopted prefixes) and `01-tree-operations.md`
  (the app adopting the daemon's pending request) make the same stale
  adoption claim.
- `docs/implementing-editors/document-admission.md` describes a web coordinator
  that doesn't exist. Mark it as superseded by this plan.
- `docs/implementing-editors/design.md` links "update machine" to the admission guide.
- `01-tree-operations.md` JSON examples use `"operations": null` where the
  grammar says `"trace"`.
- `UpdateMachine.swift`'s header uses retired names.
- Gate: `bun run check:links`, `git diff --check`.

### Phase 1: machine and spec

- Rewrite spec 09:
  - §2.3 around the chain rule, `held` and the failure taxonomy.
  - Replace §3 "Relationship to editor admission" with "Local changes". The
    exact-basis, frame-per-generation, captured-operation and
    durability-before-acknowledgement requirements stay, as obligations of
    whoever appends.
  - Align "Accepted conflicts and unaccepted local work" with `held`.
- Update `client-state-machines.json`, Swift `UpdateMachine` and TypeScript
  `reduceUpdate` together.
- Delete the `document-admission` section, TypeScript `reduceAdmission` and
  `DocumentAdmissionController`. Swift `DocumentAdmissionMachine` stays until
  phase 3, because production still runs it.
- Gate: `bun run test:protocol`, `tests/unit/client-state-machines.test.ts`,
  `UpdateMachineTests`.

### Phase 2: Swift runner

- Rename `SourceAdmissionQueue` to `ChangeLog`, and let it carry snapshot,
  structural and review records.
- Make `UpdateCoordinator` effect-driven over the ports.
  - Delete the phase writes, the duplicate flags, the three-way pass choice,
    `UpdateHead` and the legacy snapshot pass.
  - Watch, gap and credential handling become events.
- Add the runner-vector harness.
- Rewrite `docs/implementing-sync-services/update-machine.md` for the runner
  and its ports.
- Gate:
  - the `CanopyWorkingTree` suites and the runner vectors;
  - `LiveSourceAdmissionTests` (renamed with the log);
  - `bun swift/scripts/hosted-smoke.ts`.

### Phase 3: Swift editor on the log

- Add `EditorSource`, and reduce `ArborDocumentBinding` to Quagmire plumbing over it.
- Delete:
  - `DocumentAdmissionMachine`;
  - `EditorRecoveryStore` and its saved markers;
  - the working-tree session's compare-and-swap policy and pending-admission flush.
- Replace `docs/implementing-editors/document-admission.md` with an
  editor-source guide.
- Gate:
  - the `CanopyEditor` suites through `swift/scripts/test-canopy-editor-local.sh`;
  - the hosted smoke;
  - a Mac and iPhone soak covering offline, reconnect, concurrent edits, kill
    during typing, and a held rejection. The soak starts on Joe's go-ahead.

### Phase 4: TypeScript runner and daemon

- Port `ChangeLog` and `UpdateCoordinator` into `@overstory/working-tree`, as a
  browser-safe core with a `node:fs` log under `./node`.
- Pass the runner vectors.
- Rebuild the daemon's synchronization as `FolderSource` plus the runner.
- Delete:
  - the `TreeSynchronizer` loop;
  - the pending and conflict formats in `sync-state.ts`;
  - the conflict workspace and `/v1/conflicts*`;
  - `SourceAdmissionPublisher`;
  - `packages/canopy-web/src/editor-coordinator.ts`.
- Gate:
  - `tests/integration/self-sync.test.ts`, rewritten for held instead of paused;
  - the Arbor Sync integration suites;
  - a daemon soak. Installing the daemon needs Joe's go-ahead.

### Phase 5: hand off to Web 025

The browser uses the TypeScript runner with an IndexedDB `ChangeLog` and a
TypeScript `EditorSource`. Web 025's own phases own the rest.

## Relationships

- [Web 025](../canopy-web/025-arbor-web.md) is the first new client. It should
  not start its editor phase before phase 4.
- [Native 010](../swift/010-client-conflict-review.md) owns review UI and
  drafts. This plan makes submitting a draft an ordinary change-log record.
- [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md)
  adds independent publication while a chain is held. It lands after phase 4.
- [Filesystem 024](../filesystem/024-disk-editors-for-non-tree-folders.md)
  disk editors are not synchronized. They use a guarded write, not this
  machine.
- [Native 011](../swift/011-unify-mac-accounts-and-fold-daemon-clients.md)
  changes who owns daemon routes, not how sync runs.

## Not in scope

- Timer values and backoff curves, beyond one setting per runner.
- Retention of log records beyond what compaction already does.
- Host merge policy (canopyd plans).
