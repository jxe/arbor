# @overstory/client

Client-side synchronization against an Overstory host. The Swift twin is
`OverstoryClient` together with `CanopyWorkingTree`.

- `tree-sync.ts`, `sync-state.ts`: pulling and pushing one placed tree.
- `update-machine.ts`: the working-tree update machine, the one pure reducer
  every working tree runs, whether its local changes carry editor intent or
  are folder snapshots. It executes
  `docs/overstory-spec/conformance/client-state-machines.json` (`working-tree-updates`).
- `source-admission-queue.ts`, `source-admission-publisher.ts`,
  `source-document-session.ts`: the durable admission journal, publication
  and settlement, and read-your-writes sessions.
- `account-bootstrap.ts`, `account-wire.ts`, `ports.ts`: claiming and pairing
  through the host, and the ports a daemon or app implements.
- `entry-transfer.ts`: entry move, copy, and action preparation.

The machine is specified in
[working-tree updates](../../docs/overstory-spec/09-client-synchronization.md);
its runner is described in [the update machine](../../docs/implementing-sync-services/update-machine.md).
