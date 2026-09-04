# Arbor: a successor to the web
*Spec overview, v0.8. The placeholder name **the wire** remains provisional; the system, its independently versioned trees, and first-party clients use the Arbor name.*

## Specification stance

This is the aspirational public contract for Arbor. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [Current status](status.md) records what the reference implementation actually does; [implemented outcomes](plans/_done/outcomes.md) preserve evidence, and the [planning index](plans/README.md) owns remaining work.

The specification contains only behavior that must remain portable across independently implemented Arbor components. The [reference documentation](docs/reference-implementation.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Arbor requirements.

The normative surface begins with tree reads, updates, watching, and editor
round trips, introducing the logical model and canonical lossless Wire values
inside those operations; then the directory projection, locators and their public HTTP projection,
accounts and devices, access control, child backings,
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
3. A **node** has properties, optional authored content, and a logical child set; document, directory, collection, row, file, and the other [node readings](spec/01-tree-operations.md#nodes-children-and-readings) are roles rather than competing kinds, while expanded files, collection files, databases, and external stores are interchangeable [representations](spec/01-tree-operations.md#representations) where their represented model agrees.
4. A **canonical URL lookup** first uses DNS to place a Canopy authority, then resolves that Canopy's longest readable registered boundary back to TreeID and path.
5. An **executable document** or **agent** is a node whose reviewed capabilities bound its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable without gaining a durable Arbor identity. Promotion creates an Arbor tree in place: its local path need not move, its canonical public name is replaceable, and `arbor://<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Arbor trees are separate graphs and access boundaries, resolved by the longest readable registered boundary; the normative resolution rule is [locators §5](spec/03-locators.md#5-finding-trees).

## Specification map

New readers should start with the non-normative [walkthrough](spec/00-walkthrough.md), which follows one local profile identity through claiming an account, activating trees, editing, watching, adding a collection, and querying it from a page. The numbered files are the normative contract, in reading order.

| File | Public contract |
|---|---|
| [tree operations](spec/01-tree-operations.md) | Logical and exact-byte reads; updates and writes; watching and replay; editor round trips; and the model and Wire types each operation needs |
| [directory format](spec/02-directory-format.md) | Filesystem/Markdown projection, `_index.md`, frontmatter, bounded child placement, and reserved names |
| [locators](spec/03-locators.md) | Uniform tree/path/stable-key references, canonical and relative resolution, revisions, application queries, content fragments, discovery routes, and public HTTP projection |
| [accounts and devices](spec/04-accounts-and-devices.md) | Local-first profile identity, Canopy accounts and community-defined allocation, governed account configuration, account-local device pairing, local placements, and tree activation |
| [access control](spec/05-access-control.md) | Access subjects and rules, authentication and secrets, tree-scoped authorization, and the access route |
| [child backings](spec/06-child-backings.md) | How expanded files, collection files, SQLite, Postgres, and placement projections supply child sets; backing revisions, snapshots, observation, and physical commit behavior |
| [executable documents](spec/07-executable-documents.md) | MDX/TSX documents and agents: named handles, queries, mutations, identity, hosting, confinement, consent, transcripts, and Wire operations |
| [authoring API](spec/08-authoring-api.md) | The `arbor/react` and `arbor/data` packages, React Actions, hooks, and styling an executable document is written against |

The specification map does not report implementation progress. See
[status.md](status.md) for that boundary and [`conformance/`](conformance) for
the exact portable fixtures currently shared by the TypeScript and Swift
implementations.

## Conformance

Language-neutral vectors under [`conformance`](conformance) cover descriptors, access, errors, resolution, objects, updates, snapshots, SSE framing and resume, bootstrap idempotency, pairing, configuration merge and governance, activation, and tree-scoped reachability. The [reference implementation documentation](docs/reference-implementation.md), including the local API, CLI, and client design, is informative rather than normative.

The checked-in configuration vectors describe the revised three-file
`account-config-v2` graph. The old `account-config-v1` grammar remains only in
its named runtime compatibility parser and future offline migration fixtures;
it is not a valid v2 authored graph.

## Route index

Every HTTP route an Arbor server exposes, and the section that defines it.

| Route | Defined in |
|---|---|
| `GET /.arbor/health`, `GET /.arbor/account`, `GET /.arbor/trees`, `GET /.well-known/arbor[/{path}]` | [locators §5](spec/03-locators.md#5-finding-trees) |
| `GET /.arbor/trees/{TreeID}`, `/snapshots/{root}`, `/objects/{hash}` | [tree reads §1.1–1.2](spec/01-tree-operations.md#1-reading-trees) |
| `POST /.arbor/trees/{TreeID}/updates` | [updates §2.1](spec/01-tree-operations.md#21-the-update-request) |
| `GET /.arbor/trees/{TreeID}/watch` | [watching §1.1.3](spec/01-tree-operations.md#113-watching) |
| `QUERY /.arbor/trees/{TreeID}/queries` | [executable documents §12.1](spec/07-executable-documents.md#121-evaluate-and-stream-named-queries) |
| `POST /.arbor/trees/{TreeID}/mutate` | [executable documents §12.2](spec/07-executable-documents.md#122-execute-named-mutations) |
| `GET /.arbor/trees/{TreeID}/access` | [access control §4](spec/05-access-control.md#4-reading-access) |
| `POST /.arbor/account-challenges`, `PUT /.arbor/accounts` | [accounts §1.1–1.2](spec/04-accounts-and-devices.md#11-beginning-a-person-identity) |
| `POST /.arbor/pairings`, `PUT /.arbor/pairings/{PairingID}/claim` | [accounts §5](spec/04-accounts-and-devices.md#5-device-pairing) |

Authentication headers apply to every route ([access control §2](spec/05-access-control.md#2-authentication-and-secrets)); shared read values are introduced with [tree reads §1.1](spec/01-tree-operations.md#1-reading-trees), while SSE framing and common errors are in [encoding §4.2](spec/01-tree-operations.md#42-stream-framing-and-errors).

## Component roles

- A **wire host** represents one Canopy and owns its local accounts, allocation policy,
  governed private account-configuration trees, hosted-tree boundaries,
  mutable refs, immutable objects, claims, access enforcement, and watch
  streams. A profile `TreeID` may be referenced by accounts at other Canopies;
  no host owns that identity merely because it allocated one of its names. A host
  does not need local filesystem materialization.
- A **wire client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **backing adapter** supplies the common node/children primitives from one
  representation or external source, including observation, schema, coherent
  snapshots, and physical commit primitives. The execution runtime owns query
  and transaction semantics.
- An **executable-document runtime** renders a reviewed MDX/TSX node at its ordinary Arbor location, injects authenticated Arbor user context, executes its named handles, and streams validated live-query results without exposing the backing data authority.
- An **agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The wire carries tree identity and revisions, including each account's private configuration tree; it does not dictate private indexes, journals, caches, local client/daemon transport, or UI. The synchronized control-file contract is defined in [configuration](spec/04-accounts-and-devices.md).

## Deferred

These are the behaviors the specification names but does not yet define. Each
inline mention links here; accepted implementation work is indexed under
[plans](plans/README.md), while unresolved design questions remain in
[open questions](plans/open-questions.md).

1. **Remote tree deletion.** Removing an active remote tree declaration from `trees.yaml` is invalid until a deletion lifecycle exists ([configuration](spec/04-accounts-and-devices.md#3-configuration-yaml)).
2. **Cross-server query discovery, delegated authorization, and server-to-server execution routing** ([executable documents §12.3](spec/07-executable-documents.md#123-relationship-to-tree-synchronization), [executable documents](spec/07-executable-documents.md#4-queries)).
3. **External side effects and cross-domain workflows** need an effect and consent contract distinct from deterministic collection mutations ([executable documents](spec/07-executable-documents.md#5-mutations)).
4. **Bidirectional placement projections**: the full-duplex contract behind `mode: bidirectional` ([child backings](spec/06-child-backings.md#4-postgres-and-placement-projections)).
5. **Database change-log and checkpoint format** for synchronizing SQLite and Postgres placements ([child backings §1.1](spec/06-child-backings.md#11-child-backings)).
6. **Agent frontmatter**: the portable key set for model policy, tools, context, and transcript destination ([executable documents](spec/07-executable-documents.md#131-agent-files)).
7. **A relative Markdown link carrying both a stable key and a content fragment** ([locators](spec/03-locators.md#2-stable-keys-revisions-and-fragments)).
8. **Portable authored ordering, relationships, joins, aggregates, and pagination** in the query language; today they are capability extensions ([executable documents](spec/07-executable-documents.md#4-queries)).
9. **A capability field that may reference a `system:` address** without making it a content locator ([locators](spec/03-locators.md#1-forms)).
10. **A write grant limited to `ifMatch: "modelHash"`.** An update matching on the bytes hash can replace a tree's exact state; one matching on model hashes can only contribute to it. `AccessLevel` does not yet distinguish the two ([updates §2.2](spec/01-tree-operations.md#22-what-the-write-matches), [access control §4](spec/05-access-control.md#4-reading-access)).
11. **Several simultaneous local placements of one TreeID**, including the ownership and conflict rules needed when more than one path is writable.
12. **Placement-specific read-only ceilings** for installations where the same TreeID has several local placements with different effective limits.
13. **Durable pinned placements of immutable historical revisions.** Revision locators remain read-only even when a client later makes them durable.
14. **Reader-local annotation or proposal overlays** that augment a mounted tree without changing the underlying authored content. A nested mount is path composition, not such an overlay.
