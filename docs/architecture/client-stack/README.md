# Client stack

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

The TypeScript and Swift clients are hand-maintained against common
fixtures. Their local Arbor Sync REST clients speak only the daemon's control
surface (status, trees, accounts, bootstrap, credential, objects, conflicts,
events); there is no local mutation path. Every editor is a direct
working-tree client. Server updates are one retry domain: a confirmed
accepted base plus an append-only string of candidate roots and object
envelopes, with a client-generated change ID per candidate and no separate
idempotency key. Arbor Sync and the native coordinator each durably retain
their own semantic prefix across retry and restart, with the objects each
request carries, so resubmission never consults a live object store.

When canopyd returns a conflict for an update string, the client keeps the
exact prepared request as durable conflict state: the `completed` prefix is
already processed, `failedIndex` identifies the element under review, and
the suffix remains unattempted. Resolution submits the reviewed element
against the verified current descriptor, then guardedly replays the retained
suffix in order. The machines, their invariants, and trace compaction are in
[editor sources](../../implementing-editors/editor-source.md).

See [implementing sync services](../../implementing-sync-services/README.md) and the [filesystem package](../../../packages/fs/README.md).
