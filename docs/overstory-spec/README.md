# Overstory: a successor to the web

*This file is the entry point to the specification. The chapters live in [`docs/overstory-spec/`](), named by layer and chapter; read them in the order of the table below.*
*Spec overview, v0.8. Overstory names the system, its protocol, and its independently versioned trees; Story names the device tools (the app, the `story` command and Story Sync) and overstoryd the reference host.*

## Specification stance

This is the aspirational public contract for Overstory. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [Current status](../../status.md) records what the reference implementation actually does; the [planning index](../../plans/README.md) owns remaining work, and completed plans live in git history.

The specification contains only behavior that must remain portable across independently implemented Overstory components. The [reference documentation](../architecture/README.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Overstory requirements.

The specification is in four layers, each built on the ones below it, and the
file names carry the layer: `1.2-reading-and-watching.md` is layer 1, chapter 2.

1. **Trees.** What a tree is and how it travels: the data model, reading
   and watching (with presence), updates and merging, collections, the schema
   language, and locators. Every host and client agrees on this.
2. **Clients.** How a client holds a tree, and edits one it may write: the
   three ways to hold a tree, the update machine and change log, and
   placements on disk.
3. **Accounts and access.** Who the callers are and what they may do:
   accounts and devices, and access control.
4. **Apps.** Executable documents (views, mutations and agents, with their
   authoring API) and external stores.

A host conforms to layers 1 and 3; a Story-compatible client conforms to
layers 1 to 3. Every route is listed in the [route index](#route-index). Local
client/daemon transport, UI controls, CLI commands, runtime algorithms, package
topology, private-state layout, and test machinery are reference choices.

## Thesis

Overstory's global logical space is conceptually a sparse table from `TreeID` to
independently versioned trees. It is a shared identity space, not one enumerable
database or central authority; every device and community sees only the trees it
can locate and access. Canonical URLs form a secondary, forest-shaped lookup:
DNS places an Overstory host, whose path boundaries select trees. Local,
private, unpublished, and temporarily disconnected trees
remain complete even when absent from that lookup. Each person places the
trees they can reach wherever it makes sense on their own devices. Any folder
may be backed by ordinary files, an Overstory tree, a database, or a safe connection
to an existing store. Executable documents and agents read and change those
placed trees through the same permissioned contracts as human clients.

**Ordinary files and folders to navigate and edit; independent Overstory trees where synchronization, history, or permissions require a boundary; and ordinary authored files for turning those trees into executable documents and agents.**

An authored application is isomorphic across placements. Once synchronization
has settled, the same source tree and logical data roots expose the same nodes,
components, scripts, queries, mutations, constraints, and public results
whether execution uses an expanded filesystem, a local projection, or an
authority materialization. Physical bytes, indexes, query plans, and placement
projection choices are not application semantics.

Five concepts organize the system:

1. The **global TreeID space** maps stable tree identities to logical trees without requiring one global store or discovery service.
2. An **Overstory tree** is an independent `TreeID`, rooted hierarchy of nodes, history, synchronization stream, and whole-tree permission boundary.
3. A **node** has properties, optional authored content, and a logical child set; document, directory, collection, row, file, and the other [node readings](1.1-data-model.md#2-nodes-children-and-readings) are roles rather than competing kinds, while expanded files, collection files, databases, and external stores are interchangeable [representations](1.1-data-model.md#3-representations) where their represented model agrees.
4. A **canonical URL lookup** first uses DNS to place an Overstory host, then resolves that host's longest readable registered boundary back to TreeID and path.
5. An **executable document** or **agent** is a node whose reviewed capabilities bound its reads, writes, tools, and effects.

Ordinary unpromoted files are browsable without gaining a durable Overstory identity. Promotion creates an Overstory tree in place: its local path need not move, its canonical public name is replaceable, and `overstory://<TreeID>/` remains the raw identity locator. Sharing changes its audience and access; it does not establish its storage or synchronization identity. Nested Overstory trees are separate graphs and access boundaries, resolved by the longest readable registered boundary; the normative resolution rule is [locators §5](1.6-locators.md#5-finding-trees).

## Specification map

New readers should start with the non-normative [walkthrough](00-walkthrough.md), which follows one local profile identity through claiming an account, activating trees, editing, watching, adding a collection, and querying it from a page. The numbered files are the normative contract, in reading order.

| Layer | File | Public contract |
|---|---|---|
| 1. Trees | [data model](1.1-data-model.md) | Trees and nodes; the directory, page, file, table and rows objects and their hashes; entry times; which files are pages and bodies; a page with children and its presented headings; reserved names |
| | [reading and watching](1.2-reading-and-watching.md) | Reading a tree, a snapshot, an object or a path; watching; conflicts; encodings; and presence: who else is in a tree, ephemeral, never part of it |
| | [updates and merging](1.3-updates-and-merging.md) | The update route, request identity, results and deltas; authored changes: traces, operations, property operations; acceptance, explicit resolution, and merge rules |
| | [collections](1.4-collections.md) | A folder whose children are rows: what the tree holds, row identity and order, validation and merge |
| | [schema language](1.5-schema-language.md) | Ultimate Schema Language (`.usl`): models, enums, connections and keys; the model, storage (`@`) and presentation (`~`) layers; default views; fingerprints; the relational layout; and limits |
| | [locators](1.6-locators.md) | References by TreeID, path and stable key; canonical names and domains; finding trees; reading at the canonical URL |
| 2. Clients | [working trees](2.1-working-trees.md), with [the update machine's runner](../implementing-sync-services/update-machine.md) | The three ways to hold a tree (Browse, Replica, alongside Story Sync), and the update machine a working tree runs: the change log, one prepared request in flight, one successor, validated apply, held rejections, exact ambiguous recovery, and editor capture |
| | [placements on disk](2.2-placements-on-disk.md) | How a placement writes a tree into a folder: page frontmatter, tree membership and ignore files, and collections as CSV, JSON, Markdown rows or SQLite; local placements |
| 3. Accounts and access | [accounts and devices](3.1-accounts-and-devices.md) | Profile identity, host accounts, placement accounts, tree configurations, device pairing and sessions, and declaring, activating and mounting trees |
| | [access control](3.2-access-control.md) | Resource rules, caller/code constraints, combined execution authority, authentication, guarded updates and watches |
| 4. Apps | [executable documents](4.1-executable-documents.md) | Views, mutations and agents in `.ts`/`.tsx` files and Markdown: addresses, queries, mutations, identity, hosting, confinement, consent, transcripts, data disclosure, and the `overstory/data` and `overstory/ui` authoring API |
| | [external stores](4.2-external-stores.md) | A folder whose rows live in an external database such as Postgres |

The specification map does not report implementation progress. See
[status.md](../../status.md) for that boundary and [`conformance/`](conformance) for
the exact portable fixtures currently shared by the TypeScript and Swift
implementations.

## Conformance

Language-neutral vectors under [`conformance`](conformance) cover descriptors, access, errors, resolution, objects, updates, snapshots, SSE framing and resume, bootstrap idempotency, pairing, configuration merge and governance, activation, and tree-scoped reachability. The [reference implementation documentation](../architecture/README.md), including the local API, CLI, and client design, is informative rather than normative.

The checked-in configuration vectors describe the `tree-config-v1` graph. The
earlier per-account `account-config-v2` grammar is no longer accepted by the
reference runtime; old state requires an offline migration before startup.

## Route index

Every HTTP route an Overstory host exposes, and the section that defines it.

| Route | Defined in |
|---|---|
| `GET /.overstory/health`, `GET /.overstory/integrity`, `GET /.overstory/account`, `GET /.overstory/account/directory` (optional), `GET /.overstory/trees`, `GET /.well-known/overstory[/{path}]` | [locators §5](1.6-locators.md#5-finding-trees) |
| `GET /.overstory/trees/{TreeID}`, `/snapshots/{root}`, `/objects/{hash}` | [reading and watching §1–1.2](1.2-reading-and-watching.md#1-reading-trees) |
| `GET /.overstory/trees/{TreeID}/snapshots/{root}/path/{path}` | [reading and watching §1.2.4](1.2-reading-and-watching.md#124-reading-a-path) |
| `GET /.overstory/trees/{TreeID}/conflicts` | [reading and watching §1.2.3](1.2-reading-and-watching.md#123-reading-conflicts) |
| `GET {canonical URL}{/path}` (Markdown; HTML optional) | [reading at the canonical URL §6](1.6-locators.md#6-reading-at-the-canonical-url) |
| `POST /.overstory/trees/{TreeID}/updates` | [updates and merging §1](1.3-updates-and-merging.md#1-the-update-request) |
| `GET /.overstory/trees/{TreeID}/watch` | [reading and watching §1.1.3](1.2-reading-and-watching.md#113-watching) |
| `GET /.overstory/trees/{TreeID}/presence`, `POST /.overstory/trees/{TreeID}/presence/{PresenceID}[/messages]` | [presence §3.3](1.2-reading-and-watching.md#33-routes) |
| `QUERY /.overstory/trees/{TreeID}/views` | [executable documents §12.1](4.1-executable-documents.md#121-evaluate-and-stream-views) |
| `POST /.overstory/trees/{TreeID}/mutate` | [executable documents §12.2](4.1-executable-documents.md#122-execute-named-mutations) |
| `GET /.overstory/trees/{TreeID}/access` | [access control §4](3.2-access-control.md#4-reading-access) |
| `POST /.overstory/account-challenges`, `PUT /.overstory/accounts` (a new home, or with `profile` a member) | [accounts §1.1–1.4](3.1-accounts-and-devices.md#11-beginning-a-person-identity) |
| `POST /.overstory/pairings`, `PUT /.overstory/pairings/{PairingID}/claim` | [accounts and devices §4](3.1-accounts-and-devices.md#4-device-pairing) |
| `POST /.overstory/device-sessions/challenges`, `POST /.overstory/device-sessions` | [accounts and devices §4.1](3.1-accounts-and-devices.md#41-device-sessions) |

Routes one host calls on another live under `/.overstory/peer/`; no client
needs them:

| Route | Defined in |
|---|---|
| `GET /.overstory/peer/profiles/{ProfileTreeID}/device-keys` | [accounts and devices §4.4](3.1-accounts-and-devices.md#44-published-device-keys) |
| `GET https://{domain}/.overstory/peer/domain-check` | [locators §5.1](1.6-locators.md#51-trees-at-a-persons-domain) |

A host also reads another host's public trees (a remote group's members) with
the ordinary tree reads above. A host's own processes, such as its execution
sidecar, never reach it through a public route.

Authentication headers apply to every route ([access control §2](3.2-access-control.md#2-authentication-and-secrets)); shared read values are introduced with [tree reads §1](1.2-reading-and-watching.md#1-reading-trees), while SSE framing and common errors are in [encoding §2.1](1.2-reading-and-watching.md#21-stream-framing-and-errors).

## Component roles

- A **Overstory host** represents one host and owns its local accounts, allocation policy,
  governed private tree configurations, hosted-tree boundaries,
  mutable refs, immutable objects, claims, access enforcement, and watch
  streams. A profile `TreeID` has one home host, which holds its
  configuration, and may hold placement accounts at other hosts
  ([accounts and devices §1](3.1-accounts-and-devices.md#1-profiles-and-host-accounts));
  no host owns that identity merely because it allocated one of its names. A host
  does not need local filesystem materialization.
- A **Overstory client** resolves community names, transfers deterministic objects, performs compare-and-swap synchronization, and applies access without disclosing credentials or link secrets.
- A **backing adapter** supplies the common node/children primitives from one
  representation or external source, including observation, schema, coherent
  snapshots, and physical commit primitives. The execution runtime owns query
  and transaction semantics.
- An **executable-document runtime** serves a reviewed view at its file's own address, injects authenticated Overstory user context, executes its named handles, and streams validated live-query results without exposing the backing data authority.
- An **agent runtime** supplies the explicitly scoped execution environment described by its authored file. It has no ambient authority beyond that environment.

The protocol carries tree identity and revisions, including each account's private configuration tree; it does not dictate private indexes, journals, caches, local client/daemon transport, or UI. The synchronized control-file contract is defined in [accounts and devices](3.1-accounts-and-devices.md).

## Execution hosts

An execution runtime resolves authored source locators by the ordinary
[resolution rules](1.6-locators.md#4-resolution-rules) and obtains each host-backed
source's accepted state through the ordinary [current-tree read](1.2-reading-and-watching.md#111-reading-the-current-tree)
under its execution token; there is no separate binding route. [executable documents](4.1-executable-documents.md#8-host-and-server-boundaries)
defines execution authority use; [reference sidecar documentation](../architecture/overstoryd/execution-sidecar.md)
owns HTTP forwarding and provider bindings. Implementations
may extract the runtime without preserving the unused legacy query/mutation APIs.

## Deferred

These are the behaviors the specification names but does not yet define. Each
inline mention links here; accepted implementation work is indexed under
[plans](../../plans/README.md), while proposed additions not yet decided are
[spec extensions](../../plans/spec-extensions/README.md).

1. **Remote tree deletion.** Retiring an active remote tree, and with it its configuration, is invalid until a deletion lifecycle exists ([accounts and devices](3.1-accounts-and-devices.md#32-invariants)).
2. **Cross-server query discovery, delegated authorization, and server-to-server execution routing** ([executable documents §12.3](4.1-executable-documents.md#123-relationship-to-tree-synchronization), [executable documents](4.1-executable-documents.md#4-queries)).
3. **External non-tree side effects** need an effect and consent contract distinct from deterministic collection mutations ([executable documents](4.1-executable-documents.md#5-mutations)).
4. **Placement projections of an external store**: a device's private SQLite copy, read-only or two-way (`mode: bidirectional`) ([external stores](4.2-external-stores.md#1-postgres-and-placement-projections)); the earlier designs are kept in [Postgres 001](../../plans/later/postgres-001-postgres-backed-collections.md#read-only-placement-projections-moved-from-spec-06-4-2026-11-11).
5. **External-store change log and checkpoint format** for synchronizing Postgres placements. Logical collections, SQLite projections included, synchronize as row operations with a logical hash ([collections](1.4-collections.md)); an external store has no such form yet ([data model §3](1.1-data-model.md#3-representations)).
6. **Agent frontmatter**: the portable key set for model policy, tools, context, and transcript destination ([executable documents](4.1-executable-documents.md#131-agent-files)).
7. **A Markdown-readable link carrying both a stable key and a content fragment.** The `#overstory-key=` alias has no room for a heading; such a link uses the `;overstory-key=` path suffix, which Overstory resolves but other Markdown readers do not ([locators §2.1](1.6-locators.md#21-links-written-in-markdown)).
8. **Grouping, aggregates other than counts, pagination, and unbounded traversal** in views; today they are capability extensions ([executable documents](4.1-executable-documents.md#4-queries)).
9. **A capability field that may reference a `system:` address** without making it a content locator ([locators](1.6-locators.md#1-forms)).
10. **Additional fine-grained operation families** beyond the resource operations defined in access control. Scoped grants are now specified; exact-state preconditions remain concurrency guards, not permissions ([updates and merging §3.1](1.3-updates-and-merging.md#31-exact-state-preconditions), [access control §4](3.2-access-control.md#4-reading-access)).
11. **Several simultaneous local placements of one TreeID**, including the ownership and conflict rules needed when more than one path is writable.
12. **Placement-specific read-only ceilings** for installations where the same TreeID has several local placements with different effective limits.
13. **Durable pinned placements of immutable historical revisions.** Revision locators remain read-only even when a client later makes them durable.
14. **Reader-local annotation or proposal overlays** that augment a mounted tree without changing the underlying authored content. A nested mount is path composition, not such an overlay.
15. **How a link spells a declared view**: a schema file plus an entry's label ([executable documents §1](4.1-executable-documents.md#1-views-and-their-addresses)).
