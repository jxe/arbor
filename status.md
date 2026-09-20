# Implementation status

*Source reviewed: `4853ac9`, 2026-09-20. Check the working tree and tests
before relying on a label.*

This page reports what the reference implementation does today. The
[specification](spec.md) is deliberately broader: it defines the portable
system Overstory is building toward. Remaining work lives in [plans](plans/README.md);
completed plans are deleted and live in git history.

States used below: **implemented** (built and tested), **installed** (running
in Joe's Mac and iPhone builds), **deployed** (running on the public canopyd),
**verified** (exercised by hand against live data).

## Implemented

| Area | State | Where to read |
|---|---|---|
| Tree identity and synchronization: stable TreeIDs, immutable objects, content-addressed snapshot bundles, accepted updates, append-only update strings, watch streams with unconditional net catch-up, sparse object transfer, canonical boundaries, public HTML and Markdown projection; TypeScript and Swift with shared fixtures | deployed | [tree operations](spec/01-tree-operations.md), [conformance](conformance/README.md) |
| Protocol format 5: raw file objects, typed file/directory/tree entries, sparse bootstrap without a file map, optional accepted-conflict metadata | deployed, installed | [tree operations](spec/01-tree-operations.md) |
| Authored change identity: every candidate carries `change`, `trace` (up to 64 frames and 1024 operations) or `trace: null`, `resolves`, and optional `ifCurrent`; digests over domain `arbor-update/2`; whole-batch rejection of unsupported semantics before any prefix is accepted | deployed, installed | [tree operations §2.1](spec/01-tree-operations.md#21-the-update-request), [source intent](spec/10-source-intent.md) |
| Accepted-state contract: simplified receipts, predecessor identity and root chains, required unresolved signals, paged conflict inspection without a decision-count cap | deployed, installed | [reference implementation](docs/reference-implementation.md#conflict-inspection) |
| Merge sidecar: canopyd forwards all eight operation kinds to `arbor-merge`, which executes exact authored operations, retains source choices, applies the conservative format rules, and returns retained state; canopyd owns acceptance, authorization, retention, and identities (schema 12) | deployed | [merge tool](docs/merge-tool.md) |
| Incremental merge state and lazy history: shared history pages, editable-state reuse, one persistent FIFO worker, accepted-prefix preflight reuse; per-request phase logging and `Server-Timing` | deployed | [merge tool](docs/merge-tool.md#retained-state-and-lazy-history), [deployment](deploy/README.md#canopyd-runtime-environment) |
| Accepted whole-entry and source-range conflicts: competing edits retained as alternatives with attribution, root decisions, guarded partial resolution, authorized historical inspection (schema 10 and 11) | deployed | [reference implementation](docs/reference-implementation.md#conflict-inspection) |
| Resource policy and execution authority: shared `who` / `via` / `allow` / `within` grammar, governed policy index, host-private execution tokens, guarded scoped snapshot effects, revocation stream, restrictive-intersection conflict acceptance, Canopy consent review (schema 13) | deployed, installed | [access control](spec/05-access-control.md), [reference implementation](docs/reference-implementation.md#resource-policy) |
| Client state machines: the document admission machine and the working-tree update machine are pure reducers in both languages executing one shared fixture; one request in flight per document session and per tree, with one retained successor | installed | [client state machines](docs/client-state-machines.md) |
| Durable source admission queue: exact source, basis, and candidate records with explicit predecessors, fsynced journals (schema 4, one frame per record), trace compaction, read-your-writes sessions, publication and settlement, recovery after restart; installed Canopy emits the supported operations and explicit structural snapshots | installed, verified | [local system](docs/local-system.md#source-admission-journals), [client state machines](docs/client-state-machines.md#9-admission-invariants-and-trace-compaction) |
| Canopy working-tree editors: the Mac and iOS apps edit placed trees directly as working trees over the object store; the daemon is the folder's client plus loopback bootstrap, credential, and object services and has no editor path | installed, verified | [local system](docs/local-system.md#native-working-trees), [client design](docs/client.md) |
| Canopy editor recovery: saves wait for durable coordinator heads; committed generations keep exact-source local recovery copies with Local History restore; reconnection retries pending work; restart, divergent-draft review, disk-failure retry, and keystroke races have regressions | installed, verified | [local system](docs/local-system.md#editor-recovery-store) |
| Canopy operation capture: ordinary and compound sibling-body entry moves and copies, post-copy page-ID edits, explicit removals for private Trash, same-document and cross-document copies, page-conversion undo and redo, durable undo-horizon collection, exact CRLF and BOM preservation | installed | [Native 008](plans/canopy-swift/008-complete-native-move-copy-undo-capture.md) |
| Canopy conflict review: sidebar navigation, page markers, exact-source comparison and composition, durable grouped drafts, recursive previews, guarded source-range and structural resolution | implemented | [Native 010](plans/canopy-swift/010-client-conflict-review.md) |
| Communities and accounts: a host serves a community plus person and group profile trees, reserves account paths, enforces whole-tree access, and reconciles synchronized account configuration; `arbor me create` makes a self-certifying profile and the signed challenge and claim flow proves it | deployed, installed | [accounts and devices](spec/04-accounts-and-devices.md), [deployment](deploy/README.md) |
| Plural local accounts and devices: one data home holds several host accounts, including several at one origin, in `account.yaml`, `trees.yaml`, and `devices.yaml`; Mac-to-iPhone pairing | installed, verified | [local system](docs/local-system.md#data-home) |
| Short-lived cloud workspaces: reusable one-account bundles, exact placements under an isolated root, detached Arbor Sync, explicit finish, bundle revocation, `arbor status` | implemented | [CLI](docs/cli.md#short-lived-cloud-sessions) |
| Headless executable-data core: SQLite-backed query lowering and execution over the Supplies corpus, dependency-sensitive live result streams, authorized transactional mutations with durable retry receipts | implemented | [apps runtime](packages/apps-runtime/README.md), [Supplies](examples/supplies/README.md) |
| Operational hosting: Railway and VPS deployment, persistent storage, backup and restore, coordinated upgrades, one-off migrations | deployed | [deployment](deploy/README.md), [migrations](migrations/README.md) |

## In progress

| Area | State | Remaining | Owning plan |
|---|---|---|---|
| Canopy editing and review | implemented, not installed | Richer review previews, precise inline markers, transformed copies and other compound editor commands, interactive accessibility gates | [Native 008](plans/canopy-swift/008-complete-native-move-copy-undo-capture.md), [010](plans/canopy-swift/010-client-conflict-review.md) |
| Markdown source-transfer policy | implemented, not deployed | Identity-verified paragraph copies and moves reconcile with independent prose edits in either arrival order; structured formats and protected structure still require review | [canopyd 009](plans/canopyd/009-canopy-provenance-merges.md) |
| Operation frames and lazy history | phases 1 to 3 deployed | Lazy authority validation, retained-storage measurement before packing, deletion watermark | [canopyd 010](plans/canopyd/010-operation-frames-and-lazy-history.md) |
| Resource policy providers | deployed | Provider-specific enforcement, source resolution, activation consent, the execution sidecar, observation and soak | [Apps 004](plans/apps/004-mutation-permissions.md), [005](plans/apps/005-source-resolution-and-sidecar.md) |
| Working-tree client transition | installed | The explicit soak closeout | [release and soak](plans/verification/release-and-soak.md#observation-and-soak-closeout) |
| Canopy for the web | not mounted | The browser editor is out of the build until it is rebuilt as a working-tree client over the same machines as the Mac app | [Web 025](plans/canopy-web/025-arbor-web.md) |
| Executable documents | core only | MDX/TSX compilation, generated typing, editor integration, React presentation, activation, Canopy presentation, canopyd hosting | [Apps 001 and 003 to 006](plans/catalog.md#product-completion) |
| Group management | partial | No coherent Create Group flow; the native app has no membership editor | [catalog](plans/catalog.md#product-completion) |
| Composable conflict fragments | reassess | Only residual representation gaps remain after schema 12 | [canopyd 002](plans/canopyd/002-composable-conflict-fragments.md) |

## Specified but not implemented

- Host-hosted agents and their portable frontmatter contract.
- Static baking and additional portable live-deployment adapters.
- A complete Postgres child provider, observation contract, and bidirectional projections.
- Deferred workspace capabilities: multiple local placements of one TreeID, durable pinned historical placements, reader-local overlays.
- Linux and Windows daemon supervision.

## Known gaps

- **Storage is unbounded.** The per-tree object and byte quotas were removed from update acceptance; nothing bounds retained history, the iOS replica keeps every accepted object, and the editor recovery store is never pruned. Measurement precedes packing in [canopyd 010](plans/canopyd/010-operation-frames-and-lazy-history.md) and [001](plans/canopyd/001-pack-object-storage.md).
- **Every accepted-state change requires review.** The host requires exact accepted-state guards, so a client must review the latest evidence even when projected bytes are equal or the update is unrelated.
- **Range translation across a merged predecessor** is future work; the host relates an authored predecessor to its accepted projection through a validated or exactly replayed prefix only.
- **Cross-account rehome of resource policy** fails before mutation until a policy-transfer contract is reviewed.
- **Cross-process ownership of a client state directory** is not enforced; one process must own it by convention.
- **Latency.** The target is under 100 ms of server processing for a small fast-forward; divergent-merge and live latency are not established, and the first edit after a restart is measured in seconds unless warm-up ran.
- **No accepted-history listing.** Known retained roots are readable as immutable snapshots by callers who can read the tree; there is no history or metadata route. [canopyd 007](plans/canopyd/007-canopy-document-history.md) owns it.
- **Compatibility windows.** The v1 account-configuration and local-state readers remain until [Cleanup 002](plans/cleanups/002-retire-v1-account-and-local-state-adapters.md); scalar group-member entries are legacy input only.
- **Production recovery, dispute handling, and high availability** are not productized; the deployment guide documents backup, restore, and coordinated upgrades only.

## Where work is tracked

- [Outcome menu](plans/README.md), a short set of choices with open priorities.
- [Detailed catalog](plans/catalog.md), every retained plan and design candidate.
- [Release and verification](plans/verification/release-and-soak.md), outstanding installation, deployment, hands-on, and soak checks.
- [Open questions](plans/open-questions.md).
