# Arbor: a successor to the web
*Spec overview, v0.6 — the spec is split into topic files under [spec/](spec/). Placeholder names: **Arbor** (the system), **a workspace** (the tree a person sees and works in), **a shared tree** (an independent sync root), **arbord** (the daemon: local workspace + runtime), **TreeHopper** (the browser — web and native), and **the wire** (the shared-tree protocol). All names remain provisional.*

---

## Thesis

Arbor gives each person one local tree. Any folder may be backed by ordinary files, a shared tree, a database, or a connection to an existing store. Different people can place the same shared tree wherever it makes sense to them. Scripts render and change the resulting workspace for humans and agents alike.

**One workspace to navigate and edit; independent shared trees where synchronization, history, or permissions require a boundary; and ordinary TypeScript scripts for turning that workspace into applications.**

Arbord materializes the workspace as ordinary files where appropriate. Agents already know this interface: `ls` is browsing, `cat` is reading, writing a file is editing, and `grep -r` is search. Humans get Finder, editors, the browser, and TreeHopper over the same tree. A Markdown page has one extensionless logical address: `x.md` supplies `/x`'s body while a sibling `x/` supplies its children; when the sibling body is absent, `x/_index.md` is the directory-body fallback. Publishing or sharing a folder can give that subtree an independent identity without changing where it appears in the workspace.

The developer pitch remains familiar: *put Markdown, a SQLite database, or a connection to an existing store in the workspace; write a typed query, a mutation, and a React component; Arbor generates the execution boundary and, when needed, the synchronization boundary.*

Three primary concepts organize the system:

1. **A workspace** is the tree a person or agent sees and works in. It may contain local folders, databases, connections, and mounted shared trees.
2. **A shared tree**, technically a sync root, is a folder with an independent identity, history, synchronization stream, and permission boundary. It may be private, shared with a team, or public.
3. **A script** is a `.tsx` file that reads, renders, or changes parts of a workspace. It may export components, queries, mutations, and actions.

Arbord resolves the workspace from its local folders and mounts. This resolution process is an implementation mechanism, not another user-facing object. The wire moves shared-tree refs and immutable objects without dictating how a workspace or its stores are laid out.

### The model through one ordinary action

Joe begins with `projects/atlas`, an ordinary folder in his workspace. It may contain Markdown, a SQLite database, and a script that renders the project.

When Joe chooses **Share this folder**, Arbor gives that subtree a `TreeID`, revision history, permissions, and a synchronization endpoint. The folder remains at `projects/atlas`; only its backing changes. Alice accepts the invitation and places the same shared tree at `work/atlas`. Joe's and Alice's paths are personal, while edits, history, and access refer to the same shared tree.

If Alice annotates a read-only file, her overlay belongs to her workspace rather than the shared tree. If she opens the script, its queries resolve against the paths she can see and its permissions are intersected with hers. The wire is simply how the two arbords exchange revisions of the shared tree.

## The spec, by file

| File | Covers |
|---|---|
| [spec/format.md](spec/format.md) | On-disk format: Markdown pages and durable IDs, `_index.md`, CSV/JSONL/Markdown collections, database collections via `_store.*`, schemas and generated types, scripts, and sidecars (`Trash/`, `Assets/`, `.arbor/`) |
| [spec/urls.md](spec/urls.md) | Names and URLs: every name form (paths, public names, `tree:` URIs, `system:`/`local:`, fragments), resolution rules, and the legacy bridge |
| [spec/system.md](spec/system.md) | The `system:` tree, workspace resolution, mounts, overlays, visited trees, agent confinement, effective access, and local durability (journal, trash, recovery) |
| [spec/scripts.md](spec/scripts.md) | Script compilation and execution: realms, generated validators, query placement and reactivity, mutations, authority actions, components and consent |
| [spec/browser.md](spec/browser.md) | The browser: navigation, rendering and editing, visiting unmounted trees, agent chat pages |
| [spec/wire.md](spec/wire.md) | Shared trees and the wire: folder → shared tree, `TreeID`s and public names, invitations and grants, refs/objects, sync, the one-replicator rule, collection backing, static publication, eventual delegation |
| [spec/cli.md](spec/cli.md) | The command surface, mapped to build-plan phases |

The reading order above mirrors the model, local to shared: what a workspace contains, how things are named, how mounts and local state work, how scripts operate over the workspace, how humans browse and edit it, and finally how folders become shared trees with identity, access, and synchronization. The build sequence is [plan.md](plan.md); the narrative introduction is [intro.md](intro.md).

## Deferred deliberately

- Public subtree delegation beyond whole-tree DNS aliases.
- Cryptographic/self-certifying `TreeID`s beyond opaque stable IDs and signed descriptors.
- Attenuable capabilities and group identities beyond revocable scoped bearer grants.
- CRDT collaboration beyond CAS plus three-way merge.
- Authority actions and generalized endpoint compute beyond upstream-hosted queries and the minimal reference server.
- Differential/materialized query evaluation behind the arbord interface.
- Logical multi-writer SQLite changesets beyond consistent whole-database snapshots.
- Offline Postgres mirroring beyond live Postgres-backed collections.
- Rendering gateways and standalone non-Apple browsers.
- Discovery indexes as mountable shared trees.
- Userfs/FUSE for huge trees.
- A compiled data-projection UI language (Riffle × SwiftUI lineage; see prior art below) beyond TSX scripts — datalog-style queries, generic non-DOM view primitives, optional explicit state machines. TSX islands may eventually become click-to-load legacy content while these components stay always-live.

## Prior art and cautions

Plan 9/9P supplies per-process namespaces and union mounts. Upspin contributes a global path-shaped namespace but shows the limits of files without an app layer. Notion/Anytype/Tana validate tree-shaped structured content while illustrating the cost of walled identity. Git supplies the ref/object split; atproto demonstrates DNS aliases, Merkle repositories, and relays (its full relationship to Arbor is explored in [social-networking.md](social-networking.md)); IPFS trustless gateways validate verifiable blocks over ordinary HTTP; Willow/Earthstar inform paths, partial sync, and capabilities.

For the app layer: TanStack Start supplies explicit colocated compiler boundaries and typed remote handles; Encore.ts supplies runtime validation generated from TypeScript types; Convex supplies deterministic reactive queries and read-set subscriptions; Astro content collections supply schema-over-files ergonomics; Prisma supplies the client feel. TreeHopper's Clamshell engine supplies the local durability model (write journal, intent reconciliation, soft-delete trash, rename-proof link IDs). Eve and XSLT remain warnings: a theoretically elegant data/UI layer loses if ordinary TypeScript authorship becomes ceremonial.

For the eventual compiled projection language (deferred above): Riffle's reactive-relational model makes UI a subscription to queries over one store; SwiftUI and Xilem show declarative projection without garbage collection via value-semantic view trees and structural identity; Slint proves a deliberately small, AOT-compiled, UI-only DSL is commercially viable, while QML warns that an embedded JavaScript escape hatch becomes the language; Elm proves UI as a pure typed function of state and warns about interop ceremony; Harel statecharts and XState show first-class machine discipline is wanted at the language level; react-native-web motivates a generic primitive vocabulary (`Column`/`Row`/`Text`, not the DOM) so clients need not implement a browser engine.

## Open problems

1. **Shared-tree recovery and endpoint movement.** A stable `TreeID` needs a durable, signed way to refresh endpoint hints without reintroducing a central registry.
2. **Capability UX.** Sharing must feel like sharing a folder while making revocation, local attenuation, and agent grants legible.
3. **Merge semantics.** Structured collections eventually need more than text three-way merge. SQLite snapshots initially conflict as whole databases; logical row changes still face schema and authority invariants.
4. **Determinism discipline.** Query workers must consistently exclude clock, randomness, and I/O across runtime upgrades.
5. **Compiler correctness.** `query`/`mutation` extraction, client-handle replacement, and validator generation from TypeScript types are security-critical, even though the explicit boundary is simpler than general graph slicing.
6. **Schema evolution.** Mounted consumers may remain pinned to old shapes while a shared tree changes schemas.
7. **Consent precision.** Inferred-or-declared prefixes are enforcement-true but coarser than actual runtime read sets; computed paths force broad declarations, and broad permissions must look broad.
8. **Builtin quality.** Weak search/backlink/walk primitives will force user queries into expensive scans.
9. **Reader-wins rendering.** Preventing author dark patterns also removes guaranteed presentation; this is an intentional economic tradeoff.
10. **Moderation.** Distribution follows mounting and sharing; append capabilities and public invitations need anti-spam policy.
11. **Query placement policy.** Placement follows the data, but the edges are open: upstream-hosted results are not client-verifiable the way objects are, offline behavior needs a legible fallback story, mixed-residence read sets need better answers than a diagnostic, and a grant narrower than a query's declared reads complicates the reader's force-local option.
