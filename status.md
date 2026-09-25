# Implementation status

*Source reviewed: `17da9152` plus the cleanup below, 2026-09-21. Check the working tree and tests
before relying on a label.*

This page reports what the reference implementation does today. The
[specification](docs/overstory-spec/README.md) is deliberately broader: it defines the portable
system Overstory is building toward. Remaining work lives in [plans](plans/README.md);
completed plans are deleted and live in git history.

States used below: **implemented** (built and tested), **installed** (running
in Joe's Mac and iPhone builds), **deployed** (running on the public canopyd),
**verified** (exercised by hand against live data).

## Implemented

| Area | State | Where to read |
|---|---|---|
| Canopy first launch: shared Mac/CLI identity, create/recover/backup, guarded legacy reconciliation, community-address claim and durable retry; iOS pairing-only setup | implemented, not installed | [browser design](docs/implementing-editors/design.md#first-launch-and-identity), [account bootstrap](docs/implementing-sync-services/arborsync-api.md#4-identity-account-bootstrap-and-held-changes) |
| Bun CLI distribution: publishable package, external-checkout cloud sessions, explicit daemon requirements, durable installed watcher/runtime assets | implemented, not published | [bunx usage](docs/getting-started/cli.md#running-with-bunx) |
| Tree identity and synchronization: stable TreeIDs, immutable objects, content-addressed snapshot bundles, accepted updates, append-only update strings, watch streams with unconditional net catch-up, sparse object transfer, canonical boundaries, public HTML and Markdown projection; TypeScript and Swift with shared fixtures | deployed | [tree operations](docs/overstory-spec/01-tree-operations.md), [conformance](docs/overstory-spec/conformance/README.md) |
| Protocol format 5: raw file objects, typed file/directory/tree entries, sparse bootstrap without a file map, optional accepted-conflict metadata | deployed, installed | [tree operations](docs/overstory-spec/01-tree-operations.md) |
| Authored change identity: every candidate carries `change`, `trace` (up to 64 frames and 1024 operations) or `trace: null`, `resolves`, and optional `ifCurrent`; digests over domain `arbor-update/2`; whole-batch rejection of unsupported semantics before any prefix is accepted | deployed, installed | [tree operations §2.1](docs/overstory-spec/01-tree-operations.md#21-the-update-request), [source intent](docs/overstory-spec/10-source-intent.md) |
| Accepted-state contract: simplified receipts, predecessor identity and root chains, required unresolved signals, paged conflict inspection without a decision-count cap | deployed, installed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Merge sidecar: canopyd forwards all eight operation kinds to `arbor-merge`, which executes exact authored operations, retains source choices, applies the conservative format rules, and returns retained state; canopyd owns acceptance, authorization, retention, and identities (schema 12) | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md) |
| Incremental merge state and lazy history: shared history pages, editable-state reuse, one persistent FIFO worker, accepted-prefix preflight reuse; per-request phase logging and `Server-Timing` | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md#retained-state), [deployment](packages/canopyd/deploy/README.md#canopyd-runtime-environment) |
| Merge boundary: canopyd shares only the object store and `@overstory/merge-protocol` with the sidecar and keeps none of its state; canopyd merges account configuration itself; `trees.yaml` is resource-rule grammar only | deployed 2026-09-24 (build `dd5313c8`) | [merge sidecar](docs/architecture/canopyd/merge-tool.md#answer-checks) |
| Accepted history as log entries and one merge question (canopyd 016): each accepted update is an immutable log entry in the object store naming its predecessor's; rows keep the entry hash and `conflicted` (schema 19); canopyd asks the sidecar one question, accepts plain `editSource`/`addEntry` edits on the head without it, and the sidecar keeps an in-memory cache it rebuilds by replaying entries | deployed 2026-09-24 at schema 19 by migration 018 (build `dd5313c8`) | [writing a sidecar](docs/architecture/canopyd/writing-a-sidecar.md), [merge sidecar](docs/architecture/canopyd/merge-tool.md), [migration 018](packages/canopyd/migrations/018-log-entries/README.md) |
| One access store (schema 20): a tree an account activated or hosts is that account's, and its owner's resource rules alone govern it; `access` keeps only unowned trees' entries; `trees.updated_at`, the reservation status, `account_challenges.claim_digest` and `meta.community_name` are gone | deployed 2026-09-24 at schema 20 by [migration 019](packages/canopyd/migrations/019-one-access-store/README.md) (build `016f878a`) | [host](docs/architecture/canopyd/README.md#accounts-and-canonical-paths) |
| Profile facts per tree (canopyd 018, schema 21): one `profile_facts` row per tree whose head declares `type: person` or `type: group`, keyed by TreeID with the head's `_index.md` object and declared avatar path; an accepted update recomputes it only when its entry changes touch `_index.md` or that avatar, parsing `_index.md` once per accept, and reconciles community accounts only when the members change; readers and the directory's group scan key by tree; the `meta` `profile:<root>` rows are gone. Tested by `tests/integration/canopyd/profile-facts.test.ts` and the migration suite | deployed and verified 2026-09-25 at schema 21 by [migration 020](packages/canopyd/migrations/020-profile-facts-per-tree/README.md) (build `fe0fccdb`) | [host](docs/architecture/canopyd/README.md#accounts-and-canonical-paths), [schema history](packages/canopyd/migrations/README.md#schema-history) |
| Saved sidecar states: with `--cache` (canopyd passes `/data/merge-cache`) the sidecar saves a tree's head state every 32 replayed entries, keeps two per tree, and after a restart loads the nearest save instead of replaying from the chain's start; a save holds the exact replayed state (key order and bucket shape kept), checked by state identity and object hash on load. On the production copy a restarted sidecar answered in 37 ms instead of replaying 282 entries in 1 s | implemented, not deployed | [merge sidecar](docs/architecture/canopyd/merge-tool.md#cache-and-replay) |
| Merge sidecar cleanup: the reference sidecar keeps each engine state decoded in memory, as frozen, interned values in persistent maps that share whatever an edit did not touch, identified by a digest of its content (the chunked state encodings and lazy history loading are gone); engine decisions convert straight to log decisions; the snapshot tree merge is its own package, `@overstory/tree-merge`, which Arbor Sync tree recovery now declares. Log entries and the question and answer are unchanged | implemented, not deployed | [merge sidecar](docs/architecture/canopyd/merge-tool.md#retained-state) |
| Transfer merge extensions (canopyd 014): identity-verified moves and copies of Markdown bullet-list items, pipe-table body rows and text with relative, fragment or reference links (with a proven binding); same-anchor pairs kept in contribution order; keyed JSON/YAML member moves and copies and top-level TS/JS function declaration moves within one file, each with its commutation proof in `format-rules.ts`, tested in both arrival orders with a failing-proof case (`tests/unit/canopyd-merge/transfer-extensions.test.ts`). Server-side only; no wire or schema change | implemented, not deployed; gate in [release and soak](plans/release-and-soak.md#server-refinements) | [transfers](docs/architecture/canopyd/merge-tool.md#transfers) |
| Moves on the fast paths (Native 008): canopyd accepts a head trace whose frames are basis `moveSource` operations and then `editSource` operations without the sidecar, executing them with `arrangeSources` in `@overstory/protocol`; the sidecar's exact-basis path also takes basis moves and ordered lineage. Tested against eager and full evaluation, with a peer edit in both arrival orders (`tests/unit/canopyd-merge/source-moves.test.ts`, `tests/integration/canopyd/source-acceptance.test.ts`). No wire or schema change | implemented, not deployed | [fast-forward](docs/architecture/canopyd/merge-tool.md#fast-forward) |
| Accepted whole-entry and source-range conflicts: competing edits retained as alternatives with attribution, root decisions, guarded partial resolution, authorized historical inspection (schema 10 and 11) | deployed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Resource policy and execution authority: shared `who` / `via` / `allow` / `within` grammar, governed policy index, host-private execution tokens, guarded scoped snapshot effects, revocation stream, restrictive-intersection conflict acceptance, Canopy consent review (schema 13) | deployed, installed | [access control](docs/overstory-spec/05-access-control.md), [reference implementation](docs/architecture/protocol/README.md#resource-policy) |
| Client synchronization machine: one working-tree update machine (Swift `UpdateMachine`, TypeScript `reduceUpdate`) executing one shared fixture, with held rejections, polling, explicit synchronization and an effect-driven Swift runner over a change log pinned by shared runner vectors; editors append each generation straight to the change log with no admission machine or recovery store (Clients 001 phases 1–3). Arbor Sync runs the TypeScript runner per placed folder (phase 4) | installed, verified (Mac, iPhone, daemon) | [working-tree updates](docs/overstory-spec/09-client-synchronization.md), [the update machine](docs/implementing-sync-services/update-machine.md), [editor sources](docs/implementing-editors/editor-source.md) |
| Durable change log (`sync/change-log.json`, formerly the source admission queue): exact source, basis, and candidate records with explicit predecessors, fsynced journals (schema 4, one frame per record), trace compaction, read-your-writes sessions, publication and settlement, recovery after restart; installed Canopy emits the supported operations and explicit structural snapshots | installed, verified | [local system](docs/architecture/canopy-browser/local-state.md#change-logs), [editor sources](docs/implementing-editors/editor-source.md#6-change-invariants-and-trace-compaction) |
| Canopy working-tree editors: the Mac and iOS apps edit placed trees directly as working trees over the object store; the daemon is the folder's client plus loopback bootstrap, credential, and object services and has no editor path (its leftover mutation path and write journal were deleted 2026-09-24; old `journal/` state directories are orphaned on disk) | installed, verified | [local system](docs/architecture/canopy-browser/local-state.md#native-working-trees), [client design](docs/implementing-editors/design.md) |
| Canopy navigation: observable Back availability, editor-link pushes, exact cross-tree destinations, and Back/Forward/native-pop provider reopening without resetting tab history | implemented; Mac user-verified | [client design](docs/implementing-editors/design.md) |
| Canopy editor recovery: edits recover from the change log, with no recovery store, admission debounce or local conflict review; History shows an empty state until Canopy serves history (Clients 001 phase 3) | installed, verified (Mac, iPhone) | [local system](docs/architecture/canopy-browser/local-state.md#editor-recovery), [editor sources](docs/implementing-editors/editor-source.md#4-recovery) |
| Canopy operation capture: ordinary and compound sibling-body entry moves and copies, explicit current-page path rename with subtree relocation and proactive link healing, post-copy page-ID edits, explicit removals for private Trash, same-document and cross-document copies, page-conversion undo and redo, exact CRLF and BOM preservation | installed | [client design](docs/implementing-editors/design.md#labels-and-actions), [Native 008](plans/soon/008-complete-native-move-copy-undo-capture.md) |
| Canopy block moves (Native 008): a generation that only rearranges blocks (reorder, drag, indent, outdent, move under another parent, several blocks at once) publishes `moveSource` of each relocated block's exact source plus edits to re-indented leading spaces, instead of a retyped replacement; a peer's concurrent edit to a moved paragraph follows it. Shared vectors in `source-moves.json` (Swift and TypeScript executors and change logs); codec tests in `CanopyEditorTests`; live acceptance, restart replay and a peer edit in `LiveEditorAdmissionTests`. A final block moved up gains the blank line it needs, where it used to run into its new successor | implemented, not installed; needs the fast-path deploy first | [editor sources](docs/implementing-editors/editor-source.md#3-host-responsibilities), [Native 008](plans/soon/008-complete-native-move-copy-undo-capture.md) |
| Canopy Move to Document as one change (Native 008): moving blocks to another page of the same tree appends one record over both pages whose frame moves their exact source (`moveSource` into the destination, plus re-indentation and separators), with a `transfer` capture of the destination beside the record's document; its basis is decided from record ancestry, and diverged local work is published and retried once before an exact copy. Blocks apart from each other are copied (canopyd 014). Tested by `TransferPlanTests`, the live `Move to Document publishes one change over both pages` (restart replay, a peer edit to the moved paragraph arriving in the destination, diverged local work, the destination open in a second editor), and the cross-page fast-path engine tests | implemented, not installed; needs the fast-path deploy first | [editor sources](docs/implementing-editors/editor-source.md#3-host-responsibilities), [local system](docs/architecture/canopy-browser/local-state.md#change-logs) |
| Canopy conflict review: sidebar navigation, page markers, exact-source comparison and composition, durable grouped drafts, recursive previews, guarded source-range and structural resolution | implemented | [client design](docs/implementing-editors/design.md#synchronization-conflicts-and-devices), [accepted-state review](docs/overstory-spec/09-client-synchronization.md#accepted-state-review) |
| Entry dates and document versions: each file entry's last accepted change and each Markdown document's accepted content versions, kept beside the hashes (schema 16) and served by `/entry-metadata`; Mac and iOS date pages from it and date incoming changes with Canopy's accepted time | server deployed; clients implemented, not installed | [tree reads §1.1.2a](docs/overstory-spec/01-tree-operations.md#112a-reading-entry-metadata), [schema history](packages/canopyd/migrations/README.md#schema-history) |
| Traced entry creation: the `addEntry` authored operation takes the fast path; page creation and a directory's first body no longer publish snapshots | server deployed; clients implemented, not installed | [source intent](docs/overstory-spec/10-source-intent.md) |
| Effect records as piece deltas: `editSource` effects store each edit's range and removed/inserted pieces instead of two whole piece copies; older records are read by recomputation | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md#retained-state) |
| Communities, accounts, and directory: a host serves community plus person/group profile trees, derives an authorization-preserving user directory with names and avatars, reserves account paths, and reconciles synchronized account configuration; native People and Share surfaces cache and search that directory; `arbor me create` / `me set` manage the local profile | directory implemented, account core deployed and installed | [accounts and devices](docs/overstory-spec/04-accounts-and-devices.md), [client design](docs/implementing-editors/design.md#profile-control-and-claim), [deployment](packages/canopyd/deploy/README.md) |
| Native sidebar Trees mode, People footer, and single-pane profile/sync/devices management with focused account and identity actions on Mac and iOS | implemented, not installed; macOS and iOS builds passed, manual UI verification pending | [client design](docs/implementing-editors/design.md#profile-control-and-claim) |
| Plural local accounts and devices: one data home holds several host accounts, including several at one origin, in `account.yaml`, `trees.yaml`, and `devices.yaml`; Mac-to-iPhone pairing | installed, verified | [local system](docs/architecture/arborsync/data-home.md#data-home) |
| Short-lived cloud workspaces: reusable one-account bundles, exact placements under an isolated root, detached Arbor Sync, explicit finish, bundle revocation, `arbor status` | implemented | [CLI](docs/getting-started/cli.md#short-lived-cloud-sessions) |
| Declarative collection schemas: `schema.cddl` in the Overstory CDDL profile, one collection descriptor version (1, naming `schema.cddl`) in TypeScript and Swift, open rows that accept and preserve undeclared members while declared members validate strictly, schema-directed CSV cells, validation that never normalizes, generated collection types without Zod; canopyd acceptance and projection, the merge rules and Arbor Sync providers use the pure `@overstory/collection-schema` package, and QuickJS is no longer a dependency. No collections existed before, so there is nothing to migrate; a `schema.ts` is an ordinary file | implemented, not deployed or installed; the Swift model edits are unverified (no Swift toolchain where they were made; [Mac gates](plans/release-and-soak.md#collection-schema-mac-gates)) | [collection schemas](docs/architecture/collection-schema/README.md), [child backings §2.4](docs/overstory-spec/06-child-backings.md#24-collection-schema-profile) |
| Headless executable-data core: SQLite-backed query lowering and execution over the Supplies corpus, dependency-sensitive live result streams, authorized transactional mutations with durable retry receipts | implemented | [apps runtime](packages/apps-runtime/README.md), [Supplies](examples/supplies/README.md) |
| One merge-state model and squashed history: every acceptance records a merge state (tree creation, pairing, account configuration and boundary rewrites checkpoint their root; no whole-entry conflict rows); schema 18 keeps one accepted update per tree, and migration 016 squashes history to each head, keeping roots, head ids, entry dates and document versions | deployed 2026-09-24 at schema 18; history cut 2026-09-24 by migration 016 | migration 016 (deleted; its runbook is `packages/canopyd/migrations/016-squash-history/README.md` at `d15ddce`) |
| Operational hosting: Railway and VPS deployment, persistent storage, backup and restore, coordinated upgrades, one-off migrations | deployed | [deployment](packages/canopyd/deploy/README.md), [migrations](packages/canopyd/migrations/README.md) |

## In progress

| Area | State | Remaining | Owning plan |
|---|---|---|---|
| Canopy editing and review | implemented, not installed | Additional move/copy/undo capture and interactive acceptance of the implemented review UI | [Native 008](plans/soon/008-complete-native-move-copy-undo-capture.md), [release gate](plans/release-and-soak.md#native-release-and-hands-on-review) |
| Markdown source-transfer policy | paragraphs deployed, not hand-verified; the extensions below implemented, not deployed | Identity-verified paragraph copies and moves reconcile with independent prose edits in either arrival order (deployed). Implemented, not deployed: list items, table rows and contextual links, same-anchor ordering, keyed JSON/YAML members and TS/JS function declaration moves ([transfers](docs/architecture/canopyd/merge-tool.md#transfers)); their deploy and hand checks are in [release and soak](plans/release-and-soak.md#server-refinements). Swift/Python declaration moves, structured moves between files, cross-document fragment and reference links and richer list hosts still require review | [canopyd 014](plans/canopyd/014-merge-handles-many-cases.md) |
| Resource policy providers | deployed | Provider-specific enforcement, source resolution, activation consent, the execution sidecar, observation and soak | [Apps 005](plans/apps/005-source-resolution-and-sidecar.md), [release and soak](plans/release-and-soak.md#manual-recipes-retained-from-the-deleted-checkpoints) |
| Working-tree client transition | installed | The explicit soak closeout | [release and soak](plans/release-and-soak.md#observation-and-soak-closeout) |
| Canopy for the web | not mounted | The browser editor is out of the build until it is rebuilt as a working-tree client over the same machines as the Mac app | [Web 025](plans/canopy-web/025-arbor-web.md) |
| Executable documents | core only | MDX/TSX compilation, generated typing, editor integration, React presentation, activation, Canopy presentation, canopyd hosting | [Apps 001, 003, 005 and 006](plans/catalog.md#product-completion) |
| Group management | implemented, not deployed or installed | Deploy canopyd group membership by Profile TreeID (it matched by handle, so handle-less group members gained nothing) and top-level `/~name` trees for administrators; install the Mac New Group, Members sheet, and People/Share entry points; iOS group creation; claimed-member restoration | [design](docs/implementing-editors/design.md#profile-control-and-claim) |

## Specified but not implemented

- Host-hosted agents and their portable frontmatter contract.
- Static baking and additional portable live-deployment adapters.
- A complete Postgres child provider, observation contract, and bidirectional projections.
- Deferred workspace capabilities: multiple local placements of one TreeID, durable pinned historical placements, reader-local overlays.
- Linux and Windows daemon supervision.

## Known gaps

- **Storage is unbounded.** The per-tree object and byte quotas were removed from update acceptance; nothing bounds retained history, the iOS replica keeps every accepted object, and the retired editor recovery store's directory is left on disk unpruned. An object collector runs by hand over `railway ssh`: `packages/canopyd/src/collect-objects.ts` deletes objects outside the [retention definition](docs/architecture/canopyd/README.md#retention-and-object-collection) the integrity audit also verifies, after a grace period, safely beside a serving canopyd. Rehearsed 2026-09-24 on the 13:13Z live backup after migration 018 (`--delete --grace-hours 0`): 82,725 objects / 247 MB scanned, 2,760 / 116 MB live, 79,965 / 132 MB deleted, 12 s; the objects directory went from 479 MB to 118 MB on disk; `/.arbor/integrity` passed, tree refs matched migration 018's report, and the sidecar replayed every entry the same as on an uncollected copy. `document_versions` alone keeps 2,683 bodies / 106 MB (mostly versions of one 60 KB `_index.md`), so retained document history, not dead objects, is now the growth. First live run 2026-09-24 at build `14b8189c` (backup `.backups/railway/20260924T142722Z/`, sha256 `c10fd5a3…`; default 24-hour grace): 82,741 objects scanned, 2,776 / 116 MB live, 3,438 / 5 MB younger than the grace, 76,527 / 127 MB deleted in 11 s, none absent; `objects/` went from 490 MB to 144 MB on disk; `/.arbor/integrity` passed and a round-trip edit was accepted afterwards. Its schedule and a document-version retention decision are [canopyd 017](plans/canopyd/017-collect-objects-live.md); packing is [canopyd 001](plans/canopyd/001-pack-object-storage.md).
- **Every accepted-state change requires review.** The host requires exact accepted-state guards, so a client must review the latest evidence even when projected bytes are equal or the update is unrelated.
- **Range translation across a merged predecessor** is future work; the host relates an authored predecessor to its accepted projection through a validated or exactly replayed prefix only.
- **Cross-account rehome** (`arbor mv` between Canopy accounts) fails before mutation until a resource-policy transfer contract is reviewed. It worked only for legacy-grammar accounts, and that grammar is gone.
- **Cross-process ownership of a client state directory** is not enforced; one process must own it by convention.
- **Latency.** The target is under 100 ms of server processing for a small fast-forward. Live on 2026-09-24 (255 update requests after the canopyd 016 deploy, all accepted, no 503s): median 48 ms, p90 302 ms, max 1.4 s; single fast-forwards 39 ms median; requests that asked the sidecar 201 ms median, the slowest being batched catch-up uploads of 5–12 updates (0.4–0.9 s in the sidecar) and slow client uploads. Locally, from the client, a plain traced edit on the head takes 2 ms with 1 file, 8 ms with 110 and 41 ms with 1,000 files in one directory, so the 20 ms target at 1,000 files is not met; no live directory exceeds 63 entries. The first merge after a restart replays history (the production main tree's 282 entries in about 1.2 s locally, an estimated 3.5–4.5 s live) and answers retryably past 10 s; saved sidecar states (below, not deployed) make it replay only from the nearest save.
- **No accepted-history listing.** Known retained roots are readable as immutable snapshots by callers who can read the tree; there is no history or metadata route. Retained accepted history starts at migration 016's cut (each tree's head then); document versions and entry dates from before the cut are kept. The log entries of canopyd 016 hold that history as a hash chain, which a listing can walk. [canopyd 007](plans/canopyd/007-document-history-routes-and-restore.md) owns it.
- **Compatibility cutoff.** Account configuration is v2-only and `trees.yaml` is resource-rule grammar only: the legacy `subject` / `access` rules are rejected by the TypeScript and Swift readers, canopyd and the CLI (check 017 found none before the 2026-09-24 deploy). Workspace registries require complete object records; scalar group-member entries are a separate legacy input format.
- **Production recovery, dispute handling, and high availability** are not productized; the deployment guide documents backup, restore, and coordinated upgrades only.

## Where work is tracked

- [Outcome menu](plans/README.md), a short set of choices with open priorities.
- [Detailed catalog](plans/catalog.md), every retained plan and design candidate.
- [Release and verification](plans/release-and-soak.md), outstanding installation, deployment, hands-on, and soak checks.
- [Open questions](plans/open-questions.md).

## Overstory identifiers and UI copy — 2026-09-24

Implemented; Swift unverified; Mac app build and install pending. Cleanup 006
finished the vocabulary rename in code: identifiers and user-visible copy
only. No wire bytes, JSON fields, routes, on-disk or database names, keychain
services, bundle identifiers or conformance vectors changed; the iOS
`wire-format` marker keeps its name.

| Concept | Old | New (TypeScript and Swift) |
|---|---|---|
| Protocol client and its errors | `WireClient`, `ArborWireClient`, `WireHTTPError`, `WireTransportError`, `WireUnsupportedOperation`, `WireUpdateConflict`, `ArborWireValidationError` | `ProtocolClient`, `ProtocolHTTPError`, `ProtocolTransportError`, `ProtocolUnsupportedOperation`, `ProtocolUpdateConflict`, `ProtocolValidationError` |
| Protocol objects and models | `Wire<Name>` / `wire<Name>` (e.g. `WireDirectoryEntry`, `encodeWireDirectory`, `WireSnapshot`, `WireObjectCodec`, `decodeWireCollectionFile`, `WireProjection`, `mergeWireTrees`) | `Protocol<Name>` / `protocol<Name>` (`ProtocolDirectoryEntry`, `encodeProtocolDirectory`, `ProtocolSnapshot`, `ProtocolObjectCodec`, `decodeProtocolCollectionFile`, `ProtocolProjection`, `mergeProtocolTrees`) |
| Account client | `AccountWireClient`, `accountWireClient`, `wireFor` | `AccountProtocolClient`, `accountProtocolClient`, `accountClientFor` |
| Other Swift protocol types | `ArborWireReplicaTransport`, `ArborSSEParser`, `ArborSSEFrame`, `WireURLProtocolStub` | `ProtocolReplicaTransport`, `ProtocolSSEParser`, `ProtocolSSEFrame`, `HostURLProtocolStub` |
| The host (canopyd, or a host a client talks to) | `CanopyDaemon`, `serveCanopy`, `CanopyTree`, `CanopyAccount`, `CanopyAccountStore`, `CanopyAccountRecord`, `CanopyObjectStore`, `CanopyWatchRunner`, `NativeCanopyAccount`, `createCanopySchema`, `openCanopyDatabase`, `CanopyDeploymentConfig`, `claimCanopyAccountBootstrap` | `HostDaemon`, `serveHost`, `HostTree`, `HostAccount`, `HostAccountStore`, `HostAccountRecord`, `HostObjectStore`, `HostWatchRunner`, `NativeHostAccount`, `createHostSchema`, `openHostDatabase`, `HostDeploymentConfig`, `claimHostAccountBootstrap` |
| `account.yaml` | `CanopyAccountConfiguration(Snapshot)`, `load/parse/watchCanopyAccountConfiguration(s)`; Swift `ArborAccountConfigurationYAML`, `ArborHostedTreeDeclaration`, `ArborResourceDeclaration`, `ArborAccountAccessRule` | `AccountConfiguration(Snapshot)`, `load/parse/watchAccountConfiguration(s)`; Swift `AccountConfigurationYAML`, `HostedTreeDeclaration`, `ResourceDeclaration`, `AccountAccessRule` (matching the TypeScript names) |
| The Canopy app and editor | `Arbor<Name>` in `swift/CanopyApp` and `CanopyEditor` (`ArborAppModel`, `ArborRootView`, `ArborDocumentBinding`, `ArborEditorHost`, `ArborMarkdownCodec`, …) | `Canopy<Name>` |

Files followed their types: 12 `swift/CanopyApp/Arbor*.swift`, four
`CanopyEditor` `Arbor*.swift`, 11 Overstory/CanopyWorkingTree `Wire*.swift`
and `ArborWireClient.swift`/`ArborSSEParser.swift`, and
`HostObjectStore.swift`/`HostWatchRunner.swift`; in TypeScript
`packages/client/src/account-client.ts`, `packages/fs/src/protocol-tree.ts`,
`tests/unit/protocol-client.test.ts`,
`tests/unit/canopyd/projection-collections.test.ts`, and the fixture
`tests/fixtures/canopy/merge.json` (was `wire-merge.json`). Names that still
say Arbor name the local tools (`ArborSync*`, `ArborRemoteLocator` and
`buildArborLocator` for `arbor://`, `generateArborID`, the data-home
`useArbor` identity choice). UI copy now names Canopy for the app and
Overstory for trees ("Make This an Overstory Tree", "Canopy is up to date",
"Disconnect this iPhone from Overstory?", "Opening Canopy…", "Nested Overstory
tree", the permission prompts, and canopyd's access page). Host-meaning
"Canopy" in app copy ("People on this Canopy", "Canopy refused a change") and
runtime error messages that say "Wire" were left for a copy decision.

Verified on Linux with Bun 1.3.14: `bun run typecheck`, `bun run build`, the
canopyd-merge suites (335 passes), `bun run build:cli:package`,
`bun run test:cli:package` (12 passes), `bun run check:links` and
`git diff --check` pass. `bun run test` has 1,332 passes and 14 failures, all
in the known environment set (libsecret, sidecar restart, workspace
discovery, client-generated profile bootstrap, journal compaction, a
node-query race that passes alone). Not verified: every Swift rename is
uncompiled, and `swift/Canopy.xcodeproj` was hand-edited for the renamed app
files and must be regenerated with xcodegen on a Mac; the gates are in
[release and verification](plans/release-and-soak.md#overstory-identifier-rename-mac-gates).

## Native 011 account service — 2026-09-25

Decided and implemented in source, not compiled or installed. Joe chose
option 1: **the data home stays the owner of a Mac's identity and account
credentials.** The daemon keeps its onboarding routes (`POST /v1/me`,
`/v1/me/restore`, `/v1/me/backup`, `POST /v1/bootstrap/accounts` and
`/accounts/cancel`, `POST /v1/bootstrap/pairings/claim`), `GET /v1/accounts`,
`GET /v1/credential` and `POST /v1/placements/move`; the iPhone keeps its own
keychain stores. No storage, route or wire format changed on either platform,
and there is no migration.

The app's account operations now go through one Swift protocol,
`CanopyAccountService` (`swift/CanopyApp/CanopyAccountService.swift`), chosen
once per platform by `CanopyWorkspaceState.accountService`:
`KeychainAccountService` on iOS (over `NativeAccountService`,
`KeychainDeviceCredentialStore` and `KeychainProfileIdentityStore`) and
`ArborSyncAccountService` on macOS (`swift/CanopyApp/ArborSync/`, over the
daemon's REST client and `ArborSyncCredentialProvider`; it uses the connected
daemon and never launches one). The surface is `state()` (accounts, identity,
pending claim and pairing), `accounts()`, `credentialProvider(configurationTree:)`
(and `client(for:)` on top), `createIdentity`, `restoreIdentity`,
`backupIdentity`, `claimAccount`, `cancelPendingClaim`, `claimPairing`,
`resumePairing` and `forget`. What only one store can do is declared in
`capabilities` and otherwise throws `CanopyAccountServiceError.unsupported`:
the iPhone cannot restore or back up an identity file, cancel a claim or
resume a pairing without its payload; the Mac cannot forget an account (the
daemon has no such route).

The account-operation forks in `CanopyAppModel.swift` collapsed: directory
refresh, avatar loading, the account lookup behind opening a profile (the
iPhone-only `connectedConfigurationTree` is gone), the credentialed client for
visits, profile resolution and group creation (the Mac-only `protocolClient`
is gone), and pairing offers (`createPairingOffer`, now shared). The Mac
onboarding and account panel and the iPhone launch, Place a Tree and Sync &
Accounts views call the service instead of the REST client, `NativeAccountService`
or the keychain stores. Behavior notes: the iPhone's directory refresh now
walks its accounts rather than its placements (a pre-account placement with no
configuration tree is no longer refreshed), and an avatar or profile lookup at
an origin with no account is anonymous on both platforms; the Mac reads
`GET /v1/accounts` once more per directory refresh.

Forks that remain are not account operations: tree access and resource
consent (the Mac edits the data-home checkout of the configuration tree and
asks the daemon to push it, the iPhone updates the host directly), which
sidebar trees and nested trees are placed (daemon placements or the app's
native placements), and opening a profile (the Mac visits it, the iPhone
places it).

Verified on Linux: `bun run typecheck`, `bun run check:links` and
`git diff --check` pass. Not verified: every Swift change is uncompiled, and
`swift/Canopy.xcodeproj` was hand-edited for the two new files and must be
regenerated with xcodegen on a Mac. The plan is deleted; its Mac gates are in
[release and verification](plans/release-and-soak.md#native-011-mac-gates).

## Native 011 daemon-client folds — 2026-09-24

Implemented, not installed. Both daemon clients now live with their only
caller: the TypeScript `ArborSyncRESTClient` is `packages/cli/src/daemon-client.ts`
(the `@overstory/arborsync-client` package, its workspace entry and root
dependency are deleted; `tests/unit/protocol.test.ts`,
`tests/integration/{server,self-sync,cli-sync}.test.ts` import the CLI module
and `swift/scripts/hosted-smoke.ts` posts its claim directly), and the Swift
client is Mac app code in `swift/CanopyApp/ArborSync/` behind `#if os(macOS)`
(the `ArborSyncClient` package is deleted and dropped from `project.yml` and
`CanopyEditor/Package.swift`; its tests are in `CanopyAppTests`, the provider
contract in `CanopyWorkingTreeTests`, and the protocol gate runs the moved
suites through `xcodebuild`). The daemon no longer serves
`POST /v1/bootstrap/pairings` or `POST /v1/local/forget`; the Mac creates
pairing offers on the host with the account credential, as iOS does. The
Mac's data-home identity, claim and pairing-claim routes, `GET /v1/accounts`,
`GET /v1/credential`, `POST /v1/placements/move` and `POST /v1/held/discard`
are kept after the source audit: there was no Swift writer for the data
home's identity store, the CLI has no claim command, `arbor status` may target
a cloud-session daemon, and `arbor mv` needs the daemon to pause and relocate a
watched root. The daemon and iOS keep credentials in different stores, so the
[account service](#native-011-account-service--2026-09-25) records the
ownership decision that followed.

Verified on Linux with Bun 1.3.14 on top of `5145569`: `bun run typecheck`
passes. `bun run test` has 1,163 passes and 19 failures against 1,168 and 14
at `5145569` in the same environment (libsecret, iCloud, sidecar timing). The
five extra failures are in files this change does not touch (canopyd-merge
tool, child provider, protocol objects, tree-merge, Wire client transfer)
and those files pass 89/89 run alone. With `ARBOR_CREDENTIAL_STORE=file`
the server, self-sync, cli-sync, cli-mv, cli-rehome, local-handlers,
protocol and community-hosting suites pass 74/74 both before and after.
`bun run build`, `bun run build:cli:package`, `bun run test:cli:package`
(12 passes), `bun run check:links` and `git diff --check` pass.
`bun run test:protocol` (file credential store) passes its TypeScript suites
and live daemon setup and stops at the first Swift step: this machine has no
Swift toolchain or `xcodebuild`.

Not verified: every Swift edit is uncompiled. `swift/Canopy.xcodeproj` was
edited by hand to match `project.yml` and must be regenerated with xcodegen on
a Mac; `CanopyEditor/Package.resolved` was left unchanged. The remaining Mac
gates are in [release and verification](plans/release-and-soak.md#native-011-mac-gates).

## Declarative collection schemas — 2026-09-24

Apps 007 is implemented and tested, not deployed or installed. A collection's `schema.cddl` is parsed and
checked under the profile in [child backings §2.4](docs/overstory-spec/06-child-backings.md#24-collection-schema-profile)
by `@overstory/collection-schema`, which executes no code and has no
filesystem or network access; `apps-runtime` lost its QuickJS sandbox and its
QuickJS, Zod and `csv-parse` dependencies. Rows are open (2026-09-25, Joe's
decision): the `row` map accepts undeclared members, Markdown frontmatter keys
and CSV columns, as if it ended with `* tstr => any`, and preserves them exactly;
declared members, the primary key and the child name stay strict, and nested
maps are closed unless they declare `* tstr => any`. No collections existed
anywhere, so descriptor version 1 names `schema.cddl`, there is no retired
`schema.ts` policy or converter, and a `schema.ts` is an ordinary file.
Evidence:

- `tests/unit/collection-schema.test.ts` passes every
  [`collection-schemas.json`](docs/overstory-spec/conformance/collection-schemas.json)
  vector: syntax (including the open-map entry and its rejections), metadata,
  values (undeclared row members accepted, closed nested maps rejecting them),
  CSV conversion and encoding (undeclared columns as optional text), malformed
  UTF-8, budgets (tokens, nodes, rules, depth through references, expanded
  size, choices, members, source bytes, row and collection steps), numeric
  edges and deterministic diagnostics. The accepted vectors of the first
  implementation also parse in the independent `cddl` 0.23.0 parser
  ([coverage notes](docs/architecture/collection-schema/README.md#parser-choice)).
- `tests/unit/collection-schema-types.test.ts` typechecks generated
  declarations, including the open row's index signature, without authored
  modules or Zod; `tests/unit/collection-schema-boundary.test.ts` checks
  manifests, the lockfile and the bundled module closures of canopyd, the merge
  worker, `tree-merge`, Arbor Sync and `arbor`, and runs acceptance decoding,
  projection, merge and local reads with QuickJS made unavailable.
- Host, merge and provider tests: `snapshot-acceptance` (valid and invalid
  CDDL collection updates, a recomputed child-set hash, an undeclared member
  stored byte-exactly, public projection), `projection-collections`,
  `tree-merge/update-merge` (typed CSV rows and undeclared CSV columns merge and
  re-encode), `collections` and `workspace` (CSV text keys stay exact,
  undeclared columns, members and frontmatter are preserved, a page ID minted
  by a move needs no declaration, `schema.ts` is ordinary, database backings,
  generated types).
- Measurements, against the retired sandbox's 214 ms cold compile and 44 µs
  per row: 4.5 ms and 0.8 µs for an ordinary schema; profile-maximal inputs and
  the bounded cache are in [the architecture](docs/architecture/collection-schema/README.md#measurements).

## Arbor Sync downloads iCloud placeholders — 2026-09-24

Implemented on branch `claude/arborsync-icloud-dataless`, not merged or
installed. Joe's placed folder in iCloud Drive (Optimize Mac Storage) went to
`sync: error` because the launchd daemon's reads of evicted, dataless files and
directories failed with `EDEADLK`: a launchd agent starts with the kernel's
dataless-materialization policy off. The daemon now turns that policy on for
its own process at startup, so reads download placeholders instead of failing,
and a residual `EDEADLK` is logged as `cloud-placeholder` rather than
`io-error` ([cloud placeholders](docs/architecture/arborsync/data-home.md#cloud-placeholders)).
Verified by unit tests, including a real macOS subprocess that starts with the
policy off; no evicted file was read, because the test may not touch iCloud
Drive. The Canopy app's working trees live in Application Support, outside
iCloud, and are not exposed.

## Clients 001 phase 4: TypeScript runner and daemon — 2026-09-24

On `main` and running on Joe's Mac since 2026-09-24. The installed daemon's
three trees were clean; the new daemon retired their `sync/<tree>.json` files
and came back idle on the same accepted updates. A live round-trip on the
Console tree (arb.nxhx.org) published a new file in 1.3 s and its removal in
1.2 s through the watcher alone, leaving no retained request. The longer soak
is on Joe's own list. Clients 001 closed the same day; its plan is deleted (git
history). Its follow-ups: held folders in the Mac app
([Native 012](plans/swift/012-show-held-folders.md)), the browser client
([Web 025](plans/canopy-web/025-arbor-web.md)), a Hetzner sync lab run
([release and soak](plans/release-and-soak.md)), and History on
working trees ([open questions](plans/open-questions.md)).
**Runner.** `@overstory/working-tree`
holds `reduceUpdate`, `LocalChange` preparation, entry transfer, the
`UpdateControl` codec (Swift's schema 4) and `UpdateCoordinator`, a port of the
Swift runner over a change log, a control store, a transport, and an accepted
tree; `./node` holds the file-backed `ChangeLog` (moved from
`@overstory/client`'s source admission queue, adopting an earlier
`source-admissions.json` in place) and `FileControlStore`.
`SourceAdmissionPublisher` and `SourceDocumentSession` are deleted. Evidence:
`tests/unit/update-runner.test.ts` executes all nine runner vectors of
`tests/fixtures/update-runner.json`; the canopyd source-acceptance test
publishes a stale change through the runner against a real canopyd, restarts,
continues it and follows a resolution; `tests/unit/change-log.test.ts` covers
adoption and discard.

**Daemon.** Arbor Sync runs one `FolderSync` per placed folder
(`packages/arborsync/src/folder-sync.ts`): the folder is the runner's accepted
tree and its only source. Watcher events schedule a scan; a changed root
appends a sparse `trace: null` change against what the folder last held;
accepted bytes are written only when nothing is pending and the folder still
holds what it last wrote or scanned; the machine polls at the old sync
interval. A refusal is held (`sync: "conflict"`) until `POST /v1/held/discard`,
which rewrites the folder to the host's state. Both runners now hold any 4xx
refusal except 408 and 429, not only a 409. Deleted: `TreeSynchronizer`, the
pending and conflict formats of `sync/<tree>.json` (a clean one is retired, one
with work is refused), the conflict workspace, `/v1/conflicts*`,
`reviewableConflict`, and the Swift `ArborSyncClient` conflict API. Evidence:
`tests/integration/self-sync.test.ts` (8 scenarios, including a held refusal
across restart and its discard, and a transmitted chain a same-credential peer
extends, replayed by digest without a merge); the server, CLI, placement-move
and community-hosting integration suites; `bun run test` (1182 passing);
`CanopyWorkingTree` 105 and `ArborSyncClient` tests; the hosted smoke (50,
including the signed app editing a placed tree through its bundled daemon).
Not run: a soak with Joe's live placements, and the Hetzner sync lab, whose
binary scenario now expects an accepted alternative instead of a daemon
conflict.

## Log entries and one merge question — 2026-09-24

Deployed 2026-09-24 at schema 19 by migration 018, from schema 18 (build `dd5313c8`),
together with the merge boundary below (canopyd 016 steps 1 to 7 and the documentation).

- **Cutover.** Backup `.backups/railway/20260924T131328Z/` (sha256 `7468b0d3…`; 5 trees,
  22 accepted updates). Check 017 found no legacy `trees.yaml`. The live run reported
  exactly the rehearsal's heads (roots, update ids and entries), 22 entries,
  `unmappedResolutions` 0, `nextOrdinal` 4346, 147 ms. `verify.ts --sync` passed; the
  Mac's authored-file manifest was unchanged; placements resumed without re-place. A
  round-trip edit was accepted as 4346, whose entry names the migrated head's entry,
  and its deletion as 4347. The cold rebuild of the longest chain (18 entries) took
  120 ms on the rehearsal copy.
- **Conflict lab** (`swift/scripts/conflict-lab.ts`, local canopyd on this build): every
  scenario merges or records its decisions on a fresh tree, and `keep-editing`
  fast-forwards three plain edits over an open decision. A traced edit after
  `kind` then `delete-edit` was refused with "Operations do not reproduce the complete
  candidate" (the pre-cutover build `0fa5c565` too). Cause, in the sidecar: with an
  entry-kind choice open, the delete/edit became a root choice keeping the current
  tree, recorded as not editable, so the next evaluation's complete scan enforced the
  declined deletion on the kept tree. Fixed after this deploy, not yet deployed: a
  kept result is as editable as current, and every choice narrows the deletions it
  declines so that no complete scan, merge from a basis before the choice, or later
  edit after its resolution cuts what it kept (acceptance and differential tests).
- **Rebuild budget** (after the deploy, not deployed): a cold sidecar rebuild replays
  each chain from its start at about 17 ms an entry (110 files, locally; 30 ms at 200 and
  125 ms at 1,000), and chains only grow, so a restart would eventually leave a tree whose
  rebuild outlasts canopyd's 30-second timeout, which ended the process and lost the
  progress: every snapshot and concurrent merge on that tree would then fail. One question
  now replays for at most `ARBOR_MERGE_REPLAY_MS` (10 s), answers retryably and keeps its
  progress (`replay-budget.test.ts`). Starting replay at every 64th entry instead was tried
  and rejected: the stale-edit acceptance test showed an imported start drops the current
  side's attribution for any merge whose base precedes it. The replay cost itself, a
  per-file cache, is a [candidate](plans/catalog.md#hardening-efficiency-polish-etc).
- Not deployed with it: the iPhone app (no wire change was required).

- **Log entries.** Every acceptance path (client updates, tree creation, pairing,
  account configuration, boundary rewrites) writes an `overstory-log-entry-v1` object
  before its transaction; `accepted_updates.entry` names it (schema 19) and
  `accepted_merge_states` is gone. Decisions live only in entries; inspection pages,
  guards and alternative bindings read them with the old public ids. An entry also
  records how the sidecar was asked (`asked`), beyond the plan's shape, so any sidecar
  can ask the same question again; a source choice is kept as a range with each
  alternative's bytes, beside the plan's whole-root alternatives.
- **One question.** Checkpoints, intent requests, decision reports, snapshot tree
  requests and `retention-audit` are gone from the contract. Snapshot choices (one per
  conflicting entry or folder, attribution, continuing a hidden alternative) moved from
  canopyd into the sidecar. A batch suffix names its base entry and the earlier
  candidates as `prefix`.
- **Fast-forward.** `checkPlainTrace` in `@overstory/protocol` (the former test-support
  `validateSourceTrace` family moved beside it) accepts `editSource` and `addEntry`
  frames canopyd reproduces exactly and no open decision concerns; misses are logged
  with their reason. canopyd's own acceptances write entries without the sidecar when
  no decision is open.
- **The sidecar** keeps engine states per entry and their objects in memory only
  (`ARBOR_MERGE_CACHE_MB`), rebuilt by replaying entries from each chain's start and
  aligning to them, and reuses the last 32 solved questions. The engine and its state
  format are unchanged; the plan's per-file cache (step 6's last part) is not done.
- **Reference sidecar.** `tests/support/reference-sidecar.ts`, 114 lines, no cache,
  three-way file merge with a whole-file choice, passes canopyd's rule-agnostic
  acceptance cases in `reference-sidecar.test.ts`.
- **Migration 018** (schema 18 to 19) writes one chained entry per accepted row from its
  merge-state record, keeping decision keys, and drops `accepted_merge_states`; its test
  serves every recorded conflict page unchanged afterwards. It has not been rehearsed or
  run.

Evidence: `bun run typecheck` is clean. `bun run test` passes all but 13, the same 13
that fail on the base revision in this container (no libsecret). After every scenario in
the source and snapshot acceptance suites (73), each accepted entry's recorded question
was asked again from a warm cache and, for the latest entries, a cold one, and gave the
entry's root and decisions; that check found fast-forwarded entries carrying stale
entry-choice alternative roots, now rebased. Migration 018's suite passes, including a
cold rebuild of each head. Measured locally with `snapshot-acceptance-cost.ts`
(median ms, 1 / 200 / 1,000 files, previous build first): traced fast-forward 26 → 9,
72 → 42, 237 → 155; snapshot on the head 23 → 23, 71 → 68, 250 → 251; concurrent
snapshot pair 59 → 51, 217 → 178, 804 → 661; snapshot beside an open choice 19 → 29,
78 → 92, 267 → 338. Not run: the Swift half of `test:protocol` (no toolchain here;
no wire format changed), the plan's differential run of the old worker against the new
sidecar on replayed production history, and the cold-rebuild measurement on a
production copy.

## Clients 001 phases 0–3 — 2026-09-24

Merged to `main` 2026-09-24; Joe ran the branch build on the Mac as his daily
client and tested it extensively; Joe installed it on the iPhone the same day and
confirmed it works. One update machine
now serves every working tree; editors append local changes to a change log.

- **Machine and spec.** Spec 09 describes local changes and the change log;
  the machine gained `held` (rejected or unsupported), polling, explicit
  `syncRequested`, `recovered`, `settle`, `applied(installed:)`, clean-tree
  and hanging-request transport loss, and watch-as-transport evidence. Both
  reducers pass `client-state-machines.json`; the document admission machine,
  its fixture section and both of its reducers are deleted.
- **Swift runner.** `UpdateCoordinator` performs every effect; no phase writes
  or duplicate flags remain, submissions run on their own task, and failures
  are classified. `SourceAdmissionQueue` became `ChangeLog` (journal adopted
  in place); review resolutions are change-log records; the snapshot head,
  next base and immediate patch path are deleted. `UpdateControl` schema 4
  refuses earlier pending work without rewriting it. The app polls every 30 s
  and offers Discard Refused Changes.
- **Editor.** `EditorSource` (CanopyAppKit) appends each generation and
  acknowledges on durability; `ArborDocumentBinding` keeps capture, keystroke
  guards, self-acknowledgement and anchored re-reads. `EditorRecoveryStore`,
  `DocumentAdmissionMachine`, conflict analysis, the Review Edit Conflict UI
  and the compare-and-swap admission policy are deleted.
- **Verification.** `bun run test:protocol` passed (including live Canopy
  change-log, review and editor suites); CanopyWorkingTree 105 tests including
  runner vectors; CanopyEditor 58 through `test-canopy-editor-local.sh`;
  CanopyAppKit 25; CanopyAppTests 50; the Mac app builds from
  `Canopy.local.xcworkspace`. After merging `main`, the protocol gate and
  `swift/scripts/hosted-smoke.ts` (50 tests, run with a separate bundle id
  because Joe's Canopy was open) passed.

## Merge boundary — 2026-09-24

Implemented on `claude/merge-tool-canopyd-api-dcic82` on top of the one merge-state
model; deployed 2026-09-24 with migration 018 (build `dd5313c8`). canopyd no longer imports `@overstory/canopyd-merge`: the two
share `@overstory/object-store` and the new `@overstory/merge-protocol` (request and
response schemas, decision reports, rule summaries, error codes). canopyd dropped its
copy of the sidecar's state validator (proofs, history caches, typed retention and
the startup warm-up that primed them) and builds each merge state from the
sidecar's decision reports instead of reading its state; the integrity audit asks
the sidecar to walk its retained closure. The sidecar's now-unused validation code
is deleted. Account configuration is merged in canopyd beside its authorization, and
`trees.yaml` accepts only the resource-rule grammar in TypeScript and Swift, so
cross-account `arbor mv` now refuses until a policy transfer is reviewed. A host
fast-forward that skipped the sidecar was reverted when this work was ported onto
the one merge-state model; it is to be redesigned.

Evidence: `bun run typecheck` is clean; `ARBOR_CREDENTIAL_STORE=file bun run test`
passes all but 4, which also fail on `main` in this container (missing
`react/jsx-dev-runtime` twice, one surrogate byte-offset case, one
unreadable-directory case as root); the merge suites pass all but the same
byte-offset case. The Swift half of `bun run test:protocol`, `swift test` and the
`Canopy` build were not run (no Swift toolchain in the Linux container), so the
Swift reader change was not compiled there; it compiled and `bun run test:protocol`
passed on macOS before the deploy, and check 017 ran clean against the cutover backup.

## One merge-state model and history squash — 2026-09-24

Deployed 2026-09-24 at schema 18 by migration 016, from schema 17 (build `3d3ebc98`).
**Accepted history was cut on 2026-09-24:** each tree keeps only its head update, so
cursors and states older than a head answer as not retained.

Stage 1: every acceptance records a merge state (tree creation, pairing, account
configuration and boundary rewrites checkpoint their root), and nothing writes whole-entry
conflict rows. Stage 2 requires schema 18 and deletes the code that served older rows: the
conflict and authored-intent stores and their fallbacks, checkpoint replay with
`checkpoint-batch`, the whole-piece effect fallback and other legacy defaults (about 600
fewer lines of host and merge-tool code, and 1,500 lines of retired migrations 013 to 015).
Migration 016 (deleted; its runbook is `packages/canopyd/migrations/016-squash-history/README.md` at `d15ddce`) kept each tree's
head (root, ordinal and so wire id, receipt), gave it a fresh editable merge state, dropped
everything older, and kept entry dates and document versions.

Evidence: the replay check re-accepted the backup's last 30 client updates on the three
ordinary trees through this build with every root and conflict flag matching. The live
run matched the rehearsal exactly (5 heads, roots unchanged, 2,742 updates removed,
`nextOrdinal` 4329); `verify.ts` passed against the live host with the Mac's sync; the Mac
resumed at its heads without re-placing, with an empty authored-manifest diff; a round-trip
edit was accepted as 4329 on the head 4328 and its deletion as 4330, restoring the root.

Costs carried forward: a snapshot now costs a checkpoint linear in the tree's nodes (on a
synthetic 1,000-file tree a snapshot fast-forward went from about 90 ms to about 380 ms,
`tests/performance/snapshot-acceptance-cost.ts`); an incremental checkpoint that
path-copies the active state, as the traced fast path does, is the follow-up if folder
sync of large trees matters. An unavailable merge worker refuses every acceptance,
including tree creation, pairing and account claims, with a retryable 503. Squashed
objects stay in `objects/`, unreferenced (see Known gaps).

## Accepted-history compaction — 2026-09-22

Deployed 2026-09-23 at schema 17 by migration 015, from schema 16. It removes stored copies of accepted
history: `observations` becomes `accepted_updates.ordinal` (unchanged cursors for every
accepted update), `reflog` is dropped, `authored_changes` keeps only the trace and
evidence, and the unread `accounts.token_digest` is dropped. `AcceptedUpdateStore.advance` is now the only writer of `trees.ref`. A merge
that records decisions reads only its own tree's legacy conflict rows instead of every
row in the database. See the
[schema history](packages/canopyd/migrations/README.md#schema-history); the migration
directory is deleted and lives in git history.

## 2026-09-21 onboarding and package verification

Bun 1.3.14: typecheck, build, protocol, performance (50,000 files), and the
244-test merge suite passed. The focused identity/challenge suite passed all
20 tests, including corrupt metadata, unavailable/mismatched keys, recovery,
community-only lookup, ambiguous reservations, and a lost successful claim
response resumed by a fresh client. Shared challenge fixtures are consumed by
both TypeScript and Swift. Swift ArborSyncClient, Overstory, and OverstoryClient
suites passed; the latter includes legacy-identity reconciliation decisions.
Mac and iOS Simulator builds passed with the local Quagmire workspace.

The full product suite recorded 1,121 passes and one existing failure:
`places an existing private tree through its matching account` times out waiting
for adoption of the destination placement. The same failure reproduced in a
separate committed-source checkout, with only file-backed test identity storage
and the already-used csv-parse dependency supplied for isolated execution.

A packed CLI installed outside the checkout completed cloud start/edit/status/
finish/retry/revocation on macOS arm64. Its full CLI suite had 11 passes and the
same placement failure. The durable installed helper started after the package
cache was removed. The app-bundled helper started with only system tools on PATH
and created an identity in disposable file-backed state. This is helper/runtime
evidence, not a manual clean-machine app or Login Items approval walkthrough.
No installed app, live data, public host, or npm publication was changed.

Manual onboarding/QR/Keychain UX and package execution on macOS x64 and Linux
glibc arm64/x64 remain release checks. `bun run test:cli:package` reproduces the
packed-artifact and cache-removal checks; it reports the existing placement
failure rather than suppressing it.

### Onboarding recovery fixes

Identity installation now serializes across processes and saves a verified secure
recovery record before binding the profile folder. Keychain write denial is
retryable; missing public metadata and interrupted installation resume the same
identity. Moved data homes retain stored credential references. Legacy keys remain
intact, and explicit matching-backup repair preserves damaged metadata bytes.

Community preparations can be cancelled before submission and no longer create
account checkouts on failed address lookup. Possibly submitted claims retain their
exact request for retry. Mac onboarding accepts pairing codes for already-claimed
accounts; ArborSync persists the pairing before contact and verifies the returned
profile/device before installing the account. The UI exposes pending pairing
resume and no longer silently ignores edits to an address behind a pending claim.

Verification on macOS arm64 with Bun 1.3.14: 26 focused identity/community tests
passed, including separate-process creation, denied Keychain writes, lost claim
and pairing responses, and damaged metadata recovery. A separate process-death
lock regression and the protocol dependency-boundary test also passed. Typecheck,
build, ArborSyncClient tests, the protocol gate (on rerun), and Mac/iOS Simulator
builds passed. The protocol gate's first run hit an intermittent CanopyAppKit rename
assertion; that unchanged suite passed standalone and in the rerun. The full product
suite has 1,128 passes and the previously reproduced CLI placement failure above.
The packed CLI has 11 passes and that same failure; its cloud lifecycle and
cache-removal helper check pass. The newly built app helper also starts with only
system tools on PATH and creates a disposable identity. Real Keychain prompts and
manual app/QR interaction remain unverified; all credential failure tests used
mocks or isolated file storage. Older-daemon compatibility was deliberately excluded.

### Native navigation verification — 2026-09-21

The macOS app test build and iOS simulator build passed. Six focused app tests
cover editor-link history, same-tree Home/native pops, save-before-navigation,
cross-tree Back/Forward/native pops, and failed opens; the cross-tree test also
checks that failed Back leaves the editor and trail intact. All nine browser-tab
package tests passed, including observation of Back availability. Tests used a
separate macOS app identity and did not replace the running app. Live UI behavior
has not been manually verified. The broader CanopyAppKit suite encountered the
existing `renameByPageID` failure (the historical Welcome fixture was selected),
also reproduced from an untouched HEAD export. Link and whitespace checks passed.


### Shared source publication performance — 2026-09-21

Implemented locally, not installed or deployed: TypeScript and Swift update
machines select contiguous pending admission chains for one frozen request.
Uncertain requests survive restart unchanged. Both queues compose plain source
generations before building intermediate trees; separate durable change IDs
remain intact. Accepted prefix transport payloads are omitted, canopyd skips
receipt-proven delta reconstruction, and the merger avoids duplicate matching
state validation and an unnecessary full authored-state copy. See
[publication batching](docs/implementing-editors/editor-source.md#7-publication-batching-and-preparation-costs)
for boundaries and local benchmark results.

Verification with Bun 1.3.14: focused publication/host/queue suites passed
(48 tests, then 23 queue tests after adding a 60-generation regression);
CanopyWorkingTree passed 98 tests; ArborSyncClient passed 16. Typecheck, CLI
build, and the 50,000-file performance gate passed. The full product suite had
1,131 passes, the existing CLI placement failure, and a merge-history timeout.
The focused merger rerun passed; the CLI failure also reproduced in an untouched
baseline checkout. The standard protocol gate stopped at the existing AppKit
`renameByPageID` fixture failure, also previously reproduced on untouched HEAD.

The remaining live protocol gate passed with only that known rename test
excluded: ArborSyncClient 16, CanopyAppKit 22, Overstory 44, OverstoryClient 20,
CanopyWorkingTree 98, and live editor admission 5 tests. The structural lost-ack
regression now verifies that all ten queued changes reach the server in the first
batch and recover correctly after restart. Link and whitespace checks passed.


### Scoped conflict continuation and enclosure — 2026-09-21

Implemented locally, not deployed: hidden content successors match their retained
whole-branch context and advance a scoped alternative by provenance. Existing
choices no longer widen independent new content conflicts or automatically add
dependencies. Single-file source transformations that scatter a choice retain a
file enclosure; a newly authored enclosure no longer causes another root-level
conflict merely because it is new. Ordinary plain list editing may merge with
disjoint prose; protected Markdown scopes retain their checks. Evaluation time
exhaustion now maps to retryable HTTP 503 instead of invalid-request 400.

Evidence: the todos decisions at updates 3611–3613 were a Markdown policy refusal
followed by two hidden-branch successors; update 3670 added an enclosure and a
second reconciliation decision. The live tree was only read. These changes do
not retroactively resolve its retained decisions or establish that its pending
request now finishes within the production execution budget.

Verification with Bun 1.3.14: 1,139 product tests passed with the previously
baseline-reproduced CLI placement failure; all 249 focused merger tests passed.
Host tests passed, including HTTP timeout classification without acceptance.
Typecheck, build, performance, links, and whitespace checks passed. The standard
protocol gate encountered the known AppKit rename failure; the remaining gate
passed with only that test excluded (16 ArborSyncClient, 22 CanopyAppKit,
44 Overstory, 20 OverstoryClient, 98 CanopyWorkingTree, and 5 live-editor tests).
The Swift hidden-continuation regression now requires one scoped decision and
verifies that the unchanged newline remains outside its alternatives.

### Live todos continuation repair — 2026-09-21

Deployed scoped conflict handling and a bounded 20-second host evaluation budget
(the standalone merger default remains five seconds). The retained todos request
then exposed stale local directory aliases in newly recorded continuation
contexts. Those aliases now fall back to their immutable state references, both
when capturing an advanced directory and when propagating a nested decision.
Alternatives and decision identities remain retained until guarded resolution.
The host also rejects evaluation budgets beyond the worker schema's 30-second
maximum even when a longer process timeout is configured.

Verification: the exact retained request evaluates locally to its original
candidate; a minimal two-enclosure regression fails before the fix and passes
with repeated continuation and state validation. All 251 focused merger tests,
typecheck, CLI build, link checks, and whitespace checks passed. Live cleanup is
still pending; recovery material is preserved outside version control. The full
product suite passed 1,141 tests with only the known CLI placement failure.

### Deployed continuation repair and live cleanup — 2026-09-21

Railway deployed `9d99135c` (scoped continuation/enclosure), `92d4b021`
(bounded host evaluation), and `f74673db` (immutable directory alternatives).
Deployment `8f78591e-7257-42e7-9b66-afa548319ac2` succeeded. The running Mac
client then published all 14 retained generations as updates 3675–3688 without
restarting or rewriting its recovery journals.

An explicit resolution guarded by update 3688 and all five decisions was
accepted as update 3689 with no remaining conflicts. Its composition preserved
the latest editor candidate and recovered the intended hidden source changes;
the other 61 root entries retained their exact objects. Server reads verified
the composed document bytes and empty conflict inventory. The native accepted
and local roots both matched the server, with no pending request, and the UI
showed Fully synced without a review badge. Exact requests, receipts, original
alternatives, and native recovery copies remain in an ignored local backup.

Follow-up verification passed the 50,000-file performance gate, 16 Swift
ArborSyncClient tests, and the live protocol gate with only the previously
baseline-reproduced AppKit rename fixture excluded. The product suite's sole
failure remains the previously baseline-reproduced CLI placement test.

### Mounted macOS navigation repair — 2026-09-21

The running Mac app reproduced a missing Back control after following the
Picture of Life link from the todos directory document. A mounted-window
regression then demonstrated that SwiftUI's nested `NavigationStack` writes an
empty path while the pushed destination resolves: the browser records the push,
then loses its trail to that callback. macOS now renders the browser's current
page directly in `NavigationSplitView`, leaving Back/Forward and retained editor
presentations under one controller. iOS keeps its native stack.

The regression failed with the old stack and passed with the direct page view;
it covers directory documents, path-to-stable-identity resolution, restoration
of the original editor, and repeated Back/Forward. This source fix has not yet
replaced the running Mac app.

The mounted cross-tree case also exposed a generation task superseding an
already-running destination load; workspace reset now leaves that load alone.
All seven focused app tests passed, including both mounted-window regressions,
and all nine browser-tab package tests passed. macOS and iOS Simulator builds,
relative-link checks, and whitespace checks passed. A signed Mac build is ready
in a temporary derived-data directory; the user's running app was not replaced.

Joe subsequently tested the Mac navigation fix and confirmed that it works.

### Home returns through resolved history — 2026-09-21

Home now reuses the current tree root's resolved entry from the selected tab's
trail, including its stable page key. Previously an address-only root did not
compare equal to that entry, so Home pushed a new visit and discarded Forward
history. The root also correctly disables Home when already current.

The regression failed before the fix for a root with a stable ID. Both keyed
and unkeyed roots now pop two pages, restore the original editor, and retain
those pages in Forward order. All three focused app tests passed (parameterized
Home plus mounted link and cross-tree history); the Mac test build and iOS
Simulator build passed. This follow-up is source-only, not installed.


### Operation frames and lazy history closeout — 2026-09-21

Retired canopyd 010 after checking implementation, tests and the September 19
performance report (`a7acdb01`, formerly `docs/canopy-update-performance.md`).
Frames, per-generation capture/compaction, schema-15 evidence compaction,
on-demand history and path-copy writes are implemented. The editable basis and
structural effects-map difference serve as the deletion watermark; a separate
`deletionsThrough` field was unnecessary. Authority validation still validates
complete semantics; cached map proofs charge their own records/pointers instead
of repeatedly charging their full descendants (`3a69d859`). Retention and warm-up
reuse verified map nodes. This supersedes the literal touched-page proof design.

The retained replay report measured a 640-merge-record production copy: edits on
a live decision fell from 644–685 ms to 75–77 ms, divergent edits to 144–176 ms,
and worker reads from 9.8 MB to about 470 KB. These were local replay measurements.
The current lazy/eager differential and incremental suites passed 15 tests.

Joe confirmed production timing is good on 2026-09-21. The native network log
`~/.arbor/Logs/network-2026-09-21.jsonl` independently records the latest 20
successful updates from 17:54:17 to 18:07:05 UTC: median round trip 462.4 ms,
host total 403.7 ms (343.4–1772.2 ms), worker evaluation 56.5 ms, retention
157.0 ms, and state validation 80.9 ms. These ordinary-use measurements do not
prove the old sub-200-ms whole-host target or that all 20 edits had live decisions.
Production behavior is accepted; storage packing/accounting remains canopyd 001.
Undo is an ordinary edit; the retired causal-undo journal had reached 432 records,
75 MB and 7.2 seconds per admission. Retained history remains unbounded.

Gap closed 2026-09-22 (`f83194c8`): `checkpointIntent` never enabled the lazy
path, so a snapshot candidate (a page created beside a traced edit) loaded the
whole history DAG, 12.7k reads on `/~joe/todos`, and hit the 5 s budget on every
retry; the worker's error was then hidden behind a response-schema complaint
returned as a 400. Checkpoints now detect an editable state as `run()` does, and
worker failures surface as `merge-failed`. Follow-ups were canopyd 011 (traced
page creation) and 012 (effect-record size), both closed out below.

### canopyd 011, 012 and 013 closeout — 2026-09-22

Retired all three after checking implementation, tests and the live cutover
(migration 014, deployed at `5ef1fe20`; client dates in `7e018693`).

- **012 effect piece deltas.** Only `editSource` effects carry the delta; move,
  copy and entry effects keep their pieces because the competing-move check
  reads `moveSource` before-pieces. Tests check that the stored delta equals the
  legacy recomputation, that record size stays flat as piece counts grow
  (21.9 KB → under 9 KB at 60 edits), and that the retained object set is
  unchanged. No stored history was migrated.
- **011 `addEntry`.** Clients emit it from the creation record and for a
  directory's first body. Sidebar `createMarkdown`/`createDirectory` actions
  still publish snapshots (open follow-up). A concurrent same-name addition
  leaves the existing whole-directory choice, as two moves into one name do.
- **013 entry metadata.** `entry_metadata` and `document_versions` (canopyd
  007's storage half; its routes, access rule, restore and UI remain in
  [canopyd 007](plans/canopyd/007-document-history-routes-and-restore.md)) are written
  inside every accepted transaction and were backfilled by migration 014: 2,515
  updates, 113 entries, 2,569 versions over 90 documents, all roots unchanged.
  Every client reads `/entry-metadata` directly; the Arbor Sync bootstrap no
  longer carries file mtimes. Nodes still decode the old `modifiedAt` key, so
  no replica is re-placed. The todos tree's 97 entries dated at its history
  boundary (2026-09-13) were seeded once from the Mac folder's file dates.
  `document_versions` keeps a rowid for accepted order and is unique on
  `(tree, key, update, entry path)`.

### V1 account and local-state cutoff — 2026-09-21

Implemented locally; no deployment or app installation performed for this cutoff.
Joe explicitly requested execution, confirmed Migration 003 rollback backups
removed, and confirmed current iPhone synchronization. Read-only inspection of
the live host found schema 15, one v2 configuration tree, four ordinary trees,
one account and no missing/v1 configuration. The default Mac home has stamp 5,
one plural account checkout, local placements, no singleton account/device
record, and 109 complete workspace records (106 `rt_`, three `tr_`).

Removed the singleton parser/watcher/credentials and v1 host/merge policies.
Bootstrap fixtures now create v2 graphs and install account-local checkouts with
local-only placements. The loopback status no longer exposes a singleton
`deviceID`; account summaries retain their scoped device identities. Pairing
clients no longer send filesystem placements, and the host has no placement
branch in pairing. Current-schema
startup rejects v1 policy rows before changing them. Incomplete workspace records
fail without rewriting the registry; existing complete root identities survive.
Migration 003's repository directory was already absent. Native 011 remains
unimplemented and was renamed to describe account management and client-package
consolidation rather than the already-direct publication path.

The private cutoff receipt is
`~/.arbor/.state/migration/v1-compatibility-cutoff-20260921T192722Z/receipt.json`.
A disposable restored schema-15 production copy passed the full integrity audit
and v2 graph decoding with authority rows unchanged. No authored trees or
existing workspace identities were migrated by this source cleanup.

Verification used Bun 1.3.14: typecheck, CLI build, the 50,000-file performance
gate, 251 merger tests, and focused store/schema/sync checks passed. The product
suite with a 15-second per-test budget passed 1,145 tests; its sole failure was
the previously baseline-reproduced CLI private-tree placement test. The default
five-second parallel run additionally hit three load-sensitive timeouts, all
passing on focused rerun. The standard protocol gate encountered the known
AppKit `renameByPageID` failure; the complete remaining gate passed with only
that test excluded (16 ArborSyncClient, 22 CanopyAppKit, 44 Overstory,
20 OverstoryClient, 98 CanopyWorkingTree, and five live editor tests).
The macOS app build and iOS Simulator build-for-testing passed after the final
pairing-client cleanup. Link and whitespace checks passed. These checks do not
constitute a new installation or deployment.


## Test reliability and host latency follow-up (2026-09-21)

The cleanup's baseline test failures are now fixed. The in-memory Swift provider
renames the selected root identity instead of also relocating a historical node
at the same path and returning whichever dictionary entry came last. Its test
checks that the historical page stays at its original path. Remote-to-local CLI
placement now explicitly synchronizes (which reloads the placement registry)
before checking adoption, removing reliance on filesystem notification delivery.

Source-admission trace vectors each have an independent test and dispose their
merge worker. Lazy-history scenarios clone one differentially validated history
fixture rather than rebuilding the same 60-step history for every scenario;
the two conflict-projection histories still exercise their own rules. The shared
90-step setup has a 30-second budget; ordinary test budgets remain unchanged.
Bun 1.3.14's normal product gate passed all 1,150 tests with no exclusions or
per-test timeout override. The complete protocol gate passed, including all
23 CanopyAppKit tests and the live editor cases. Standalone CanopyAppKit tests
and TypeScript typechecking also passed.

Read-only investigation of the September 19–21 Native network logs and the
September 21 Railway structured logs identifies increasing host validation and
retention work. Successful-request daily medians were 210/308/428 ms host time,
52/108/152 ms worker-retention, and 33/66/79 ms worker-validate-state. These are
observational samples with differing workloads, not a controlled benchmark.
Recent individual updates 3739–3741 took 339–397 ms host time, with 146–181 ms
retention, 71–82 ms validation, and 43–57 ms merge-worker execution. They reported
zero object-file reads, four proof-cache rejections, zero remembered proofs,
and a 128 MiB result-proof accounting weight against the 64 MiB cache limit.
The multi-job counters are summed, so batched-request values must not be read as
one proof's size.

Source tracing confirms that proof weight includes expanded historical state;
oversized proofs survive acceptance but cannot be reused across requests.
Retention also enumerates every supplied proof dependency and reference despite
its typed-map cache. This provides concrete mechanisms for history-dependent
latency; the logs do not establish when the cache threshold was first crossed.
The first observed post-startup update additionally spent 14 seconds cold,
including 7.8 seconds validation and 5.7 seconds retention. The next performance
change should make proof/retention reuse proportional to changed history and
measure on a disposable production copy; simply enlarging the cache would leave
the full-dependency traversal. No performance change was deployed during this
investigation.


## Incremental authority validation and retention (2026-09-21)

History validation now retains a shared proof tree with immutable synchronous
lookup views. Changed radix branches reuse child proofs without flattening all
history values, dependency hashes, or references. A reference-counted memory
ledger includes both cache entries and accepted-state leases, counts shared
allocations once, and enforces the existing history budget. Accepted-state
proofs charge their own active/material data instead of the complete expanded
history; expanded-input validation limits remain enforced independently.

Retention uses typed history-map traversal even when semantic proofs are
available. It promotes wholly durable branches independently, preserves staged
publication obligations, and hash-checks staged overrides before reusing a
certificate. Host acceptance rechecks the pending frontier; fresh audits keep
the complete graph walk. Cache certificates include the history-field type.
Regression cases cover 100 versus 10,000 history entries, cache eviction and
pinned ownership, abandoned proposals, repeated staged checks, corrupt staged
overrides, role changes, and a large history under a small per-state budget.
New `retention-visits` and `retention-map-hits` diagnostics make reuse observable.

A local before/after replay used separate disposable copies of the September 19
schema-15 production backup and baseline commit `15586d75`. Across the same 14
synthetic fast, divergent, conflict-creating, and live-conflict edit scenarios,
median merge-tool time fell from 217.5 to 150.5 ms; validation from 30.5 to
19.5 ms; retention from 73 to 23.5 ms. Cold warmup was 3.53 versus 3.71 seconds,
so this is a warm-update improvement, not a cold-start improvement. The replay
snapshot has less history than the September 21 production state; these local
numbers are not a production latency forecast. Raw replay logs are local at
`/tmp/arbor-validation-replay-{old,new}.jsonl`.

Production follow-up after Joe pushes and uses Canopy for one or two days should
compare warm single-update timings, separately from cold starts and batches:
`worker-validate-state`, `worker-retention`, total host time, proof hits/rejections,
and the two retention counters. Compare similar edit/conflict workloads. No live
data, installed app, or deployment was changed by this implementation.

Verification on Bun 1.3.14: all 1,155 product tests, the complete protocol gate,
270 focused merger/retention tests, 16 standalone ArborSyncClient tests,
typecheck, build, links, and whitespace checks passed. The 50,000-file gate
passed (217 ms startup, 17.06 s cold walk, 2.81 s warm, 2.61 s incremental).
The disposable five-tree schema-15 copy passed a full integrity audit with its
account, device, access, boundary, reservation, policy, and tree rows unchanged.
