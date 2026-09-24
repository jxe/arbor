# Clients 001: One update machine for every working tree

Status: phases 0–4 DONE, on `main`, and running on Joe's Mac (evidence in
[status](../../status.md#clients-001-phase-4-typescript-runner-and-daemon--2026-09-24)).
Remaining: the iPhone update, which needs Joe's go-ahead, and a run of the
Hetzner sync lab. Showing held folders in the Mac app is
[Native 012](../swift/012-show-held-folders.md); the browser client is
[Web 025](../canopy-web/025-arbor-web.md). No priority assigned.

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
- The TypeScript runner in `@overstory/working-tree`, which Arbor Sync runs
  once per placed folder (`FolderSync`), described in the same guide.

## Decisions (Joe, 2026-09-24)

1. **One machine.** `UpdateMachine` is the only client synchronization machine.
2. **Editor generations go straight into the change log.** There is no
   recovery journal, admission debounce or second flush step.
3. **Rejection is held.** A definitive rejection keeps the rejected chain and
   stops publishing it until it is discarded. The daemon's conflict workspace
   and `/v1/conflicts*` routes are retired (phase 4).
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

### Run the Hetzner sync lab

`packages/canopyd/deploy/hcloud-sync-lab` has not run since the daemon moved to
the update machine. Its binary scenario now expects Canopy to accept both
versions as an unresolved alternative instead of a daemon conflict.

## Relationships

- [Web 025](../canopy-web/025-arbor-web.md) is the first new client, on the
  TypeScript runner.
- [Native 012](../swift/012-show-held-folders.md) shows held folders in the
  Mac app.
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
