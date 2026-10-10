# Implementing sync services

Overstory hosts accept and serve tree state. Synchronizing clients retain their
own working trees and publish durable changes. Story Sync is the reference local
filesystem synchronizer, with a separate loopback API for local clients.

## Shared contracts

1. Start with the [specification walkthrough](../overstory-spec/00-walkthrough.md) and [tree operations](../overstory-spec/01-tree-operations.md) for objects, accepted updates, exact retries, and observation.
2. Implement [accounts and devices](../overstory-spec/04-accounts-and-devices.md), [access control](../overstory-spec/05-access-control.md), and [locator resolution](../overstory-spec/03-locators.md).
3. For synchronizing clients, follow [client synchronization](../overstory-spec/09-client-synchronization.md), the [update machine](update-machine.md), and [source intent](../overstory-spec/10-source-intent.md).
4. Verify against the [portable conformance fixtures](../overstory-spec/conformance/README.md) and [cross-language protocol gate](../../DEVELOPMENT.md#verification).

## Implementation guides

- [The update machine and its coordinator](update-machine.md): reference reducers, durable requests, watching, recovery, and timing.
- [Local placements](local-placements.md): reference YAML layout and platform working-tree ownership.

## Reference services

- [Story Sync REST API](story-sync-api.md): loopback status, trees, bootstrap, objects, accounts, held changes, and observation; includes reference fixture pointers.
- [Story Sync architecture](../architecture/story-sync/README.md): placed-folder ownership, daemon services, and private state.
- [Client stack](../architecture/client-stack/README.md): retained requests and conflict recovery.
- [overstoryd architecture](../architecture/overstoryd/README.md): authoritative acceptance, merge and execution sidecars, and durability.
- [Deploying overstoryd](../../packages/overstoryd/deploy/README.md) and [migrations](../../packages/overstoryd/migrations/README.md): operating the reference host.

Use [status](../../status.md) for implementation coverage. Portable requirements
belong in the specification; service internals belong in architecture.
