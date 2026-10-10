# Client stack

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

The TypeScript and Swift clients are hand-maintained against common
fixtures. Their local Story Sync REST clients speak only the daemon's control
surface (status, trees, accounts, bootstrap, credential, objects, conflicts,
events); there is no local mutation path. Every editor is a direct
working-tree client. Server updates are one retry domain: a confirmed
accepted base plus an append-only string of candidate roots and object
envelopes, with a client-generated change ID per candidate and no separate
idempotency key. Story Sync and the native coordinator each durably retain
their own semantic prefix across retry and restart, with the objects each
request carries, so resubmission never consults a live object store.

Both client state machines default to publication after idle. Captured source
work still awaiting admission keeps publication waiting; separate sessions hold
separate activity claims. They compile
eligible unsent local records into one authored publication; repeated pure moves
retain the original source identity in one final move. The durable mapping from
local changes and operation results to their published names survives retries and
restart. Known branch points end a batch. Late branches across disjoint source
files can continue an already published batch under new durable wire identities;
the original local records remain unchanged. Final object payloads use compact
deltas against the request's accepted basis. A prepared prefix is immutable. Continuous folder sources explicitly
opt into a maximum delay; watch and poll traffic respect active editing bursts.
See [the update machine and runner](../../implementing-sync-services/update-machine.md)
and [editor sources](../../implementing-editors/editor-source.md).

Valid concurrent work is reconciled or retained as accepted ambiguity by the host.
Rejected or unsupported requests remain held with their exact body until the user
discards them; later dependent work stays with that request.

See [implementing sync services](../../implementing-sync-services/README.md) and the [filesystem package](../../../packages/fs/README.md).
