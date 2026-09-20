# Overstory documentation

Four kinds of document, kept apart so that none silently becomes the others:
the **specification** owns portable behavior, **status** owns what the
reference implementation does today, **docs** (this directory) own usage and
replaceable implementation choices, and **plans** own remaining work.

## Start here

- [README](../README.md): what Overstory is, how the pieces fit, quickstarts.
- [Introduction](intro.md): the longer argument and the intended end state.
- [Specification](../spec.md): normative portable behavior, in reading order.
- [Status](../status.md): what is implemented, installed, deployed, or only specified.

## Using Overstory

- [CLI reference](cli.md): the `arbor` command, daemon setup, placement, moves, identity, cloud sessions, and safety rules.
- [Deploying a host](../deploy/README.md): Railway and VPS deployment, the canopyd environment, backups, upgrades, and rollback.
- [Migrations](../migrations/README.md): the one-off migration procedure, Railway facts, and the schema history.
- [Development](../DEVELOPMENT.md): setup, verification gates, and Quagmire coordination.

## Reference implementation

- [Reference implementation](reference-implementation.md): every package in both languages, runtime ownership, durability, hosting, and verification.
- [Local system](local-system.md): the data home, native working trees, the editor recovery store, admission journals, diagnostics, daemon supervision, and credentials.
- [Arbor Sync REST API](arborsync-api.md): the loopback client/daemon boundary.
- [Merge tool](merge-tool.md): the merge sidecar, its request contract, operation evaluation, the format support table, and limits.
- [Client state machines](client-state-machines.md): the document admission and working-tree update machines, admission invariants, and trace compaction.
- [Execution sidecar](execution-sidecar.md): the target boundary between canopyd and the executable-document runtime.

## Design

- [Client design](client.md): non-normative interaction design for the Canopy browsers; use status for implementation truth.
- [Plans](../plans/README.md): the outcome menu, the detailed catalog, and open questions.
