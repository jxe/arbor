# Clients 001: One update machine for every working tree

Status: phases 0–3 DONE and on `main`; the Mac runs them (evidence in
[status](../../status.md#clients-001-phases-03--2026-09-24)). Remaining: the
iPhone update, which needs Joe's go-ahead; the daemon on the TypeScript runner
(phase 4, runner done); and the Web 025 handoff (phase 5). No priority assigned.

## Outcome

One pure machine decides how every working tree syncs with Overstory. An editor
that captures intent and a folder that captures only bytes feed it the same way:
both append **local changes** to a durable **change log**, and a runner executes
the machine's effects. There is no state machine between an editor and its
working tree. A new client (the browser in [Web 025](../canopy-web/025-arbor-web.md),
a CLI, an agent) picks a source and a set of ports and does not re-derive policy.

What exists, and where it is described:

- The machine: [working-tree updates](../../docs/overstory-spec/09-client-synchronization.md),
  pinned by `docs/overstory-spec/conformance/client-state-machines.json` and
  executed by Swift `UpdateMachine` and TypeScript `reduceUpdate`.
- The Swift runner and change log: [the update machine](../../docs/implementing-sync-services/update-machine.md),
  pinned by the shared runner vectors in `tests/fixtures/update-runner.json`.
- The Swift editor source: [editor sources](../../docs/implementing-editors/editor-source.md).

## Decisions (Joe, 2026-09-24)

1. **One machine.** `UpdateMachine` is the only client synchronization machine.
2. **Editor generations go straight into the change log.** There is no
   recovery journal, admission debounce or second flush step.
3. **Rejection is held.** A definitive rejection keeps the rejected chain and
   stops publishing it until it is discarded. The daemon's conflict workspace
   and `/v1/conflicts*` routes are retired in phase 4.
   [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md)
   becomes a later rule of the held state.
4. **Swift first**, then the TypeScript runner and daemon, then Web 025.

## Remaining work

### Update the iPhone

Needs Joe's go-ahead. Let the installed iPhone app publish everything first:
new builds refuse a control file or review journal that still holds work in
the earlier form, and rewrite nothing. Then install and run the recipes in
[release and soak](../verification/release-and-soak.md).

Open question: working-tree sessions serve no history, so the History sheet
shows an empty state where the recovery store's local copies used to be.

### Phase 4: TypeScript runner and daemon

The package `@overstory/working-tree` (browser-safe core, `./node` for the
file-backed `ChangeLog` and `FileControlStore`), the TypeScript
`UpdateCoordinator`, and its execution of the shared runner vectors are done
([status](../../status.md#clients-001-phase-4-typescript-runner--2026-09-24)).
What remains:

- **`FolderSource`.** A watcher event triggers a debounced scan through the
  stat index (`ObjectIndex`); a root that differs from the change log's tip
  appends a `trace: null` change. The runner's `apply` and `catchUp` write
  accepted bytes to the folder only when the log is settled and the folder
  still equals the tip; otherwise the folder is scanned first (spec 09 rule
  13). The revalidation walk and the bootstrap, credential and object-cache
  loopback services are unchanged.
- **Daemon.** Rebuild Arbor Sync's synchronization as `FolderSource` plus the
  runner, with `pollInterval` replacing the 30 s tick.
- **Delete** the `TreeSynchronizer` loop in `packages/client/src/tree-sync.ts`,
  the pending and conflict formats in `sync-state.ts`, and the conflict
  workspace and `/v1/conflicts*`. An earlier `sync/<tree>.json` with pending
  work or conflict material is refused, not rewritten. The web's
  `packages/canopy-web/src/editor-coordinator.ts` is not dead code
  (`PageEditor.tsx` runs it over the daemon's HTTP API); it goes in phase 5.
- **Gate:** the runner vectors, `tests/integration/self-sync.test.ts`
  (rewritten for held instead of paused), the Arbor Sync integration suites,
  and a daemon soak. Installing the daemon needs Joe's go-ahead.

### Phase 5: hand off to Web 025

The browser uses the TypeScript runner with an IndexedDB `ChangeLog` and a
TypeScript `EditorSource` that follows [editor sources](../../docs/implementing-editors/editor-source.md).
Web 025's own phases own the rest.

## Relationships

- [Web 025](../canopy-web/025-arbor-web.md) is the first new client. It should
  not start its editor phase before phase 4.
- [Native 010](../swift/010-client-conflict-review.md) owns review UI and
  drafts; submitting a draft is an ordinary change-log record.
- [Filesystem 011](../filesystem/011-independent-writes-after-rejection.md)
  adds independent publication while a chain is held, after phase 4.
- [Filesystem 024](../filesystem/024-disk-editors-for-non-tree-folders.md)
  disk editors are not synchronized; they use a guarded write, not this machine.
- [Native 011](../swift/011-unify-mac-accounts-and-fold-daemon-clients.md)
  changes who owns daemon routes, not how sync runs.

## Not in scope

- Timer values and backoff curves, beyond one setting per runner.
- Retention of change-log records beyond what compaction already does.
- Host merge policy (canopyd plans).
