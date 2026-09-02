# Arbor: a successor to the web
*Spec overview, v0.8. The placeholder name **the wire** remains provisional; the system, its independently versioned trees, and first-party clients use the Arbor name.*

## Specification stance

This is the aspirational public contract for Arbor. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [The roadmap](plan/roadmap.md) and [implemented outcomes](plan/history/outcomes.md) own implementation status, direction, and evidence; the [cross-cutting plan indexes](plan/README.md#cross-cutting-workstreams) record known conformance failures by reason.

The specification contains only behavior that must remain portable across independently implemented Arbor components. The [reference documentation](docs/reference-implementation.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Arbor requirements.

The normative surface begins with the representation-independent data model,
including the canonical encoding of a tree; then synchronization, the routes
that read, update, and watch a tree; then the directory projection, locators and their
public HTTP projection, accounts and devices, access control, stores,
executable documents and agents, and the authoring API. Every route is listed
in the [route index](#route-index). Local
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
3. A **node** has properties, optional authored content, and child membership; document, directory, collection, row, file, and the other roles listed in the [data model](spec/01-data-model.md#4-one-node-shape-for-every-kind-of-data) are roles or projections rather than competing kinds.
4. A **canonical URL lookup** first uses DNS to place a Canopy authority, then resolves that Canopy's longest readable registered boundary back to TreeID and path.
5. An **executable document** or **agent** is a node whose reviewed capabilities bound its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable without gaining a durable Arbor identity. Promotion creates an Arbor tree in place: its local path need not move, its canonical public name is replaceable, and `arbor://<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Arbor trees are separate graphs and access boundaries, resolved by the longest readable registered boundary; the normative resolution rule is [locators §5](spec/04-locators.md#5-finding-trees).

## Specification map

New readers should start with the non-normative [walkthrough](spec/00-walkthrough.md), which follows one account through claiming a profile, activating a tree, editing, watching, adding a collection, and querying it from a page. The numbered files are the normative contract, in reading order.

| File | Public contract | Status |
|---|---|---|
| [data model](spec/01-data-model.md) | Global TreeID lookup, trees and nodes, canonical lookup, one node shape for every kind of data, change and equivalence, the canonical encoding of a tree with its deltas, and the shared values | Definitional for §1–5; conformance-backed for the encoding, deltas, and values |
| [synchronization](spec/02-synchronization.md) | What a server is and must implement; the routes that read, update, and watch a tree; transitions and replay; streams and errors | Conformance-backed for update identity, endpoints, SSE, and errors |
| [directory format](spec/03-directory-format.md) | Filesystem/Markdown projection, `_index.md`, frontmatter, bounded child placement, and reserved names | Conformance-backed |
| [locators](spec/04-locators.md) | Uniform tree/path/stable-key references, canonical and relative resolution, revisions, application queries, content fragments, the routes that find trees, and the public HTTP projection | Conformance-backed |
| [accounts and devices](spec/05-accounts-and-devices.md) | Profiles, the profile claim, the governed account-configuration tree and its YAML, device pairing, placements, tree activation, and the `account-config-v1` merge rule | Conformance-backed for the YAML; described for claims and pairing |
| [access control](spec/06-access-control.md) | Access subjects and rules, authentication and secrets, tree-scoped authorization, and the `access` route | Conformance-backed for values; described otherwise |
| [stores](spec/07-stores.md) | Markdown/CSV/JSON/JSONL/SQLite projections, external stores, and placement materializations | Described; no vectors |
| [executable documents](spec/08-executable-documents.md) | Execution model for MDX/TSX documents and agents: named handles, queries, mutations and their routes, identity, hosting, confinement, consent, and transcripts | Described; no vectors (agents: sketch) |
| [authoring API](spec/09-authoring-api.md) | The `arbor/react` and `arbor/data` packages, React Actions, hooks, and styling a document is written against | Library contract, versioned with the packages |

*Conformance-backed* means the file's exact representations and results are frozen by
vectors under [`conformance`](conformance) that both language bindings decode.
*Described* means the behavior is specified in prose and exercised by reference tests only.
*Sketch* means the shape is settled but not yet the detail an independent implementation
would need.

## Conformance

Language-neutral vectors under [`conformance`](conformance) cover descriptors, access, errors, resolution, objects, updates, snapshots, SSE framing and resume, bootstrap idempotency, pairing, configuration merge and governance, activation, and tree-scoped reachability. The [reference implementation documentation](docs/reference-implementation.md), including the local API, CLI, and client design, is informative rather than normative.

## Route index

Every HTTP route an Arbor server exposes, and the section that defines it.

| Route | Defined in |
|---|---|
| `GET /.arbor/health`, `GET /.arbor/account`, `GET /.arbor/trees`, `GET /.well-known/arbor[/{path}]` | [locators §5](spec/04-locators.md#5-finding-trees) |
| `GET /.arbor/trees/{TreeID}/ref`, `/snapshot`, `/objects/{hash}` | [synchronization §2](spec/02-synchronization.md#2-reading-a-tree) |
| `POST /.arbor/trees/{TreeID}/updates` | [synchronization §3](spec/02-synchronization.md#3-updating-a-tree) |
| `GET /.arbor/trees/{TreeID}/watch` | [synchronization §4](spec/02-synchronization.md#4-watching-a-tree) |
| `QUERY /.arbor/trees/{TreeID}/queries` | [executable documents §12.1](spec/08-executable-documents.md#121-evaluate-and-stream-named-queries) |
| `POST /.arbor/trees/{TreeID}/mutate` | [executable documents §12.2](spec/08-executable-documents.md#122-execute-named-mutations) |
| `GET /.arbor/trees/{TreeID}/access` | [access control §4](spec/06-access-control.md#4-reading-access) |
| `PUT /.arbor/claims/{handle}` | [accounts §1.1](spec/05-accounts-and-devices.md#11-profile-claim) |
| `POST /.arbor/pairings`, `PUT /.arbor/pairings/{PairingID}/claim` | [accounts §4](spec/05-accounts-and-devices.md#4-device-pairing) |

Authentication headers apply to every route ([access control §2](spec/06-access-control.md#2-authentication-and-secrets)); shared values, SSE framing, and the error envelope are in [data model §7](spec/01-data-model.md#7-shared-values) and [synchronization §5](spec/02-synchronization.md#5-streams-and-errors).

## Component roles

- A **wire host** represents one community and owns profile/account identity, governed private account-configuration trees, canonical boundary records, mutable refs, immutable objects, claims, access enforcement, and watch streams. It does not need local filesystem materialization.
- A **wire client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **store driver** projects the common node/children/query contract onto a
  representation or external store and supplies backing-appropriate
  transactions, observation, schema, and consistent snapshots.
- An **executable-document runtime** renders a reviewed MDX/TSX node at its ordinary Arbor location, injects authenticated Arbor user context, executes its named handles, and streams validated live-query results without exposing the backing data authority.
- An **agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The wire carries tree identity and revisions, including each account's private configuration tree; it does not dictate private indexes, journals, caches, local client/daemon transport, or UI. The synchronized control-file contract is defined in [configuration](spec/05-accounts-and-devices.md).

## Deferred

These are the behaviors the specification names but does not yet define. Each inline
mention links here; the [roadmap](plan/roadmap.md) owns their sequencing.

1. **Remote tree deletion.** Removing an active remote tree declaration from `trees.yaml` is invalid until a deletion lifecycle exists ([configuration](spec/05-accounts-and-devices.md#3-configuration-yaml)).
2. **Cross-server query discovery, delegated authorization, and server-to-server execution routing** ([executable documents §12.3](spec/08-executable-documents.md#123-relationship-to-tree-synchronization), [executable documents](spec/08-executable-documents.md#4-queries)).
3. **External side effects and cross-domain workflows** need an effect and consent contract distinct from deterministic collection mutations ([executable documents](spec/08-executable-documents.md#5-mutations)).
4. **Bidirectional placement projections**: the full-duplex contract behind `mode: bidirectional` ([stores](spec/07-stores.md#4-postgres-and-placement-projections)).
5. **Database change-log and checkpoint format** for synchronizing SQLite and Postgres placements ([data model §6](spec/01-data-model.md#6-the-canonical-encoding-of-a-tree)).
6. **Agent frontmatter**: the portable key set for model policy, tools, context, and transcript destination ([executable documents](spec/08-executable-documents.md#131-agent-files)).
7. **A relative Markdown link carrying both a stable key and a content fragment** ([locators](spec/04-locators.md#2-stable-keys-revisions-and-fragments)).
8. **Portable authored ordering, relationships, joins, aggregates, and pagination** in the query language; today they are capability extensions ([executable documents](spec/08-executable-documents.md#4-queries)).
9. **A capability field that may reference a `system:` address** without making it a content locator ([locators](spec/04-locators.md#1-forms)).
10. **A write grant limited to `ifMatch: "modelHash"`.** An update matching on the bytes hash can replace a tree's exact state; one matching on model hashes can only contribute to it. `AccessLevel` does not yet distinguish the two ([synchronization §3](spec/02-synchronization.md#3-updating-a-tree), [access control §4](spec/06-access-control.md#4-reading-access)).
