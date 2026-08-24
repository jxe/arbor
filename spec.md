# Arbor: a successor to the web
*Spec overview, v0.8. Placeholder names—**workspace**, **arbord**, and **the wire**—remain provisional; the system, its independently versioned trees, and first-party clients use the Arbor name.*

## Specification stance

This is the aspirational public contract for Arbor. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [plan/product/roadmap.md](plan/product/roadmap.md) and [plan/records/history.md](plan/records/history.md) own implementation status, sequencing, and evidence; [plan/hardening/technical-debt.md](plan/hardening/technical-debt.md) records known conformance failures.

Requirements apply to the component they name. An implementation need not provide every Arbor component, but a component it does claim to provide must satisfy that component's specification. For example, a wire-only host need not implement a local workspace or human client, and a conforming human client may use a wholly different UI from Arbor web or native Arbor.

The normative surface includes authored formats, locators, `trees.yaml`, local server and client behavior, stores, scripts, agents, the CLI, wire hosting and synchronization, and safe public HTTP projection. Language/runtime choices, UI controls, package topology, retry counts, journal layout, and test machinery are reference choices unless a topic specification explicitly makes their observable behavior portable.

## Thesis

Arbor gives each person one navigable workspace. Any folder may be backed by ordinary files, an Arbor tree, a database, or a safe connection to an existing store. Different people may place the same Arbor tree wherever it makes sense to them. Scripts and agents read and change the resulting workspace through the same permissioned contracts as human clients.

**One workspace to navigate and edit; independent Arbor trees where synchronization, history, or permissions require a boundary; and ordinary authored files for turning that workspace into applications and agents.**

Three concepts organize the system:

1. A **workspace** is the resolved tree a person, script, or agent can address. It may contain ordinary local paths, stores, and mounted Arbor trees.
2. An **Arbor tree** is an independent `TreeID`, history, synchronization stream, and whole-tree permission boundary.
3. A **script** or **agent** is an authored file whose declared and effective namespace bounds its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable as `tree: "local"`, without gaining a durable Arbor identity. Promotion creates an Arbor tree in place: its local path need not move, its canonical public name is replaceable, and `arbor://tree/<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Arbor trees are separate graphs and access boundaries, resolved by longest prefix.

## Specification map

| File | Public contract |
|---|---|
| [format](spec/format.md) | Portable authored formats, logical nodes, complete directory documents, profile documents, and reserved names |
| [locators](spec/locators.md) | Local, canonical, raw-identity, revision, fragment, and `system:` locators |
| [system](spec/system.md) | Arbor data home, `trees.yaml`, placements, `system:` records, local durability, visits, and nested mounts |
| [arbord REST](spec/arbord-rest.md) | REST v1 schemas, resolution, reads, mutations, receipts, errors, events, and conformance rules |
| [client](spec/client.md) | Client resolution, exact-source preservation, provenance, retry/resync, secrets, and persistence authority |
| [stores](spec/stores.md) | Markdown, CSV, JSONL, SQLite, and Postgres collection behavior |
| [scripts](spec/scripts.md) | Script authoring, compilation boundaries, queries, mutations, components, confinement, and consent |
| [agents](spec/agents.md) | Agent files, tools, context, confinement, consent, effects, and transcripts |
| [wire](spec/wire.md) | Community authority, identity, claims, access, deterministic objects, sync, watch, and public HTTP projection |
| [CLI](spec/cli.md) | Portable command surface for browsing, synchronization, serving, scripts, and deployment |

Language-neutral conformance vectors live in [spec/fixtures](spec/fixtures). [Arbor's client interaction design](docs/arbor-client.md) and the [reference implementation architecture](docs/reference-implementation.md) are informative, not normative.

## Component roles

- A **local arbord** resolves the local filesystem and placements, owns durable authored mutations, exposes loopback REST v1, manages local credentials without exposing them as content, and synchronizes placed Arbor trees.
- An **arbord client** consumes REST v1 and treats arbord as the persistence authority. It may be a human UI, CLI, script host, agent host, backup tool, or another program.
- A **wire host** represents one community and owns profile/account identity, canonical boundary records, mutable refs, immutable objects, claims, access entries, and watch streams. It does not need local filesystem materialization.
- A **wire client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **store driver** supplies the backing-appropriate reads, transactions, observation, schema, and consistent snapshot needed by the common collection contract.
- A **script or agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The wire carries shared-tree identity and revisions; it does not dictate private local indexes, journals, caches, or UI. The only standardized local control file is `trees.yaml`, together with the Arbor data-home selection rule.
