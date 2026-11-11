# Overstory: a successor to the web

*This file is the entry point to the specification. The chapters live in [`docs/overstory-spec/`](), named by layer and chapter; read them in the order of the table below.*
*Spec overview, v0.8. Overstory names the system, its protocol, and its independently versioned trees; Story names the device tools (the app, the `story` command and Story Sync) and overstoryd the reference host.*

## Specification stance

This is the aspirational public contract for Overstory. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [Current status](../../status.md) records what the reference implementation actually does; the [planning index](../../plans/README.md) owns remaining work, and completed plans live in git history. Wire forms the reference implementation has not reached yet arrive together at one flag day, Protocol 003, listed in [Protocol 001](../../plans/soon/protocol-001-spec-review-route-changes.md) and [Protocol 003](../../plans/soon/protocol-003-times-in-directory-entries.md).

The specification contains only behavior that must remain portable across independently implemented Overstory components. The [reference documentation](../architecture/README.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Overstory requirements.

The specification is in three layers, each built on the ones below it, and the
file names carry the layer: `1.2-reading-and-watching.md` is layer 1, chapter 2.

1. **Trees.** What a tree is and how it travels: the data model, reading
   and watching (with presence and views), updates and merging (with
   mutations), collections, VAD, and locators. Every host and client agrees
   on this.
2. **Clients.** How a client holds a tree, and edits one it may write: the
   three ways to hold a tree, the update machine and change log, and
   placements on disk.
3. **Accounts, access and federation.** Who the callers are and what they
   may do: accounts and devices, access control, and acting at hosts other
   than a profile's home.
A host conforms to layers 1 and 3, and to the `views` and `mutate` routes when it runs
apps; a Story-compatible client conforms to layers 1 to 3. Every route is listed in the [route index](#route-index). Local
client/daemon transport, UI controls, CLI commands, runtime algorithms, package
topology, private-state layout, and test machinery are reference choices.

## Thesis

Overstory's global space is a sparse table from `TreeID` to independently
versioned trees. It is a shared identity space, not one enumerable database or
central authority: every device and community sees only the trees it can
locate and read. Canonical URLs are a secondary lookup: DNS places an
Overstory host, whose path boundaries select trees. Local, private and
disconnected trees stay complete without it, and each person places the trees
they can reach wherever suits them on their own devices.

**Ordinary files and folders to navigate and edit; independent Overstory trees where synchronization, history, or permissions require a boundary; and ordinary authored files for turning those trees into apps.**

Four ideas organize the system:

1. An **Overstory tree** is a `TreeID`-rooted hierarchy of nodes with its own
   history, synchronization stream and permission boundary. Trees nest by
   mounting, each still a separate graph and access boundary.
2. A **node** has properties, optional content, and children. Page, folder,
   collection, row and file are [readings of a node](1.1-data-model.md#2-nodes-children-and-readings),
   not competing kinds, and expanded files, collection files and SQLite are
   interchangeable [representations](1.1-data-model.md#3-representations) of
   the same model.
3. A **canonical URL** is found by DNS, then by the host's longest readable
   mount boundary ([locators §5](1.6-locators.md#5-finding-trees)). It can be
   renamed; `overstory://<TreeID>/` cannot.
4. An **app** is ordinary files in a tree: tables, views and mutations written in VAD, a
   declarative language, so every read is a plan a host can see. They run as
   their caller, bounded by [access control](3.2-access-control.md), and mean
   the same whichever placement or host runs them.

## Specification map

New readers should start with the non-normative [walkthrough](00-walkthrough.md), which follows one local profile identity through claiming an account, activating trees, editing, watching, adding a collection, and querying it from a page. The numbered files are the normative contract, in reading order.

| Layer | File | Public contract |
|---|---|---|
| 1. Trees | [data model](1.1-data-model.md) | Trees and nodes; the directory, page, file, table and rows objects and their hashes; entry times; which files are pages and bodies; a page with children and its presented headings; reserved names |
| | [reading and watching](1.2-reading-and-watching.md) | Reading a tree, a snapshot, an object or a path; watching; conflicts; encodings; presence: who else is in a tree, ephemeral, never part of it; and the `views` route, with answer forms, plans and live dependencies |
| | [updates and merging](1.3-updates-and-merging.md) | The update route, request identity, results and deltas; authored changes: traces, operations, property operations; acceptance, explicit resolution, and merge rules; and the `mutate` route |
| | [collections](1.4-collections.md) | A folder whose children are rows: what the tree holds, row identity and order, validation and merge |
| | [VAD](1.5-vad.md) | VAD, the views-and-data language (`.vad` files, view blocks, a collection's `schema.vad`): tables, connections and keys, with data, storage (`@`) and presentation (`~`) layers; views, state, rules, mutations and expressions; collection views; fingerprints; the relational layout; handles and code versions; the grammar |
| | [locators](1.6-locators.md) | References by TreeID, path and stable key; canonical names and domains; finding trees; reading at the canonical URL; view addresses |
| 2. Clients | [working trees](2.1-working-trees.md), with [the update machine's runner](../implementing-sync-services/update-machine.md) | The three ways to hold a tree (Browse, Replica, alongside Story Sync), and the update machine a working tree runs: the change log, one prepared request in flight, one successor, validated apply, held rejections, exact ambiguous recovery, and editor capture |
| | [placements on disk](2.2-placements-on-disk.md) | How a placement writes a tree into a folder: page frontmatter, tree membership and ignore files, and collections as CSV, JSON, Markdown rows or SQLite; local placements |
| 3. Accounts, access and federation | [accounts and devices](3.1-accounts-and-devices.md) | Profile identity, host accounts, tree configurations, device pairing and sessions, and declaring, activating and mounting trees |
| | [access control](3.2-access-control.md) | Resource rules, caller/code constraints, combined execution authority, authentication, guarded updates and watches; what views and mutations may read and write, user identity, consent and data disclosure |
| | [federation](3.3-federation.md) | Home and placement hosts, placement accounts, invitations accepted as placements, published device keys, and visitor sessions |

The specification map does not report implementation progress. See
[status.md](../../status.md) for that boundary and [`conformance/`](conformance) for
the exact portable fixtures currently shared by the TypeScript and Swift
implementations.

## Conformance

Language-neutral vectors under [`conformance`](conformance) cover descriptors, access, errors, resolution, objects, updates, snapshots, SSE framing and resume, bootstrap idempotency, pairing, configuration merge and governance, activation, and tree-scoped reachability. The [reference implementation documentation](../architecture/README.md), including the local API, CLI, and client design, is informative rather than normative.

The checked-in configuration vectors describe the `tree-config-v1` graph.

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
| `QUERY /.overstory/trees/{TreeID}/views` | [reading and watching §4](1.2-reading-and-watching.md#4-views) |
| `POST /.overstory/trees/{TreeID}/mutate` | [updates and merging §4](1.3-updates-and-merging.md#4-mutations) |
| `POST /.overstory/challenges` (purpose `account`, `placement` or `session`), `PUT /.overstory/accounts` (a new home, or a placement) | [accounts and devices §1.2](3.1-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key), [federation §3](3.3-federation.md#3-accepting-an-invitation-as-a-placement) |
| `POST /.overstory/pairings`, `PUT /.overstory/pairings/claim` | [accounts and devices §4](3.1-accounts-and-devices.md#4-device-pairing) |
| `POST /.overstory/device-sessions` | [accounts and devices §4.1](3.1-accounts-and-devices.md#41-device-sessions) |

Routes one host calls on another live under `/.overstory/peer/`; no client
needs them:

| Route | Defined in |
|---|---|
| `GET /.overstory/peer/profiles/{ProfileTreeID}/device-keys` | [federation §4](3.3-federation.md#4-published-device-keys) |
| `GET https://{domain}/.overstory/peer/domain-check` | [locators §5.1](1.6-locators.md#51-trees-at-a-persons-domain) |

A host also reads another host's public trees (a remote group's members) with
the ordinary tree reads above.

Authentication headers apply to every route ([access control §2](3.2-access-control.md#2-authentication-and-secrets)); shared read values are introduced with [tree reads §1](1.2-reading-and-watching.md#1-reading-trees), while SSE framing and common errors are in [encoding §2.1](1.2-reading-and-watching.md#21-stream-framing-and-errors).

## Component roles

- An **Overstory host** owns its accounts, the private tree configurations it
  governs, its hosted trees' boundaries and accepted history, their objects,
  access enforcement and watch streams. A profile has one home host, which
  holds its configuration, and may have placement accounts at others
  ([federation](3.3-federation.md)). A host needs no files on disk in the
  shape of its trees.
- An **Overstory client** finds trees, transfers objects, keeps a working tree
  in sync through the update machine ([working trees](2.1-working-trees.md)),
  and never discloses credentials or link secrets.
- An **app runtime** serves a view at its node's own address, passes it the
  caller's user context, runs its mutations, and streams validated results
  without exposing the data behind them ([reading and watching §4](1.2-reading-and-watching.md#4-views)).

The protocol does not dictate private indexes, journals, caches, local
client/daemon transport, or UI.

## Deferred

These are the behaviors the specification names but does not yet define. Each
inline mention links here; accepted implementation work is indexed under
[plans](../../plans/README.md), while proposed additions not yet decided are
[spec extensions](../../plans/spec-extensions/README.md).

1. **Remote tree deletion.** Retiring an active remote tree, and with it its configuration, is invalid until a deletion lifecycle exists ([accounts and devices](3.1-accounts-and-devices.md#32-invariants)).
2. **Cross-server plan discovery, delegated authorization, and server-to-server execution routing** ([updates and merging §4.1](1.3-updates-and-merging.md#41-relationship-to-tree-synchronization), [reading and watching §4.2](1.2-reading-and-watching.md#42-plans-and-live-dependencies)).
3. **External non-tree side effects** need an effect and consent contract distinct from deterministic collection mutations ([VAD](1.5-vad.md#4-mutations)).
4. **Hosted agents**: apps whose body is a prompt, with their tools, confinement and transcripts ([Apps 002](../../plans/later/apps-002-overstoryd-hosted-agents.md)).
5. **A Markdown-readable link carrying both a stable key and a content fragment.** The `#overstory-key=` alias has no room for a heading; such a link uses the `;overstory-key=` path suffix, which Overstory resolves but other Markdown readers do not ([locators §2.1](1.6-locators.md#21-links-written-in-markdown)).
6. **Grouping beyond expansion, aggregates beyond `count`, `sum`, `min` and `max`, pagination, and unbounded traversal** in views; today they are capability extensions ([reading and watching §4.2](1.2-reading-and-watching.md#42-plans-and-live-dependencies)).
7. **A capability field that may reference a `system:` address** without making it a content locator ([locators](1.6-locators.md#1-forms)).
8. **Additional fine-grained operation families** beyond the resource operations defined in access control. Exact-state preconditions are concurrency guards, not permissions ([updates and merging §3.1](1.3-updates-and-merging.md#31-exact-state-preconditions), [access control §3.2](3.2-access-control.md#32-updates-and-guards)).
9. **Several simultaneous local placements of one TreeID**, including the ownership and conflict rules needed when more than one path is writable.
10. **Placement-specific read-only ceilings** for installations where the same TreeID has several local placements with different effective limits.
11. **Durable pinned placements of immutable historical revisions.** Revision locators remain read-only even when a client later makes them durable.
12. **Reader-local annotation or proposal overlays** that augment a mounted tree without changing the underlying authored content. A nested mount is path composition, not such an overlay.
