# Arbor documentation

Arbor separates portable contracts, current implementation status, usage, product design, active plans, and history so that one document does not silently become all of them.

## Start here

- [README](../README.md) — concise pitch and working local/Canopy quickstarts.
- [Current status](../status.md) — what is implemented, partial, or only specified.
- [Introduction](../intro.md) — the longer argument and intended end state.
- [Specification](../spec.md) — normative portable behavior in numbered reading order.

## Usage and operation

- [CLI](cli.md) — the implemented `arbor` command surface and safety rules.
- [Canopy deployment](../deploy/README.md) — local/public hosting, persistent storage, backup, restoration, and coordinated upgrades.
- [Development](../DEVELOPMENT.md) — repository layout, setup, testing, and local verification.

## Reference implementation and product design

- [Consolidated update contract](update-wire-contract.md) — target specification, paired models and coordinated implementation boundary.

- [Merge executable](merge-tool.md) — shared immutable objects, staged rule evaluation, process failures and execution modes.
- [Reference implementation](reference-implementation.md) — package boundaries, runtime ownership, durability, hosting, clients, and verification machinery.
- [Local system](local-system.md) — local data home, private state, watchers, visits, credentials, and migration.
- [Local Arbor REST API](arborsync-api.md) — the implemented loopback client/daemon boundary.
- [Client design](client.md) — non-normative web/native interaction design; use `status.md` for implementation truth.
- [Conflict terms experiment](conflict-terms-experiment.md) — isolated Jujutsu-style backend, preservation counterexample, tested behavior, and integration limits.
- [Conflict intent comparison](conflict-intent-comparison.md) — seven thought experiments, a source-intent model, and the distinction between operation identity and a full content graph.
- [Client state machines](client-state-machines.md) — the document admission machine every Arbor Sync editor runs, and where it meets the direct Canopy machine in the specification.

## Planning and history

- [Active plans](../plans/README.md) — project indexes, maintenance themes, and unresolved questions.
- [Completed evidence](../plans/_done/README.md) — completed, rejected, and superseded work.
- [Notes](notes/social-networking.md) — exploratory arguments that are neither specification nor status.
- [Archive](archive/arbord-projection-outline.md) — historical implementation outlines retained for context.

- [Protocol-ready source intent](protocol-ready.md) — current operation boundary and coordinated upgrade procedure.

- [Protocol cutover preparation](protocol-cutover-preparation.md) — integrated build/rehearsal evidence and the remaining joint cutover.

- [Execution sidecar boundary](execution-sidecar.md): target HTTP forwarding, execution-token use, and provider enforcement; implementation is planned in Apps 005.
