# Implementing editors

An editor integrates with a working tree through document admission. The local
Arbor Sync API provides bootstrap, objects, credentials, and service control;
it is not the editor's publication path.

## Integration order

1. Read the portable [directory format](../overstory-spec/02-directory-format.md), [locators](../overstory-spec/03-locators.md), and [source intent](../overstory-spec/10-source-intent.md) contracts.
2. Implement the [document admission machine](document-admission.md): captured source and basis, durable admission, effects, and recovery.
3. Connect admission to the [working-tree update machine](../implementing-sync-services/update-machine.md) and [client synchronization contract](../overstory-spec/09-client-synchronization.md).
4. Review [Canopy local state](../architecture/canopy-browser/local-state.md) for the reference app's working trees, editor recovery, and admission journals.
5. Run the shared [conformance fixtures](../overstory-spec/conformance/README.md) and the relevant [development gates](../../DEVELOPMENT.md#verification).

## User interaction

- [Reference design](design.md): navigation, editing, identity, sharing, and synchronization.
- [Conflict review for Arbor Sync clients](conflict-review.md): presenting and submitting the daemon's synchronization conflicts. This is distinct from Canopy's accepted-state review.

The [browser architecture](../architecture/canopy-browser/README.md) describes
runtime ownership. [Status](../../status.md) distinguishes the reference design
from implemented and installed behavior.
