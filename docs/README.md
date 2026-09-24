# Overstory documentation

## Reading paths

| Section | What belongs here |
|---|---|
| [Getting started](getting-started/README.md) | Introduction, quickstarts, CLI usage, and development setup |
| [Overstory specification](overstory-spec/README.md) | Normative portable behavior and shared conformance fixtures |
| [Implementing editors](implementing-editors/README.md) | Editor integration, editor sources, interaction design, and held folder changes |
| [Implementing sync services](implementing-sync-services/README.md) | Host and synchronizer contracts, local service APIs, and implementation verification |
| [Architecture](architecture/README.md) | Reference implementation choices, organized by subcomponent |

The specification defines portable requirements, including behavior not yet
implemented. The other four sections describe usage and replaceable implementation
choices. [Status](../status.md) owns what is implemented, installed, deployed,
or manually verified; [plans](../plans/README.md) contain remaining work only.

Deployment and migration procedures live beside the host in
[`packages/canopyd/deploy/`](../packages/canopyd/deploy/README.md) and
[`packages/canopyd/migrations/`](../packages/canopyd/migrations/README.md).
Repository working rules remain in [DEVELOPMENT.md](../DEVELOPMENT.md).
