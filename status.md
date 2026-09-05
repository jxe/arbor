# Arbor implementation status

*Source snapshot reviewed: `0142333` plus the content-addressed snapshot implementation,
2026-09-04. Check the current working tree and tests before relying on a status
label.*

This page reports what the reference implementation does today. The [specification](spec.md) is intentionally broader: it defines the portable system Arbor is building toward. Active work belongs in [plans](plans/README.md), and completed evidence belongs in [plans/_done](plans/_done/README.md).

## Implemented and tested

- **Local workspace and editor.** Arbor web browses ordinary local files, placed Arbor trees, collections, and safe `system:` records through one locator-driven interface. Markdown remains canonical, and edits go through guarded Arbor Sync mutations with recovery and observation.
- **Tree identity and synchronization.** Stable TreeIDs, immutable objects, content-addressed retained-root snapshot bundles, accepted updates, full-duplex append-only update strings, three-way text merging, watch streams, sparse object transfer, canonical boundaries, and public HTML/Markdown projection are implemented in TypeScript and Swift with shared fixtures.
- **Canopy communities and accounts.** A Canopy can host a community plus person and group profile trees, reserve account paths, enforce whole-tree access, and reconcile synchronized account configuration.
- **Profile identity and claiming.** `arbor me create` creates a self-certifying person Profile TreeID. A community reserves that exact identity and the client proves control through the signed challenge/claim flow.
- **Plural local accounts and devices.** One Arbor data home can hold several Canopy accounts, including multiple accounts at one origin. Account configuration uses `account.yaml`, `trees.yaml`, and `devices.yaml`; native account pairing has passed its recorded Mac-to-iPhone primary-path acceptance.
- **Headless executable-data core.** The checked-in Supplies corpus has SQLite-backed query lowering and execution, dependency-sensitive live result streams, and authorized transactional mutations with durable retry receipts.

## Partial or in progress

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
