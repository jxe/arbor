# Clients 001: Reconcile the client state machines with the clients that run them

Status: NEEDS DESIGN. No priority assigned. Changes the portable machines in
[spec 09](../../docs/overstory-spec/09-client-synchronization.md), their
conformance vectors, both reducers, and the Swift and TypeScript runners.

## Outcome

The two client state machines, **document admission** (an editor against its
working tree) and **working-tree updates** (a working tree against Overstory),
become the place where sync policy lives. Their states and effects describe what good clients
actually need, and every client executes their effects faithfully. A new client, such as the browser
([Web 025](../canopy-web/025-arbor-web.md)), a CLI or an agent, then gets the hard-won practices
by implementing a small set of effects rather than re-deriving them from the Swift runner.
Where a runner does something better than the machine, the machine learns it; where
the machine is better, the runner adopts it; what neither needs is deleted.

## Why now

The machines are specified and pinned by
[`client-state-machines.json`](../../docs/overstory-spec/conformance/client-state-machines.json),
and both reducers pass those scenarios. But the clients mostly run beside them rather than through them.
Audit of 2026-09-23 (line numbers as of that date):

### Working-tree updates

- **TypeScript: nothing in production calls `reduceUpdate`** (`packages/client/src/update-machine.ts`);
  only `publicationTip` is used. The daemon's `TreeSynchronizer` (`packages/client/src/tree-sync.ts`)
  runs its own loop.
- **Swift's `UpdateCoordinator` calls the reducer but decides most things itself.**
  - It never dispatches `watch`, `watchGap`, `credentialsRefreshed` or `transportAvailable(false)`.
  - It ignores the `submit`, `apply`, `catchUp` and `stop` effects, and ignores `persistRequest`'s base and candidate.
  - It writes `machine.phase`/`machine.base` directly in about seven places.
  - It enforces one-in-flight with its own `syncActive`/`syncAgain`/`inFlight`/`terminal`/`transportAvailable` flags.
  - Status comes from `control.presentation`, not the machine, and `machine.base` goes stale on catch-up.
  - The source-journal path reports every error, including authentication and validation, as `transportFailed`.
- **The two runtimes differ from each other as well as from the spec:**

| Behaviour | Spec'd machine | Swift coordinator | Daemon `TreeSynchronizer` |
|---|---|---|---|
| Publication delay | 250 ms trailing / 1 s max | Uses the machine's timers | None; 30 s poll plus watch hints |
| Durable head before publication | Rule 1 | Yes (`UpdateHead`) | No; snapshot at pass time |
| Successor after a merged acceptance | Rule 4 prefix plus successor | Fresh single request against the old base | Rule 4 (`appendPendingTreeSuccessor`) |
| Transport vs authentication vs validation failure | Distinct (rule 9) | Distinct on the snapshot path; all "transport" on the source path | Not distinguished; retried on the next tick |
| Retry after a failure while "online" | Automatic | Waits for a watch, path change or explicit sync | Next 30 s tick |
| Watch reconnect backoff | Unspecified | 250 ms → 5 s | 1 s → 30 s |
| Conflicted acceptance | Ordinary acceptance (rule 8) | Accepted-choice review outside the machine | Conflict workspace; clears pending; pauses the tree |
| Re-seeded tree (rule 12) | Specified | Implemented | Not applicable |
| Unsupported operation | Unspecified | Terminal | Latched per pending identity |
| Freshness poll | Unspecified | None | Every 30 s |

### Document admission

- **TypeScript: nothing in the built product runs `reduceAdmission`.** Its only caller is the
  unbuilt `canopy-web` coordinator, which targets an API that no longer exists. The TS machine cannot carry
  captured patches, unlike the Swift one, so captured frames are not pinned by the shared fixture.
- **Swift's `ArborDocumentBinding` runs the reducer but departs from it.**
  - It never dispatches `retry`. `stop` does nothing.
  - `mergeLocally` only publishes a conflict to the UI; the actual local merge is in `ArborDocumentConflictAnalysis`.
  - It sets phase or accepted directly in five places.
  - Production uses the retained-basis policy, so `conflict`, `resolveConflict` and `mergeLocally` are unreachable in the product.
  - Observed-while-dirty is unreachable too, because the runner drops live updates whenever the mounted tree differs from accepted.
- **Practices the binding encodes that the machine does not know about:**
  - The exact-bytes recovery journal and its saved markers.
  - Per-generation patches captured against the predecessor's ledger, validated by replay, with a byte-diff fallback.
  - Guards for keystrokes the editor has not committed yet, in three places.
  - A second host-level inactivity delay, in `ArborEditorHost`.
  - A snapshot cache so that `apply`/`acknowledge` can find full snapshots.
  - Self-acknowledgement without reparsing, which preserves selection and undo.
  - Read-your-writes re-reads under an anchor.
  - A two-step flush: settle the machine, then `session.flush()`.
- **Arbor Sync's disk edits use no admission machine.** Its HTTP editor writes are plain
  compare-and-swap on `baseRevision`.

### Documentation that overstates

- `docs/implementing-sync-services/update-machine.md` says the daemon runs the machine.
- `update-machine.ts` says every durable store maps onto its states. `UpdateCoordinator.swift` says "the machine owns scheduling".
- The conformance README and spec README mention adoption scenarios that the fixture does not contain.
- The conformance README says a rejected admission "runs the host's local merge helper".
- The document-admission guide describes a web coordinator that is not built.
- `UpdateMachine.swift`'s header uses retired names.

## Principles

1. **The machine decides; the runner performs.** A runner turns I/O results into events and
   executes every effect it is given. It does not set the phase, and it keeps no parallel flags that
   duplicate a machine rule. State that a runner must keep to perform an effect, such as caches,
   ledgers or file handles, is fine; state that decides *what happens next* belongs in the machine.
2. **Adopt what the clients learned.** A runner behaviour that is deliberate, tested and
   still wanted becomes machine vocabulary with a conformance scenario. Examples include pass
   coalescing, extending a hanging request, re-seed, accepted-while-moved, polling and backoff, and
   uncommitted-input capture. Behaviour kept only for history is deleted instead.
3. **Delete what nobody needs.** A state, event or effect that no client needs after this review
   is removed from the spec, the vectors and both reducers together, per the
   [change discipline](../../DEVELOPMENT.md#change-discipline).
4. **Portable versus replaceable.** Spec 09 keeps the observable contract: what may be sent, when
   bytes are durable, and what a conflict means. Timer values, backoff curves and journal layouts
   stay in the implementation guides unless interoperability depends on them. Do not move
   implementation detail into the spec.
5. **Make the easy path the correct one.** The effect list is the checklist a new client
   implements. Each effect names its inputs completely, so no runner has to reconstruct a base from its
   own durable state, as `persistRequest` forces today.

## Design questions to settle first

Record each answer in this plan before any code changes.

1. **One machine per concern, or a pipeline?** Today there are editor input, document admission,
   the source-admission queue (`SourceAdmissionQueue`, with its own `publicationTip`), the
   update machine, and accepted-choice review publication, which sits entirely outside the machine. Decide which of these are
   machines with vectors and which are runner detail, and write down the hand-offs between them.
2. **Is the placed folder a working tree running the update machine?** Spec 09 says so, but the
   daemon does not. Either make `TreeSynchronizer` a runner of `reduceUpdate`, with the folder
   watcher producing `localHead` events, or narrow the spec's claim and specify the folder
   client separately. [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md)
   touches the same rejection path.
3. **Conflicts.** Decide what the machine does with conflicted acceptance. Swift's
   accepted-choice review and the daemon's conflict workspace, which clears pending and pauses the tree,
   disagree with each other and with rule 8. Decide whether review publication becomes a machine
   state or effect. Coordinate with [Native 010](../swift/010-client-conflict-review.md).
4. **Document-admission conflicts.** Production uses retained-basis sessions, so conflict,
   resolve and merge-locally are reachable only in tests and legacy drafts. Keep them as a policy
   for other hosts, or remove them. If kept, `mergeLocally` should carry what a client needs to
   pre-fill a merge, which native computes in its UI today.
5. **Durability and recovery.** Decide whether the editor recovery journal (checkpoint, saved marker, replay on open) is
   machine vocabulary, with effects like `checkpoint` and `markSaved`, or a runner obligation
   described in the guide. The same question applies to the update runner's durable head and attempt.
6. **Failure taxonomy and retry.** Transport, authentication, validation and unsupported
   operation need one classification and one retry rule, including automatic retry while the network is still online and
   credential refresh, which neither runner implements.
7. **Inputs that are not yet events.** Decide how uncommitted editor input, live updates while dirty, watch gaps and
   periodic freshness enter the machines. Today each is handled ad hoc, or dropped.

## Steps

1. **Correct the documentation now.** This is independent of the design and can land first. Fix the
   overstated claims listed above, including the stale adoption references and the `UpdateMachine.swift` header,
   so the docs describe what runs today. Run `bun run check:links` and `git diff --check`.
2. **Decision table.** For every row in the two audit sections above, record one of **adopt into
   machine**, **remove from machine**, **keep in runner (guide)** or **fix runner to match**, with
   a one-line reason. Answer the design questions. Review this with Joe before step 3.
3. **Revise the machines.** Change spec 09, `client-state-machines.json`, `UpdateMachine` /
   `DocumentAdmissionMachine` (Swift) and `reduceUpdate` / `reduceAdmission` (TypeScript) in one
   change per machine. Include the captured-patch representation in the TypeScript admission machine and in
   `fixtureRepresentation`, so frames are pinned by the shared fixture. Gate: `bun run test:protocol`, the Swift
   `UpdateMachineTests` / admission tests, and the TypeScript `client-state-machines` tests.
4. **Make the Swift runners effect-driven.**
   - `UpdateCoordinator` executes every effect and stops writing `machine.phase` or keeping duplicate flags. Its presentation is derived from machine state.
   - `ArborDocumentBinding` stops mutating phase or accepted directly.
   - Gate: the full `CanopyWorkingTree` and `CanopyEditor` suites, the hosted smoke
     (`bun swift/scripts/hosted-smoke.ts`), and a Mac and iPhone soak of editing across offline, reconnect and
     conflicting edits.
5. **Settle the folder client** according to design question 2. Either run the daemon's
   synchronization through `reduceUpdate`, or document it as a distinct client with its own
   contract. Gate: `tests/integration/self-sync.test.ts` and the Arbor Sync integration suites.
6. **Runner conformance.** Add shared vectors that drive a *runner* with a fake transport and a fake
   session, then check which effects it performed and the resulting durable state. The
   existing vectors only pin the reducers. Execute them from Swift and from TypeScript.
7. **Hand off to Web 025.** Its browser runner uses the TypeScript runners from steps 5–6
   rather than porting `ArborDocumentBinding` and `UpdateCoordinator` by hand.

## Relationships

- [Web 025](../canopy-web/025-arbor-web.md) is the first new client, and the strongest reason to finish
  steps 3–6 before it needs admission and update runners.
- [Native 011](../swift/011-unify-mac-accounts-and-fold-daemon-clients.md) changes who owns
  daemon routes, not how sync runs; this plan does not depend on it.
- [Native 010](../swift/010-client-conflict-review.md) owns the accepted-choice review UI. This
  plan owns how review publication relates to the update machine.
- [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md) owns independent
  writes after rejection in the folder client. Settle its rules together with design question 2.

## Not in scope

- Timer values and backoff curves, beyond making them one runner setting rather than two.
- Retention or pruning of recovery revisions, event logs and control files.
- Merge policy on the host (canopyd plans).
