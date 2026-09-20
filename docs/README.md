# Overstory documentation

Four kinds of document, kept apart so that none silently becomes the others:
the **specification** owns portable behavior, **status** owns what the
reference implementation does today, **docs** (this directory) own usage and
replaceable implementation choices, and **plans** own remaining work.

## Start here

- [README](../README.md): what Overstory is, how the pieces fit, quickstarts.
- [Introduction](intro.md): the longer argument and the intended end state.
- [Specification](../spec/README.md): normative portable behavior, in reading order.
- [Status](../status.md): what is implemented, installed, deployed, or only specified.
- [Architecture](architecture.md): every package in both languages, runtime ownership, protocol identity, durability, and verification.
- [State machines](state-machines.md): the document admission and working-tree update machines every editor and the daemon run, admission invariants, trace compaction.
- [Development](../DEVELOPMENT.md): setup, ownership, change discipline, gates.

## By component

**Overstory protocol.** The spec is the documentation; its executable half is
[`spec/conformance/`](../spec/conformance/README.md).

**Host (canopyd)**

- [Deploying a host](../packages/canopyd/deploy/README.md): Railway and VPS deployment, the canopyd environment, backups, upgrades, rollback.
- [Migrations](../packages/canopyd/migrations/README.md): the one-off migration procedure, Railway facts, the schema history.
- [Merge tool](canopyd/merge-tool.md): the merge sidecar, its request contract, operation evaluation, the format support table, limits.
- [Execution sidecar](canopyd/execution-sidecar.md): the target boundary between canopyd and the executable-document runtime.

**Client stack**

- [State machines](state-machines.md): the document admission and working-tree update machines, admission invariants, trace compaction.

**Arbor Sync and the `arbor` command**

- [CLI reference](arborsync/cli.md): the `arbor` command, daemon setup, placement, moves, identity, cloud sessions, safety rules.
- [Arbor Sync REST API](arborsync/arborsync-api.md): the loopback client/daemon boundary.
- [The Arbor data home](arborsync/data-home.md): the data home, daemon supervision, watching, credentials, migration, diagnostics.

**Canopy browsers**

- [Design](canopy/design.md): non-normative interaction design for the browsers; use status for implementation truth.
- [Canopy local state](canopy/local-state.md): working trees on iOS and the Mac, the editor recovery store, admission journals, diagnostic streams.

Remaining work for every component is in [plans](../plans/README.md).
