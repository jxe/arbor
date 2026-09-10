# Arbor implementation status

*Source snapshot reviewed: `a18bc7b` plus the reusable cloud-session implementation,
2026-09-06. Check the current working tree and tests before relying on a status
label.*

This page reports what the reference implementation does today. The [specification](spec.md) is intentionally broader: it defines the portable system Arbor is building toward. Active work belongs in [plans](plans/README.md), and completed evidence belongs in [plans/_done](plans/_done/README.md).

## Implemented and tested

- **Native working-tree editors.** The Mac app and iOS edit placed Arbor trees directly as working trees (`ArborWorkingTree` over `ArborObjectStore`): Markdown remains canonical, the document admission machine makes each edit durable in the working tree, and the update coordinator publishes durable heads to Canopy. The daemon has no editor path; it is the folder's client plus loopback bootstrap, credential, and object services.
- **Tree identity and synchronization.** Stable TreeIDs, immutable objects, content-addressed retained-root snapshot bundles, accepted updates, append-only update strings, three-way text merging, watch streams, sparse object transfer, canonical boundaries, and public HTML/Markdown projection are implemented in TypeScript and Swift with shared fixtures.
- **Client state machines.** The document admission machine (native editor; one transport, no digest fence) and the working-tree update machine (native working trees, the daemon's folder synchronizer) are pure reducers in both languages that execute one shared fixture (`document-admission`, `working-tree-updates`; no filesystem role). A burst of edits is one admission and normally one accepted update; at most one request is in flight per document session and per tree, with one retained successor. Both adoptions are verified: the unit and protocol suites in TypeScript, the Swift package suites on macOS, and an app smoke test on macOS and the iOS simulator.
- **Canopy communities and accounts.** A Canopy can host a community plus person and group profile trees, reserve account paths, enforce whole-tree access, and reconcile synchronized account configuration.
- **Profile identity and claiming.** `arbor me create` creates a self-certifying person Profile TreeID. A community reserves that exact identity and the client proves control through the signed challenge/claim flow.
- **Plural local accounts and devices.** One Arbor data home can hold several Canopy accounts, including multiple accounts at one origin. Account configuration uses `account.yaml`, `trees.yaml`, and `devices.yaml`; native account pairing has passed its recorded Mac-to-iPhone primary-path acceptance.
- **Short-lived cloud workspaces.** The CLI can mint a reusable one-account cloud bundle, materialize its exact writable tree placements under an isolated root, keep them synchronized through a detached Arbor Sync, verify and stop through an explicit finish boundary, revoke the bundle device, and report persistent, foreground, or cloud state through `arbor status`.
- **Headless executable-data core.** The checked-in Supplies corpus has SQLite-backed query lowering and execution, dependency-sensitive live result streams, and authorized transactional mutations with durable retry receipts.

## Partial or in progress

- **Working-tree client transition ([Native 022](plans/native/022-run-the-mac-app-as-a-working-tree-client.md)).** Plan A (Phases 0 through 7) is implemented; the live Mac switch, the iPhone re-place, and the soak remain. Arbor Sync serves `GET /v1/bootstrap` (accepted state, a sparse directory-and-Markdown spine, a file map, and its pending request verbatim or a blocked reason), `GET /v1/credential`, and `GET /v1/objects/{hash}` backed by a stat-tuple-keyed object index with periodic revalidation and Canopy fetch-through; Canopy's object route serves any retained accepted root. Both native platforms run the Swift working-tree client (`ArborWorkingTree` over `ArborObjectStore`): the Mac no longer edits through Arbor Sync but opens a placed tree through bootstrap as an in-memory working tree with the daemon's object route as its platform store, submits with the daemon's shared credential, adopts the daemon's pending request as its first attempt, opens read-only behind the daemon's review when the folder holds a conflict, and edits the account configuration checkout on disk; visits are app-side read-only working trees following the tree's watch. iOS re-places on working-tree format `4`. The daemon's editor path is deleted: no node, mutation, admission, asset, import, or session routes, no editor admission or search index, no `ArborSyncWorkspaceProvider`; the fixture has no filesystem role and one admission transport. The CLI's one tree write (`arbor place`) edits the configuration checkout on disk. The web editor is unavailable until Plan B rebuilds it on a TypeScript working tree; `packages/render` stays in the repository, unmounted. The live Mac switch and the iPhone re-place wait for Joe's go-ahead (synchronize the phone first), then a soak of a couple of weeks before Plan B.
- **Native conflict review.** Direct replicas and the macOS Arbor Sync status panel materialize verified base/current/mine/server-draft content and offer per-path Current/Mine/Both/Edit choices through the shared review surface. Arbor Sync retains fetched evidence across restart, identity-fences submissions, refuses to fabricate choices when a conflict has no durable Canopy evidence, pauses approximate accepted Markdown merges before materializing them, and repeats an accepted moving-filesystem prefix by request digest instead of reapplying it against a stale base. Ordered replay of an unattempted update suffix and Quagmire's future inline hunk accessories remain in [Reliability 004](plans/reliability/004-contextual-canopy-conflict-resolution.md).
- **Executable documents.** The data/query/mutation core exists, but MDX/TSX compilation, generated typing, editor integration, React presentation, automatic activation, native presentation, and Canopy hosting are not complete. [Apps 001 and 003](plans/README.md#product-completion) own that work.
- **Client parity.** Arbor web and native Arbor share the core model and synchronization contracts, but their interaction surfaces are not identical.
- **Group management.** Arbor web can add and remove structured members on an existing `type: group` tree. It does not provide one coherent Create Group flow, and native Arbor has no equivalent membership editor. This remains a separately tracked product-design item.
- **Operational hosting.** Railway/VPS deployment, persistent storage, backup/restore, and coordinated alpha upgrades are documented, but production recovery, dispute handling, and high availability are not productized.

## Specified but not implemented

- Canopy-hosted Arbor agents and their portable frontmatter contract.
- Static baking and additional portable live-deployment adapters.
- A complete Postgres child provider, observation contract, and bidirectional projections.
- Several deferred workspace capabilities, including multiple local placements of one TreeID, durable pinned historical placements, and reader-local overlays.

## Compatibility and known gaps

- The current v2 account-configuration layout is live, while the named v1 account and local-state readers remain during an explicit compatibility window. [Cleanup 002](plans/cleanups/002-retire-v1-account-and-local-state-adapters.md) owns their eventual removal.
- Scalar group-member entries are legacy input compatibility only. Conforming authored content uses a required `profile` locator and optional Canopy-local `handle` as defined by [accounts and devices](spec/04-accounts-and-devices.md).
- Linux and Windows daemon supervision adapters are not implemented.
- Canopy exposes no accepted-history listing or metadata. Known retained roots are readable through immutable snapshots by callers who can currently read the tree; the generic object route remains current-root-scoped.
- There is no polished first-party group creation flow; users should not be directed to a manual YAML recipe as if one existed.

## Where work is tracked

- [Highly important](plans/README.md#highly-important) — current correctness and durability work, external-agent access, and Canopy storage.
- [Cleanups](plans/README.md#cleanups) — bounded compatibility removal, simplification, and deduplication.
- [Product completion](plans/README.md#product-completion) — applications, Postgres, bounded product outcomes, and not-yet-designed feature gaps.
- [Hardening, efficiency, and polish](plans/README.md#hardening-efficiency-polish-etc) — security, testing, speed, and conditional reliability work.
- [Open questions](plans/open-questions.md) — unresolved design questions, not hidden implementation claims.
- [Completed outcomes](plans/_done/outcomes.md) — implementation and verification history.
