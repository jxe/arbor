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
| Canopy first launch: shared Mac/CLI identity, create/recover/backup, guarded legacy reconciliation, community-address claim and durable retry; iOS pairing-only setup | implemented, not installed | [browser design](docs/implementing-editors/design.md#first-launch-and-identity), [account bootstrap](docs/implementing-sync-services/arborsync-api.md#4-account-bootstrap-forget-and-conflict-review) |
| Bun CLI distribution: publishable package, external-checkout cloud sessions, explicit daemon requirements, durable installed watcher/runtime assets | implemented, not published | [bunx usage](docs/getting-started/cli.md#running-with-bunx) |
| Tree identity and synchronization: stable TreeIDs, immutable objects, content-addressed snapshot bundles, accepted updates, append-only update strings, watch streams with unconditional net catch-up, sparse object transfer, canonical boundaries, public HTML and Markdown projection; TypeScript and Swift with shared fixtures | deployed | [tree operations](docs/overstory-spec/01-tree-operations.md), [conformance](docs/overstory-spec/conformance/README.md) |
| Protocol format 5: raw file objects, typed file/directory/tree entries, sparse bootstrap without a file map, optional accepted-conflict metadata | deployed, installed | [tree operations](docs/overstory-spec/01-tree-operations.md) |
| Authored change identity: every candidate carries `change`, `trace` (up to 64 frames and 1024 operations) or `trace: null`, `resolves`, and optional `ifCurrent`; digests over domain `arbor-update/2`; whole-batch rejection of unsupported semantics before any prefix is accepted | deployed, installed | [tree operations §2.1](docs/overstory-spec/01-tree-operations.md#21-the-update-request), [source intent](docs/overstory-spec/10-source-intent.md) |
| Accepted-state contract: simplified receipts, predecessor identity and root chains, required unresolved signals, paged conflict inspection without a decision-count cap | deployed, installed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Merge sidecar: canopyd forwards all eight operation kinds to `arbor-merge`, which executes exact authored operations, retains source choices, applies the conservative format rules, and returns retained state; canopyd owns acceptance, authorization, retention, and identities (schema 12) | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md) |
| Incremental merge state and lazy history: shared history pages, editable-state reuse, one persistent FIFO worker, accepted-prefix preflight reuse; per-request phase logging and `Server-Timing` | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md#retained-state-and-lazy-history), [deployment](packages/canopyd/deploy/README.md#canopyd-runtime-environment) |
| Accepted whole-entry and source-range conflicts: competing edits retained as alternatives with attribution, root decisions, guarded partial resolution, authorized historical inspection (schema 10 and 11) | deployed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Resource policy and execution authority: shared `who` / `via` / `allow` / `within` grammar, governed policy index, host-private execution tokens, guarded scoped snapshot effects, revocation stream, restrictive-intersection conflict acceptance, Canopy consent review (schema 13) | deployed, installed | [access control](docs/overstory-spec/05-access-control.md), [reference implementation](docs/architecture/protocol/README.md#resource-policy) |
| Client state machines: the document admission machine and the working-tree update machine are pure reducers in both languages executing one shared fixture; one request in flight per document session and per tree, with one retained successor | installed | [client state machines](docs/implementing-editors/document-admission.md) |
| Durable source admission queue: exact source, basis, and candidate records with explicit predecessors, fsynced journals (schema 4, one frame per record), trace compaction, read-your-writes sessions, publication and settlement, recovery after restart; installed Canopy emits the supported operations and explicit structural snapshots | installed, verified | [local system](docs/architecture/canopy-browser/local-state.md#source-admission-journals), [client state machines](docs/implementing-editors/document-admission.md#7-admission-invariants-and-trace-compaction) |
| Canopy working-tree editors: the Mac and iOS apps edit placed trees directly as working trees over the object store; the daemon is the folder's client plus loopback bootstrap, credential, and object services and has no editor path | installed, verified | [local system](docs/architecture/canopy-browser/local-state.md#native-working-trees), [client design](docs/implementing-editors/design.md) |
| Canopy navigation: observable Back availability, editor-link pushes, exact cross-tree destinations, and Back/Forward/native-pop provider reopening without resetting tab history | implemented; Mac user-verified | [client design](docs/implementing-editors/design.md) |
| Canopy editor recovery: saves wait for durable coordinator heads; committed generations keep exact-source local recovery copies with Local History restore; reconnection retries pending work; restart, divergent-draft review, disk-failure retry, and keystroke races have regressions | installed, verified | [local system](docs/architecture/canopy-browser/local-state.md#editor-recovery-store) |
| Canopy operation capture: ordinary and compound sibling-body entry moves and copies, explicit current-page path rename with subtree relocation and proactive link healing, post-copy page-ID edits, explicit removals for private Trash, same-document and cross-document copies, page-conversion undo and redo, durable undo-horizon collection, exact CRLF and BOM preservation | installed | [client design](docs/implementing-editors/design.md#labels-and-actions), [Native 008](plans/swift/008-complete-native-move-copy-undo-capture.md) |
| Canopy conflict review: sidebar navigation, page markers, exact-source comparison and composition, durable grouped drafts, recursive previews, guarded source-range and structural resolution | implemented | [Native 010](plans/swift/010-client-conflict-review.md) |
| Entry dates and document versions: each file entry's last accepted change and each Markdown document's accepted content versions, kept beside the hashes (schema 16) and served by `/entry-metadata`; Mac and iOS date pages from it and date incoming changes with Canopy's accepted time | server deployed; clients implemented, not installed | [tree reads §1.1.2a](docs/overstory-spec/01-tree-operations.md#112a-reading-entry-metadata), [migration 014](packages/canopyd/migrations/014-entry-metadata/README.md) |
| Traced entry creation: the `addEntry` authored operation takes the fast path; page creation and a directory's first body no longer publish snapshots | server deployed; clients implemented, not installed | [source intent](docs/overstory-spec/10-source-intent.md) |
| Effect records as piece deltas: `editSource` effects store each edit's range and removed/inserted pieces instead of two whole piece copies; older records are read by recomputation | deployed | [merge tool](docs/architecture/canopyd/merge-tool.md#retained-state-and-lazy-history) |
| Communities, accounts, and directory: a host serves community plus person/group profile trees, derives an authorization-preserving user directory with names and avatars, reserves account paths, and reconciles synchronized account configuration; native People and Share surfaces cache and search that directory; `arbor me create` / `me set` manage the local profile | directory implemented, account core deployed and installed | [accounts and devices](docs/overstory-spec/04-accounts-and-devices.md), [client design](docs/implementing-editors/design.md#profile-control-and-claim), [deployment](packages/canopyd/deploy/README.md) |
| Native sidebar Trees mode, People footer, and single-pane profile/sync/devices management with focused account and identity actions on Mac and iOS | implemented, not installed; macOS and iOS builds passed, manual UI verification pending | [client design](docs/implementing-editors/design.md#profile-control-and-claim) |
| Plural local accounts and devices: one data home holds several host accounts, including several at one origin, in `account.yaml`, `trees.yaml`, and `devices.yaml`; Mac-to-iPhone pairing | installed, verified | [local system](docs/architecture/arborsync/data-home.md#data-home) |
| Short-lived cloud workspaces: reusable one-account bundles, exact placements under an isolated root, detached Arbor Sync, explicit finish, bundle revocation, `arbor status` | implemented | [CLI](docs/getting-started/cli.md#short-lived-cloud-sessions) |
| Headless executable-data core: SQLite-backed query lowering and execution over the Supplies corpus, dependency-sensitive live result streams, authorized transactional mutations with durable retry receipts | implemented | [apps runtime](packages/apps-runtime/README.md), [Supplies](examples/supplies/README.md) |
| Operational hosting: Railway and VPS deployment, persistent storage, backup and restore, coordinated upgrades, one-off migrations | deployed | [deployment](packages/canopyd/deploy/README.md), [migrations](packages/canopyd/migrations/README.md) |

## In progress

| Area | State | Remaining | Owning plan |
|---|---|---|---|
| Canopy editing and review | implemented, not installed | Richer review previews, inline choice context and block highlight, transformed copies and other compound editor commands, interactive accessibility gates | [Native 008](plans/swift/008-complete-native-move-copy-undo-capture.md), [010](plans/swift/010-client-conflict-review.md) |
| Markdown source-transfer policy | deployed, not hand-verified | Identity-verified paragraph copies and moves reconcile with independent prose edits in either arrival order; structured formats and protected structure still require review | [canopyd 014](plans/canopyd/014-merge-moved-text.md) |
| Resource policy providers | deployed | Provider-specific enforcement, source resolution, activation consent, the execution sidecar, observation and soak | [Apps 004](plans/apps/004-mutation-permissions.md), [005](plans/apps/005-source-resolution-and-sidecar.md) |
| Working-tree client transition | installed | The explicit soak closeout | [release and soak](plans/verification/release-and-soak.md#observation-and-soak-closeout) |
| Canopy for the web | not mounted | The browser editor is out of the build until it is rebuilt as a working-tree client over the same machines as the Mac app | [Web 025](plans/canopy-web/025-arbor-web.md) |
| Executable documents | core only | MDX/TSX compilation, generated typing, editor integration, React presentation, activation, Canopy presentation, canopyd hosting | [Apps 001 and 003 to 006](plans/catalog.md#product-completion) |
| Group management | implemented, not deployed or installed | Deploy canopyd group membership by Profile TreeID (it matched by handle, so handle-less group members gained nothing) and top-level `/~name` trees for administrators; install the Mac New Group, Members sheet, and People/Share entry points; iOS group creation; claimed-member restoration | [design](docs/implementing-editors/design.md#profile-control-and-claim) |
| Composable conflict fragments | reassess | Only residual representation gaps remain after schema 12 | [canopyd 002](plans/canopyd/002-composable-conflict-fragments.md) |

## Specified but not implemented

- Host-hosted agents and their portable frontmatter contract.
- Static baking and additional portable live-deployment adapters.
- A complete Postgres child provider, observation contract, and bidirectional projections.
- Deferred workspace capabilities: multiple local placements of one TreeID, durable pinned historical placements, reader-local overlays.
- Linux and Windows daemon supervision.

## Known gaps

- **Storage is unbounded.** The per-tree object and byte quotas were removed from update acceptance; nothing bounds retained history, the iOS replica keeps every accepted object, and the editor recovery store is never pruned. Measurement precedes packing in [canopyd 001](plans/canopyd/001-pack-object-storage.md).
- **Every accepted-state change requires review.** The host requires exact accepted-state guards, so a client must review the latest evidence even when projected bytes are equal or the update is unrelated.
- **Range translation across a merged predecessor** is future work; the host relates an authored predecessor to its accepted projection through a validated or exactly replayed prefix only.
- **Cross-account rehome of resource policy** fails before mutation until a policy-transfer contract is reviewed.
- **Cross-process ownership of a client state directory** is not enforced; one process must own it by convention.
- **Latency.** The target is under 100 ms of server processing for a small fast-forward; divergent-merge and live latency are not established, and the first edit after a restart is measured in seconds unless warm-up ran.
- **No accepted-history listing.** Known retained roots are readable as immutable snapshots by callers who can read the tree; there is no history or metadata route. [canopyd 007](plans/canopyd/007-document-history-routes-and-restore.md) owns it.
- **Compatibility cutoff.** Account configuration is v2-only and workspace registries require complete object records; scalar group-member entries are a separate legacy input format.
- **Production recovery, dispute handling, and high availability** are not productized; the deployment guide documents backup, restore, and coordinated upgrades only.

## Where work is tracked

- [Outcome menu](plans/README.md), a short set of choices with open priorities.
- [Detailed catalog](plans/catalog.md), every retained plan and design candidate.
- [Release and verification](plans/verification/release-and-soak.md), outstanding installation, deployment, hands-on, and soak checks.
- [Open questions](plans/open-questions.md).

## Accepted-history compaction — 2026-09-22

Deployed 2026-09-23 at schema 17 by migration 015, from schema 16. It removes stored copies of accepted
history: `observations` becomes `accepted_updates.ordinal` (unchanged cursors for every
accepted update), `reflog` is dropped, `authored_changes` keeps only the trace and
evidence, and the unread `accounts.token_digest` is dropped. `AcceptedUpdateStore.advance` is now the only writer of `trees.ref`. A merge
that records decisions reads only its own tree's legacy conflict rows instead of every
row in the database. See the
[migration README](packages/canopyd/migrations/015-compact-history/README.md).

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
[publication batching](docs/implementing-editors/document-admission.md#8-publication-batching-and-preparation-costs)
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
