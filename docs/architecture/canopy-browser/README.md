# Canopy browsers

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**The Canopy app** runs `CanopyWorkingTree` directly: the document admission
machine makes each edit durable in the working tree and the update
coordinator publishes durable heads to the host. On iOS the working tree is on
disk; on the Mac it is in memory, seeded from the daemon's `GET /v1/bootstrap`
and backed by its `/v1/objects` route. The layouts are in
[the local system](local-state.md#native-working-trees).

See [local state and recovery](local-state.md) and [implementing editors](../../implementing-editors/README.md).
