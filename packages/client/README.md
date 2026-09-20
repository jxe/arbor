# @overstory/client

Client-side synchronization against an Overstory host. The Swift twin is
`OverstoryClient` together with `CanopyWorkingTree`.

- `tree-sync.ts`, `sync-state.ts`: pulling and pushing one placed tree.
- `update-machine.ts`: the working-tree update machine, a pure reducer that
  executes `spec/conformance/client-state-machines.json` (`working-tree-updates`).
- `document-admission.ts`: the document admission machine an editor runs
  against its working tree (`document-admission` in the same fixture).
- `source-admission-queue.ts`, `source-admission-publisher.ts`,
  `source-document-session.ts`: the durable admission journal, publication
  and settlement, and read-your-writes sessions.
- `account-bootstrap.ts`, `account-wire.ts`, `ports.ts`: claiming and pairing
  through the host, and the ports a daemon or app implements.
- `entry-transfer.ts`: entry move, copy, and action preparation.

The machines and their invariants are described in
[client state machines](../../docs/canopy/document-admission.md).
