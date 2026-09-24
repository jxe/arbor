# @overstory/client

Client-side synchronization against an Overstory host. The Swift twin is
`OverstoryClient`.

- `tree-sync.ts`, `sync-state.ts`: the daemon's folder synchronizer for one
  placed tree, until [Clients 001](../../plans/clients/001-reconcile-client-state-machines.md)
  phase 4 rebuilds it on `@overstory/working-tree`.
- `account-bootstrap.ts`, `account-wire.ts`, `account-pairing.ts`, `ports.ts`:
  claiming and pairing through the host, and the ports a daemon or app
  implements.

The update machine, the change log, and their runner are in
[`@overstory/working-tree`](../working-tree/README.md).
