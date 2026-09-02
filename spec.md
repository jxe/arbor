# Arbor: a successor to the web
*Spec overview, v0.8. The placeholder name **the wire** remains provisional; the system, its independently versioned trees, and first-party clients use the Arbor name.*

## Specification stance

This is the aspirational public contract for Arbor. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [The roadmap](plan/roadmap.md) and [implemented outcomes](plan/history/outcomes.md) own implementation status, direction, and evidence; the [cross-cutting plan indexes](plan/README.md#cross-cutting-workstreams) record known conformance failures by reason.

The specification contains only behavior that must remain portable across independently implemented Arbor components. The [reference documentation](docs/reference-implementation.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Arbor requirements.

The normative surface begins with the representation-independent data model,
then defines its directory projection, locators and their public HTTP projection, Wire synchronization, synchronized configuration, stores/materializations, executable documents, and agents. Local
client/daemon transport, UI controls, CLI commands, runtime algorithms, package
topology, private-state layout, and test machinery are reference choices.

## Thesis

Arbor's global logical space is conceptually a sparse table from `TreeID` to
independently versioned trees. It is a shared identity space, not one enumerable
database or central authority; every device and community sees only the trees it
can locate and access. Canonical URLs form a secondary, forest-shaped lookup:
DNS places a Canopy authority, whose path boundaries select trees. Local,
private, unpublished, and temporarily disconnected trees
remain complete even when absent from that lookup. Each person places the
trees they can reach wherever it makes sense on their own devices. Any folder
may be backed by ordinary files, an Arbor tree, a database, or a safe connection
to an existing store. Executable documents and agents read and change those
placed trees through the same permissioned contracts as human clients.

**Ordinary files and folders to navigate and edit; independent Arbor trees where synchronization, history, or permissions require a boundary; and ordinary authored files for turning those trees into executable documents and agents.**

An authored application is isomorphic across placements. Once synchronization
has settled, the same source tree and logical data roots expose the same nodes,
components, scripts, queries, mutations, constraints, and public results
whether execution uses an expanded filesystem, a local projection, or an
authority materialization. Physical bytes, indexes, query plans, and placement
projection choices are not application semantics.

Five concepts organize the system:

1. The **global TreeID space** maps stable tree identities to logical trees without requiring one global store or discovery service.
2. An **Arbor tree** is an independent `TreeID`, rooted hierarchy of nodes, history, synchronization stream, and whole-tree permission boundary.
3. A **node** has properties, optional authored content, and child membership; document, directory, collection, row, file, and the other roles listed in the [data model](spec/01-data-model.md#4-representing-structured-data) are roles or projections rather than competing kinds.
4. A **canonical URL lookup** first uses DNS to place a Canopy authority, then resolves that Canopy's longest readable registered boundary back to TreeID and path.
5. An **executable document** or **agent** is a node whose reviewed capabilities bound its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable without gaining a durable Arbor identity. Promotion creates an Arbor tree in place: its local path need not move, its canonical public name is replaceable, and `arbor://<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Arbor trees are separate graphs and access boundaries, resolved by the longest readable registered boundary; the normative resolution rule is [wire §4](spec/04-wire.md#4-finding-trees).

## Specification map

| File | Public contract | Status |
|---|---|---|
| [data model](spec/01-data-model.md) | Global TreeID lookup, trees and nodes, DNS/Canopy/path canonical lookup, structured data, projections/materializations, and equivalence | Definitional |
| [directory format](spec/02-directory-format.md) | Filesystem/Markdown projection, `_index.md`, frontmatter, bounded child placement, profile documents, and reserved names | Conformance-backed |
| [locators](spec/03-locators.md) | Uniform tree/path/stable-key references, canonical and relative resolution, revisions, application queries, content fragments, and the public HTTP projection | Conformance-backed |
| [wire](spec/04-wire.md) | Arbor server identity, claims, access, deterministic objects, sync, watch, and executable-document data and effects | Conformance-backed for values, objects, deltas, update identity, endpoints, SSE, and errors; described for queries, mutations, claims, and pairing |
| [configuration](spec/05-configuration.md) | Governed account YAML, devices, placements, ACLs, and semantic merge | Conformance-backed |
| [stores](spec/06-stores.md) | Markdown/CSV/JSON/JSONL/SQLite projections, external stores, and placement materializations | Described; no vectors |
| [executable documents](spec/07-executable-documents.md) | Portable MDX/TSX source, named queries and mutations, React components, identity, confinement, and consent | Described; no vectors |
| [agents](spec/08-agents.md) | Agent files, tools, context, confinement, consent, effects, and transcripts | Sketch |

*Conformance-backed* means the file's exact representations and results are frozen by
vectors under [`conformance`](conformance) that both language bindings decode.
*Described* means the behavior is specified in prose and exercised by reference tests only.
*Sketch* means the shape is settled but not yet the detail an independent implementation
would need.

Language-neutral conformance vectors live in [`conformance`](conformance). The [reference implementation documentation](docs/reference-implementation.md), including the local API, CLI, and client design, is informative rather than normative.

## Component roles

- A **wire host** represents one community and owns profile/account identity, governed private account-configuration trees, canonical boundary records, mutable refs, immutable objects, claims, access enforcement, and watch streams. It does not need local filesystem materialization.
- A **wire client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **store driver** projects the common node/children/query contract onto a
  representation or external store and supplies backing-appropriate
  transactions, observation, schema, and consistent snapshots.
- An **executable-document runtime** renders a reviewed MDX/TSX node at its ordinary Arbor location, injects authenticated Arbor user context, executes its named handles, and streams validated live-query results without exposing the backing data authority.
- An **agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The wire carries tree identity and revisions, including each account's private configuration tree; it does not dictate private indexes, journals, caches, local client/daemon transport, or UI. The synchronized control-file contract is defined in [configuration](spec/05-configuration.md).

## Deferred

These are the behaviors the specification names but does not yet define. Each inline
mention links here; the [roadmap](plan/roadmap.md) owns their sequencing.

1. **Remote tree deletion.** Removing an active remote tree declaration from `trees.yaml` is invalid until a deletion lifecycle exists ([configuration](spec/05-configuration.md#configuration-yaml)).
2. **Cross-server query discovery, delegated authorization, and server-to-server execution routing** ([wire §2.3](spec/04-wire.md#23-relationship-to-tree-synchronization), [executable documents](spec/07-executable-documents.md#queries)).
3. **External side effects and cross-domain workflows** need an effect and consent contract distinct from deterministic collection mutations ([executable documents](spec/07-executable-documents.md#mutations)).
4. **Bidirectional placement projections**: the full-duplex contract behind `mode: bidirectional` ([stores](spec/06-stores.md#postgres-and-placement-projections)).
5. **Database change-log and checkpoint format** for synchronizing SQLite and Postgres placements ([wire §3.3](spec/04-wire.md#33-deterministic-lossless-encoding-and-tree-scoped-authorization)).
6. **Agent frontmatter**: the portable key set for model policy, tools, context, and transcript destination ([agents](spec/08-agents.md#agent-files)).
7. **A relative Markdown link carrying both a stable key and a content fragment** ([locators](spec/03-locators.md#stable-keys-revisions-and-fragments)).
8. **Portable authored ordering, relationships, joins, aggregates, and pagination** in the query language; today they are capability extensions ([executable documents](spec/07-executable-documents.md#queries)).
9. **A capability field that may reference a `system:` address** without making it a content locator ([locators](spec/03-locators.md#forms)).
