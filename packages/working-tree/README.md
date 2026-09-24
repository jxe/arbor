# @overstory/working-tree

One working tree's synchronization: its local changes, the durable change log
they are appended to, the update machine that decides when and how the log is
published, and the runner that performs what the machine decides. The Swift
twin is `CanopyWorkingTree`.

The root entry point is browser-safe:

- `update-machine.ts`: `reduceUpdate`, the one pure reducer every working
  tree runs, whether its local changes carry editor intent or are folder
  snapshots. It executes `working-tree-updates` in
  `docs/overstory-spec/conformance/client-state-machines.json`.
- `local-change.ts`: `LocalChange` and its preparation from a source edit
  (`prepareSourceChange`), a page creation, or entry actions; trace
  compaction.
- `entry-transfer.ts`: entry move, copy, and action preparation.
- `control.ts`: the runner's durable `UpdateControl` record (the same schema
  as Swift's) and its exact `UpdateAttempt`.
- `coordinator.ts`: `UpdateCoordinator`, the runner, over a change log, a
  control store, a transport, and an accepted tree.

`./node` adds the file-backed `ChangeLog` (`sync/change-log.json`) and
`FileControlStore` (`sync/update-control.json` and `sync/events.jsonl`).

The machine is specified in
[working-tree updates](../../docs/overstory-spec/09-client-synchronization.md);
the runner is described in
[the update machine](../../docs/implementing-sync-services/update-machine.md).
`tests/unit/update-runner.test.ts` executes the runner vectors
`tests/fixtures/update-runner.json`, which the Swift runner also executes.
