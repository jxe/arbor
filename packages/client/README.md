# @overstory/client

Client-side account plumbing against an Overstory host. The Swift twin is
`OverstoryClient`.

- `account-bootstrap.ts`, `account-client.ts`, `account-pairing.ts`, `ports.ts`:
  claiming and pairing through the host, and the ports a daemon or app
  implements.

The update machine, the change log, and their runner are in
[`@overstory/working-tree`](../working-tree/README.md); Arbor Sync runs them
for each placed folder.
