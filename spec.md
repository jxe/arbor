# Arbor: a successor to the web
*Spec overview, v0.7 — the spec is split into topic files under [spec/](spec/). Placeholder names: **Arbor** (the system), **a workspace** (the tree a person sees and works in), **a shared tree** (an independent sync root), **arbord** (the daemon: local workspace + runtime), **TreeHopper** (the browser — web and native), and **the wire** (the shared-tree protocol). All names remain provisional.*

---

## Specification stance

This spec describes the complete Arbor system we intend to demonstrate, including features beyond the current implementation. It is not a claim that every described feature is built; [plan.md](plan.md) records current status and build order.

Topic specs are normative product descriptions. They do not weaken features to match current implementation status. Temporary cuts and differences between the reference implementation and the intended product belong only in [plan.md](plan.md).

Completeness does not mean future-proofing. The spec chooses concrete reference behavior for the clients, daemon, stores, scripts, mounts, and wire that it actually describes. It does not add plugin systems, compatibility matrices, universal identifiers, capability negotiation, production administration, or generic abstraction layers merely because some later implementation might want them.

Deferred items may remain absent forever. But machinery required by a specified feature is not optional: scripts require isolation, shared-tree access requires revocation, synchronization requires deterministic object encoding and conflict behavior, and authored local writes require durable acknowledgement and lossless observation.

## Thesis

Arbor gives each person one local tree. Any folder may be backed by ordinary files, a shared tree, a database, or a connection to an existing store. Different people can place the same shared tree wherever it makes sense to them. Scripts render and change the resulting workspace for humans and agents alike.

**One workspace to navigate and edit; independent shared trees where synchronization, history, or permissions require a boundary; and ordinary TypeScript scripts for turning that workspace into applications.**

TreeHopper browses the entire local filesystem as one navigable tree; the workspace is not a navigation boundary. Ordinary unpromoted files remain fully browsable and editable as `tree: "local"`. Durable identity, indexing, recovery, synchronization, and permissions begin at a **shared-tree boundary**, created when someone shares a subtree beneath a writable community profile. Schema-marked stores may supply their own capabilities, but there is no durable local-only tracked-tree class ([locators.md](spec/locators.md)).

Arbord materializes the workspace as ordinary files where appropriate. Agents already know this interface: `ls` is browsing, `cat` is reading, writing a file is editing, and `grep -r` is search. Humans get Finder, editors, the browser, and TreeHopper over the same tree. A Markdown document has one extensionless logical address: `x.md` supplies `/x`'s stored body while a sibling `x/` supplies its children; when the sibling body is absent, `x/_index.md` is the directory-body fallback. TreeHopper projects the stored or implicit body together with every immediate child, so every directory is a complete document without browsing having to create `_index.md`. Giving a folder a URL gives that subtree an independent identity without changing where it appears in the workspace; public and person-specific access then operate on that identity.

The developer pitch remains familiar: *put Markdown, a SQLite database, or a connection to an existing store in the workspace; write a typed query, a mutation, and a React component; Arbor generates the execution boundary and, when needed, the synchronization boundary.*

Three primary concepts organize the system:

1. **A workspace** is the tree a person or agent sees and works in. It may contain local folders, databases, connections, and mounted shared trees.
2. **A shared tree**, technically a sync root, is a folder with an independent identity, history, synchronization stream, and permission boundary. It may be private, shared with a team, or public.
3. **A script** is a `.tsx` file that reads, renders, or changes parts of a workspace. It may export components, queries, and mutations.

Arbord resolves the workspace from its local folders and mounts. This resolution process is an implementation mechanism, not another user-facing object. The wire moves shared-tree refs and immutable objects without dictating how a workspace or its stores are laid out.

### The model through one ordinary action

Joe begins with `projects/atlas`, an ordinary folder in his workspace. It may contain Markdown, a SQLite database, and a script that renders the project.

Joe connects to the Garden community and claims the person profile tree at `/~joe`. He chooses **Share** for Atlas, explicitly selects Private, and mounts it at `/~joe/atlas`. Arbor gives the existing folder a stable `TreeID`, uploads its initial Merkle root, and begins synchronization without moving its OS path. Its canonical spellings are `https://garden.example/~joe/atlas` and `arbor://garden.example/~joe/atlas`; `arbor://tree/<TreeID>` remains the identity fallback.

Those global names, local paths, and immutable revision selections are all **Arbor locators**. TreeHopper and the CLI accept the same locator language, then resolve it to a concrete tree, node path, and optional historical root.

The same host serves the public-read community tree at `/`, Alice's complete person profile at `/~alice`, and the Editors' complete group profile at `/~editors`. Profile trees may contain arbitrary descendants. Their `TreeID`s and account/device credentials supply stable identity and control; `_index.md` supplies mutable readable profile content. The community and group documents author member locators. An unresolved same-community person locator reserves that handle, and the first valid claim wins.

Joe may leave Atlas private, give `everyone` read or write access, grant Alice's profile `TreeID`, grant the Editors group profile, or create a digest-backed revocable link. Alice places the tree at `work/atlas`. Joe's and Alice's filesystem paths are personal, while identity, revisions, history, and access refer to the same shared tree.

Access is always whole-tree. If Joe shares `projects/atlas/research` separately, Arbor promotes it in place at the same canonical path. Longest-prefix resolution now enters its child `TreeID`; neither parent nor child access inherits. A parent push cannot overwrite the exact reserved boundary. If the shared folder lives outside Joe's physical profile folder, Arbor projects it as a virtual child rather than copying it.

## The spec, by file

| File | Covers |
|---|---|
| [spec/format.md](spec/format.md) | On-disk format: Markdown documents and durable IDs, projected directories, `_index.md`, collections and stores, schemas and generated types, scripts, and sidecars |
| [spec/locators.md](spec/locators.md) | Locators: one input syntax for local paths, canonical HTTP/Arbor names, raw TreeIDs, immutable revisions, fragments, and resolution |
| [spec/system.md](spec/system.md) | The `system:` tree, workspace resolution, placements, access records, overlays, visited trees, agent confinement, and local durability (journal, trash, recovery) |
| [spec/arbord-rest.md](spec/arbord-rest.md) | The local client boundary: REST v1, document-aware references, raw snapshots and projected client views, revision domains, durable idempotent mutations, lossless SSE observation, errors, and the matching TypeScript/Swift clients |
| [spec/scripts.md](spec/scripts.md) | Script compilation and execution: realms, generated validators, query placement and reactivity, mutations, the authority boundary, components, and consent |
| [spec/browser.md](spec/browser.md) | The browser: browsing/editing, persistent profile control, explicit Share, access/revocation, visits, and agents |
| [spec/wire.md](spec/wire.md) | Community namespace, profiles and claims, canonical boundaries, whole-tree access, refs/objects, sync, and HTTP projection |
| [spec/cli.md](spec/cli.md) | The intended command surface |

The reading order above mirrors the model, local to shared: what a workspace contains, how things are named, how mounts and local state work, how clients talk to arbord, how scripts operate over the workspace, how humans browse and edit it, and finally how folders become shared trees with identity, access, and synchronization. The build sequence is [plan.md](plan.md); the narrative introduction is [intro.md](intro.md).

## Daemon roles

"arbord" names one codebase but two distinct operational roles, with different state, lifecycle, and trust boundaries. The spec has historically described a single daemon holding both; they should be read as separable:

- **The local workspace daemon** (on-demand). Serves the whole local filesystem for browsing and editing; the launch path is a starting location, not the daemon's boundary. It instantiates durable indexing, recovery, synchronization, and permission state at shared-tree boundaries and may retain private migration state for legacy local placements without exposing that state as a public tree identity. All per-device state is disk-recoverable. This role backs local and native TreeHopper, agents, and backups, and serves the loopback REST API with no authentication by design.
- **The wire host** (always-on). Represents one community and owns account/profile identity, canonical boundary records, one mutable root-hash tip per `TreeID`, immutable objects, whole-tree access entries, claims, and `watch` streams ([spec/wire.md](spec/wire.md)). It deliberately needs none of the local materialization machinery.

Cross-device intent flows between the roles as shared-tree revisions on the wire, which the local role journals on apply (`origin: "sync"`). The local daemon is the wire client; the serving role is deployable as a separate process, with a later embedded relay allowed without changing the protocol.

## Deferred deliberately

- Path-scoped access within a shared tree. A subtree that needs different access becomes a nested shared tree.
- Cryptographic/self-certifying `TreeID`s beyond opaque stable IDs and signed endpoint hints.
- Rights finer than `read` and `write`, nested groups, cross-authority group proofs, and delegable or attenuable remote capabilities.
- CRDT collaboration beyond CAS plus three-way merge.
- Authority actions and generalized endpoint compute beyond upstream-hosted queries and the minimal reference server.
- Differential/materialized query evaluation behind the arbord interface.
- Logical multi-writer SQLite changesets beyond consistent whole-database snapshots.
- Offline Postgres mirroring beyond live Postgres-backed collections.
- Rendering gateways and standalone non-Apple browsers.
- Discovery indexes as mountable shared trees.
- Userfs/FUSE for huge trees.
- General authentication, accounts, or multi-user administration around the single-user loopback arbord API. Wire endpoints and deployed mutations still authenticate device credentials bound to personal trees or access-link claims and enforce whole-tree access.
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
2. **Identity and recovery UX.** Personal trees make names and stable person identity concrete, but device replacement and recovery still need understandable proof-of-control UX without turning Arbor into an account system.
3. **Merge semantics.** Structured collections eventually need more than text three-way merge. SQLite snapshots initially conflict as whole databases; logical row changes still face schema and authority invariants.
4. **Determinism discipline.** Query workers must consistently exclude clock, randomness, and I/O across runtime upgrades.
5. **Compiler correctness.** `query`/`mutation` extraction, client-handle replacement, and validator generation from TypeScript types are security-critical, even though the explicit boundary is simpler than general graph slicing.
6. **Schema evolution.** Mounted consumers may remain pinned to old shapes while a shared tree changes schemas.
7. **Consent precision.** Inferred-or-declared prefixes are enforcement-true but coarser than actual runtime read sets; computed paths force broad declarations, and broad permissions must look broad.
8. **Builtin quality.** Weak search/backlink/walk primitives will force user queries into expensive scans.
9. **Reader-wins rendering.** Preventing author dark patterns also removes guaranteed presentation; this is an intentional economic tradeoff.
10. **Moderation.** Distribution follows syncing and sharing; public-write trees and widely distributed access links need anti-spam policy.
11. **Query placement policy.** Placement follows the data, but the edges are open: upstream-hosted results are not client-verifiable the way objects are, offline behavior needs a legible fallback story, and mixed-residence read sets need better answers than a diagnostic.
