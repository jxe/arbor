# Arbor: a successor to the web
*Spec overview, v0.7 — the spec is split into topic files under [spec/](spec/). Placeholder names: **Arbor** (the system), **a workspace** (the tree a person sees and works in), **a shared tree** (an independent sync root), **arbord** (the daemon: local workspace + runtime), **TreeHopper** (the browser — web and native), and **the wire** (the shared-tree protocol). All names remain provisional.*

---

## Specification stance

This spec describes the complete Arbor system we intend to demonstrate, including features beyond the current implementation. It is not a claim that every described feature is built; [plan.md](plan.md) records current status and build order.

Completeness does not mean future-proofing. The spec chooses concrete reference behavior for the clients, daemon, stores, scripts, mounts, and wire that it actually describes. It does not add plugin systems, compatibility matrices, universal identifiers, capability negotiation, production administration, or generic abstraction layers merely because some later implementation might want them.

Deferred items may remain absent forever. But machinery required by a specified feature is not optional: scripts require isolation, shared trees require scoped grants and revocation, synchronization requires deterministic object encoding and conflict behavior, and authored local writes require durable acknowledgement and lossless observation.

## Thesis

Arbor gives each person one local tree. Any folder may be backed by ordinary files, a shared tree, a database, or a connection to an existing store. Different people can place the same shared tree wherever it makes sense to them. Scripts render and change the resulting workspace for humans and agents alike.

**One workspace to navigate and edit; independent shared trees where synchronization, history, or permissions require a boundary; and ordinary TypeScript scripts for turning that workspace into applications.**

TreeHopper browses the entire local filesystem as one navigable tree; the workspace is not a navigation boundary. Arbor intelligence — indexing, durable identity, recovery, and later mounts, sync, and sharing — activates per subtree: tracked roots, schema-marked collections, and eventually mounted or visited shared trees come alive where they are found, and the plain untracked filesystem remains fully browsable and editable as the degenerate no-tree case ([urls.md](spec/urls.md) §2).

Arbord materializes the workspace as ordinary files where appropriate. Agents already know this interface: `ls` is browsing, `cat` is reading, writing a file is editing, and `grep -r` is search. Humans get Finder, editors, the browser, and TreeHopper over the same tree. A Markdown document has one extensionless logical address: `x.md` supplies `/x`'s stored body while a sibling `x/` supplies its children; when the sibling body is absent, `x/_index.md` is the directory-body fallback. TreeHopper projects the stored or implicit body together with every immediate child, so every directory is a complete document without browsing having to create `_index.md`. Publishing or sharing a folder can give that subtree an independent identity without changing where it appears in the workspace.

The developer pitch remains familiar: *put Markdown, a SQLite database, or a connection to an existing store in the workspace; write a typed query, a mutation, and a React component; Arbor generates the execution boundary and, when needed, the synchronization boundary.*

Three primary concepts organize the system:

1. **A workspace** is the tree a person or agent sees and works in. It may contain local folders, databases, connections, and mounted shared trees.
2. **A shared tree**, technically a sync root, is a folder with an independent identity, history, synchronization stream, and permission boundary. It may be private, shared with a team, or public.
3. **A script** is a `.tsx` file that reads, renders, or changes parts of a workspace. It may export components, queries, and mutations.

Arbord resolves the workspace from its local folders and mounts. This resolution process is an implementation mechanism, not another user-facing object. The wire moves shared-tree refs and immutable objects without dictating how a workspace or its stores are laid out.

### The model through one ordinary action

Joe begins with `projects/atlas`, an ordinary folder in his workspace. It may contain Markdown, a SQLite database, and a script that renders the project.

When Joe chooses **Share this folder**, Arbor gives that subtree a `TreeID`, revision history, permissions, and a synchronization endpoint. The folder remains at `projects/atlas`; only its backing changes. Alice accepts the invitation and places the same shared tree at `work/atlas`. Joe's and Alice's paths are personal, while edits, history, and access refer to the same shared tree.

If Alice annotates a read-only file, her overlay belongs to her workspace rather than the shared tree. If she opens the script, its queries resolve against the paths she can see and its permissions are intersected with hers. The wire is simply how the two arbords exchange revisions of the shared tree.

## The spec, by file

| File | Covers |
|---|---|
| [spec/format.md](spec/format.md) | On-disk format: Markdown documents and durable IDs, projected directories, `_index.md`, collections and stores, schemas and generated types, scripts, and sidecars |
| [spec/urls.md](spec/urls.md) | Names and URLs: logical relative paths, absolute `arbor://` names and TreeIDs, durable document-ID fragments, `system:`/`local:`, resolution, and the legacy bridge |
| [spec/system.md](spec/system.md) | The `system:` tree, workspace resolution, mounts, overlays, visited trees, agent confinement, effective access, and local durability (journal, trash, recovery) |
| [spec/arbord-rest.md](spec/arbord-rest.md) | The local client boundary: REST v1, document-aware references, raw snapshots and projected client views, revision domains, durable idempotent mutations, lossless SSE observation, errors, and the matching TypeScript/Swift clients |
| [spec/scripts.md](spec/scripts.md) | Script compilation and execution: realms, generated validators, query placement and reactivity, mutations, the authority boundary, components, and consent |
| [spec/browser.md](spec/browser.md) | The browser: navigation, rendering and editing, visiting unmounted trees, agent chat pages |
| [spec/wire.md](spec/wire.md) | Shared trees and the wire: folder → shared tree, `TreeID`s and public names, invitations and grants, refs/objects, sync, the one-replicator rule, collection backing, and static publication |
| [spec/cli.md](spec/cli.md) | The command surface, mapped to build-plan milestones |

The reading order above mirrors the model, local to shared: what a workspace contains, how things are named, how mounts and local state work, how clients talk to arbord, how scripts operate over the workspace, how humans browse and edit it, and finally how folders become shared trees with identity, access, and synchronization. The build sequence is [plan.md](plan.md); the narrative introduction is [intro.md](intro.md).

## Daemon roles

"arbord" names one codebase but two distinct operational roles, with different state, lifecycle, and trust boundaries. The spec has historically described a single daemon holding both; they should be read as separable:

- **The local workspace daemon** (on-demand). Serves the whole local filesystem for browsing and editing, with per-subtree authorities instantiated per tracked root; the launch path is a starting location, not the daemon's boundary. Owns everything in the workspace authority: the mutation journal, the SQLite search index, the in-memory event bus, page-ID maps and link healing, generated types, and filesystem watching/materialization. All of this state is per-device and disk-recoverable — the daemon can stop and start at will, healing from disk on next open. This is the role that backs the local browser, native TreeHopper (app-supervised per [plan-native.md](plan-native.md)), agents, and backups. It serves the loopback REST API with no authentication by design.
- **The wire host** (always-on). Owns a shared tree's ref authority, immutable object store, grant enforcement, `watch` streams, and host-side query execution for visiting clients ([spec/wire.md](spec/wire.md)). It deliberately needs none of the local materialization machinery — content addressing is a wire artifact, not a storage mandate — and it is exactly where the authentication the loopback API omits must live.

Cross-device intent flows between the roles as shared-tree revisions on the wire, which the local role journals on apply (`origin: "sync"`). The local daemon is the wire client; the serving role is deployable as a separate process, with a later embedded relay allowed without changing the protocol.

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
- General authentication, accounts, or multi-user administration around the single-user loopback arbord API. Wire endpoints and deployed mutations still enforce the narrower grants required by their specified features.
- Generated REST SDKs, general protocol capability negotiation, and multi-version compatibility machinery; the two reference clients are maintained directly against REST v1 fixtures.
- Persistent arbord event replay across process epochs; reconnecting across an epoch performs a deterministic resync.
- Durable identity for every ordinary file or directory. Markdown documents, including a directory document once identity is required, use rename-resistant `PageID`s; ordinary non-Markdown nodes remain path-only.
- High availability, horizontal scaling, production observability infrastructure, and generic driver/adapter/plugin frameworks.
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
