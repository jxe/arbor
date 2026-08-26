# Arbor: a successor to the web
*Spec overview, v0.8. Placeholder names—**workspace**, **arbord**, and **the wire**—remain provisional; the system, its independently versioned trees, and first-party clients use the Arbor name.*

## Specification stance

This is the aspirational public contract for Arbor. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [plan/product/roadmap.md](plan/product/roadmap.md) and [plan/records/history.md](plan/records/history.md) own implementation status, sequencing, and evidence; [plan/hardening/technical-debt.md](plan/hardening/technical-debt.md) records known conformance failures.

The specification contains only behavior that must remain portable across independently implemented Arbor components. The [reference documentation](docs/reference-implementation.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Arbor requirements.

The normative surface includes authored formats, locators, synchronized configuration, stores, executable documents and named handles, agents, wire hosting and synchronization, cross-server data and effects, and safe public HTTP projection. Local client/daemon transport, UI controls, CLI commands, runtime algorithms, package topology, private-state layout, and test machinery are reference choices.

## Thesis

Arbor gives each person one navigable workspace. Any folder may be backed by ordinary files, an Arbor tree, a database, or a safe connection to an existing store. Different people may place the same Arbor tree wherever it makes sense to them. Executable documents and agents read and change the resulting workspace through the same permissioned contracts as human clients.

**One workspace to navigate and edit; independent Arbor trees where synchronization, history, or permissions require a boundary; and ordinary authored files for turning that workspace into executable documents and agents.**

Three concepts organize the system:

1. A **workspace** is the resolved tree a person, executable document, or agent can address. It may contain ordinary local paths, stores, and mounted Arbor trees.
2. An **Arbor tree** is an independent `TreeID`, history, synchronization stream, and whole-tree permission boundary.
3. An **executable document** or **agent** is authored content whose declared and effective namespace bounds its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable as `tree: "local"`, without gaining a durable Arbor identity. Promotion creates an Arbor tree in place: its local path need not move, its canonical public name is replaceable, and `arbor://tree/<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Arbor trees are separate graphs and access boundaries, resolved by longest prefix.

## Specification map

| File | Public contract |
|---|---|
| [format](spec/format.md) | Portable authored formats, logical nodes, complete directory documents, profile documents, and reserved names |
| [locators](spec/locators.md) | Tree-relative, canonical, raw-identity, revision, and fragment locators |
| [configuration](spec/configuration.md) | Governed account YAML, devices, placements, ACLs, and semantic merge |
| [stores](spec/stores.md) | Markdown, CSV, JSONL, SQLite, and Postgres collection behavior |
| [executable documents](spec/executable-documents.md) | Portable MDX/TSX source, named queries and mutations, React components, identity, confinement, and consent |
| [agents](spec/agents.md) | Agent files, tools, context, confinement, consent, effects, and transcripts |
| [wire](spec/wire.md) | Community authority, identity, claims, access, deterministic objects, sync, watch, executable-document data and effects, and public HTTP projection |

Language-neutral conformance vectors live in [`conformance`](conformance). The [reference implementation documentation](docs/reference-implementation.md), including the local API, CLI, and client design, is informative rather than normative.

## Component roles

- A **wire host** represents one community and owns profile/account identity, governed private account-configuration trees, canonical boundary records, mutable refs, immutable objects, claims, access enforcement, and watch streams. It does not need local filesystem materialization.
- A **wire client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **store driver** supplies the backing-appropriate reads, transactions, observation, schema, and consistent snapshot needed by the common collection contract.
- An **executable-document runtime** renders a reviewed MDX/TSX node at its ordinary Arbor location, injects authenticated Arbor user context, executes its named handles, and streams validated live-query results without exposing the backing data authority.
- An **agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The wire carries tree identity and revisions, including each account's private configuration tree; it does not dictate private indexes, journals, caches, local client/daemon transport, or UI. The synchronized control-file contract is defined in [configuration](spec/configuration.md).
