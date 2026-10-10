# Implementation status

*Source reviewed: `17da9152` plus the cleanup below, 2026-09-21. Check the working tree and tests
before relying on a label.*

This page reports what the reference implementation does today. The
[specification](docs/overstory-spec/README.md) is deliberately broader: it defines the portable
system Overstory is building toward. Remaining work lives in [plans](plans/README.md);
completed plans are deleted and live in git history.

States used below: **implemented** (built and tested), **installed** (running
in Joe's Mac and iPhone builds), **deployed** (running on the public host),
**verified** (exercised by hand against live data).

## Chained candidate deltas — 2026-10-06

Both publication coordinators now compact later elements against the preceding
submitted candidate when its graph is available locally. overstoryd resolves delta
bases through the accumulated request objects as well as stored objects, checks
reachability from that element's basis, and hash-verifies the base and result.
This implements the existing tree-operations §2.5 rule; no wire format or
semantic identity changes. Frozen requests and settled prefix receipts remain
unchanged. This supersedes the first-element limitation recorded below on
2026-09-29.

Regression coverage keeps a tiny successor edit to a 70 KB document under 5 KB
in both clients. JSON and CBOR host tests cover two delta-bearing candidates,
concurrent peer merges, replay after restart, a new delta after a settled prefix,
and rejection of an unreachable delta base before any traced prefix commits.
The folder test covers an ambiguous request's exact retry followed by a compact
successor.

Validation: the affected run passed typecheck, build and the performance gate;
its product suite had 501 passes and one obsolete whole-file expectation. After
updating that expectation and strengthening the negative coverage, the affected
recheck passed all 65 tests in the two integration files. The standalone
OverstoryWorkingTree suite passed 132 tests. The protocol gate's TypeScript tests
passed, but its app-hosted stage was blocked by LaunchServices failing to launch
StoryAppTests (xcodebuild exit 65); subsequent live Swift stages did not run.
Not installed or deployed.

## One local chain and exact reconnection — 2026-09-30

During a flight Joe edited `Fidelity.md`, then `_index.md`, in one Mac session.
The `_index.md` editor captured its first view from the accepted state, so its
125 operations formed a sibling branch of the `Fidelity.md` chain. One request
(`base=6131`, two updates) was retried unchanged for 54 minutes. After it landed
as 6132–6133, the branch went out still based on 6131. overstoryd merged Joe's two
branches as if they were from two devices and recorded a whole-tree choice (6134).

overstoryd now judges Markdown transfer policy only on files both sides changed. A
within-file transfer it cannot replay becomes a content choice about that file,
not a whole-tree choice. Replaying the captured entry 6134 locally reproduces the
live refusal on the old engine and merges without a decision on the new one.

Both clients keep unsettled local changes as one chain. An editor opened during
pending work reads the tip. An edit captured on an earlier view is authored on
the tip when no change since touched its document, checked change by change.
Otherwise it keeps its basis as the single merge for overstoryd. The change log
refuses any other fork. On reconnection, a request that may have reached the host
is only repeated unchanged; later work follows its answer as one coalesced update.
Work never extends an ambiguous request any more. Swift and TypeScript machines,
fixtures and runner vectors were updated together. The conflict card now names
versions "Kept for now" and "Set aside" and lists lines missing from current
contents.

Evidence: OverstoryWorkingTree (132 tests) and Overstory (68) pass. The merge engine
suite passes 322 tests. The TypeScript machine, runner, and change-log suites pass.
The live conflict on `/~joe/todos` remains for Joe to resolve; the fixes are not
yet deployed or installed.

## Editor activity and compact move payloads — 2026-09-29

The Swift and TypeScript publication machines now distinguish editor activity
from completed durable appends. Native `EditorSource` holds a per-session
activity claim while captured generations await admission; the quiet timer starts
when all such work drains. Closing a session or failing an append releases its claim;
explicit synchronization and configured maximum delays remain exceptions.
This prevents slow admission from splitting a held Option-arrow burst into
requests despite continuing editor captures.

Before freezing the first publication in a request, both coordinators compact
final reachable file and directory envelopes into copy/insert deltas when smaller.
Every delta base comes from the request's original accepted graph. Later batch
elements retain their envelopes because their preceding candidate may not yet
be retained by the host. Intermediate trace objects remain available. Semantic digests and
frozen retry bodies do not change. The previous move coalescer emitted a full
final document even after simplifying its operation to one move.

Shared size tests move a paragraph 50 times through a 57 KB document: both
clients reduce the whole-burst CBOR request from 58,007 to 1,153 bytes.
The coordinator currently applies this optimization only to the first publication
in a request; compacting later elements needs a separate retained-base proof.
These are synthetic measurements, not a measurement of Joe's next live
move. Tests verify delta reconstruction, accepted-base reachability and unchanged
request digests. Slow-admission tests cover overlapping editors, idle release,
close and explicit flush. No installed app or live data was changed.

## Branches inside composed publications — 2026-09-29

Swift and TypeScript now end batching at known local branch points. For a late
branch from inside an already published batch, the client can transport source
operations across a suffix that reads and writes disjoint existing files. The
original journal stays unchanged. New deterministic continuation identities and
operation-result mappings survive exact retry and restart; compaction retains
all members of a still-needed batch. Reconciliation uses the published candidate,
so the runner loads the accepted graph when that differs from the original local
candidate. This requires no overstoryd or wire-format change.

The live regression moves a page into another Markdown page, publishes that move
with an independent edit, then admits two editors captured at the intermediate
move. Both branches settle without a conflict after restart and a lost
acknowledgement. Focused tests also cover known branch boundaries, refusal of
overlapping material, deterministic recompilation, batch retention and exact
retry. The protocol run passes 124 working-tree tests and 7 live editor tests.
A read-only check of the stuck local journal confirms all three pending edits
fit the disjoint-source case. No installed app, live journal or public host was
changed. Broader interior-basis support remains in
[Clients 002](plans/merge/002-identity-preserving-coalescing.md#interior-bases-that-need-further-support).

## Unchanged-content resolutions publish — 2026-09-29

A live retained request showed that “Keep current contents” was marked settled
locally without a POST: the coordinator treated a snapshot with the same root as
having nothing to publish, overlooking its `resolves` declaration. Swift and
TypeScript now require publication for resolution declarations and `ifCurrent`
guards as well as traces. Ordinary unguarded unchanged snapshots can still settle
locally. The app confirms the reviewed choices are absent before saying resolved.
The failed live attempt and draft remain untouched; retry from the fixed app.
The affected gate passes, including a disposable live-server resolution that
keeps the root unchanged, advances accepted identity and clears the choice.
All 18 TypeScript runner tests pass, including resolution-only, guard-only and
ordinary unchanged snapshots. The full app-hosted test run also passes.

Merge improvement plans now live together in [plans/merge](plans/merge/README.md):
command capture, identity-preserving coalescing, broader merge rules and explicit
automatic reconciliation remain separate, linked scopes. History and line
provenance are grouped under `plans/history/`; sparse iOS placement and pack
storage under `plans/performance/`. The collection projection plan follows Joe’s
move into Apps, numbered 010 to avoid colliding with Apps 003. No remaining work
was discarded or declared complete.

## Page transfers and directory conflict review — 2026-09-29

A destination with a title heading now accepts appended blocks as one source
transfer: validation accounts for Markdown heading nesting. The previous check
rejected this valid shape and fell back to a separate copy and deletion, which
could become competing whole-tree choices. Unsupported same-tree transfers now
leave both pages intact. A private read-only reproduction against captured
alternatives validated one transfer; no live resolution was submitted.

Moving or copying a page beneath a Markdown leaf now promotes the destination
inside the same local transaction, preserving its sibling Markdown body. The
trace adds an empty directory and names that operation as the transfer’s parent;
the journal retains this intermediate object for publication and restart.

Directory conflict cards load changed Markdown descendants from both alternatives,
show differing lines and nearby context, and expose full page text. Unchanged
subtrees are skipped. This addresses identical “changed” labels that concealed
whether content was copied or deleted. The selected alternative is labelled as
a conflict version: later edits may differ from both alternatives. Read-only
inspection confirmed that later accepted content already combined the intended
transfer, while its older conflict remained unresolved. No live data was changed.

The reviewer also shows which changed files in the current accepted tree match
which captured alternatives. An independent whole-tree choice has an explicit
“Keep current contents” action: it preserves the pinned root, carries complete
resolution guards and `ifCurrent`, and refuses stale content or coupled choices.
Automatic discharge of existing choices is not implemented; remaining work is in
[overstoryd 015](plans/merge/015-resolve-reconciled-choices.md).

Batch preflight now validates a non-plain traced suffix on its complete authored
prefix, instead of merging it against the tree before that prefix. This prevents
a just-created parent from appearing deleted when a later queued operation moves
or renames its child. Validation does not emit accepted decisions; acceptance
still merges against the actual head and retains hidden ancestor choices.

Evidence: focused validation and hidden-ancestor regressions pass; the disposable
live mixed structural scenario passes promotion, move, copy, subsequent rename,
publication and uncertain-response recovery. The protocol run passes 122
working-tree tests and seven live editor tests. The full editor package passes
86 tests. The affected gate passes typecheck, 60 product test files, the full
protocol gate, editor tests, links and whitespace. A separate full app-hosted run
passed 86 tests with one skipped; all 14 review tests pass after tightening stale
current-content guards. These changes are not installed or deployed by this task.

## Option-arrow capture cost — 2026-09-29

The native Markdown ledger reuses context-free block parses keyed by exact UTF-8
bytes while still validating boundaries, nesting, tree shape and the final patch
on every move. A synthetic 500-paragraph debug benchmark reduced mean synchronous
move/capture cost from 60.0 ms to 11.2 ms. macOS key-repeat settings and shortcut
routing are unchanged. This is source-level performance evidence, not installed
UI validation. Cached/uncached equivalence tests cover repeated text, Unicode,
CRLF/frontmatter, headings, lists, code, raw Markdown, blank lines and subsequent
edits. The full editor package suite passes, as do link and whitespace checks.
The app-hosted affected gate could not launch while the debug Story app was
running. Joe subsequently reported much better Option-arrow responsiveness after
testing the local build. See [editor capture costs](docs/implementing-editors/editor-source.md#repeated-movement-on-the-main-thread).

The follow-up preserves the last validated parse cache across ordinary edits and
uses it for incoming accepted replacements, transformed acknowledgements and
structured source replacements. Fresh parses replace the cache rather than
accumulating historical entries. Cold/cached debug comparisons over 500 paragraphs
measure 60.0/11.0 ms for a move after editing and 53.4/7.9 ms for replacement parsing
(excluding reconciliation/rendering). Tests compare cold and cached trees, byte
sources and ledger ranges across boundary/nesting changes, and exercise an actual
binding through typing and acceptance while preserving the unchanged block ID.
These follow-ups have not been installed by this task.

## Idle publication and coalescing — 2026-09-29

Both working-tree clients now default to publication after 250 ms of idle.
Successors keep their remaining idle wait across an in-flight request; watch and
poll traffic do not interrupt the burst. Story Sync folders explicitly retain a
1 s maximum for continuous activity. Explicit sync can flush.

Before preparation, Swift and TypeScript compile contiguous operation-bearing
local records into a fresh authored update. Repeated pure moves of the same span
reduce to one original-source move at its final anchor. Mixed work retains its
frames; snapshots, resolutions and guards form boundaries. Control schema 5
retains local-to-published change and operation-result mappings with the immutable
request. Retry, restart, work after an ambiguous request, settlement and discard use that
mapping. Original local records and editor undo remain independent.

The native codec consumes actual moved-block evidence from the sibling Quagmire
checkout, avoiding attribution to the stationary neighbor when moving a block
down. This uses an additive Quagmire API that is **not released**; the committed
pins remain 0.8.0. Integration has been tested with the local override. A Quagmire
release and matching pin updates are still needed before a portable release.
Nothing from this change has been installed or deployed.

Evidence: shared compiler and state-machine fixtures, real merge-engine tests
with concurrent peer edits in both arrival orders, and shared runner tests for
coalesced retry/restart/discard. A 70-move burst reduces to one frame; encoded CBOR
request-size assertions check the pure-move cases. The working-tree package's 118
tests, editor package's 79 tests and Quagmire package tests pass. `bun run
test:affected` passes with Bun 1.4.2, including typechecking, 267 affected product
tests, build, the full TypeScript/Swift protocol gate, performance and links.
The protocol gate includes live client/host checks and 343 TypeScript protocol
tests. Closing the running Story app resolved the initial LaunchServices test
launch failure. A live branch/restart case caught an intermediate delta whose
result no longer reached the final candidate; both compilers now retain such
material as an object and keep deltas only for final reachable results.

Further reduction is ordered by likely frequency and byte savings in
[Clients 002](plans/merge/002-identity-preserving-coalescing.md): plain edits across
records, moves with edits, then repeated selection/subtree moves. These priorities
are source-based estimates; the plan requires encoded-byte and preparation-cost
measurements before broadening the implementation.

## Implemented

| Area | State | Where to read |
|---|---|---|
| Story first launch: shared Mac/CLI identity, create/recover/backup, guarded legacy reconciliation, community-address claim and durable retry; iOS pairing-only setup | implemented, not installed | [browser design](docs/implementing-editors/design.md#first-launch-and-identity), [account bootstrap](docs/implementing-sync-services/story-sync-api.md#4-identity-account-bootstrap-and-declined-changes) |
| Bun CLI distribution: publishable package, external-checkout cloud sessions, explicit daemon requirements, durable installed watcher/runtime assets | implemented, not published | [bunx usage](docs/getting-started/cli.md#running-with-bunx) |
| Tree identity and synchronization: stable TreeIDs, immutable objects, content-addressed snapshot bundles, accepted updates, append-only update strings, watch streams with unconditional net catch-up, sparse object transfer, canonical boundaries, public HTML and Markdown projection; TypeScript and Swift with shared fixtures | deployed | [tree operations](docs/overstory-spec/01-tree-operations.md), [conformance](docs/overstory-spec/conformance/README.md) |
| Protocol format 5: raw file objects, typed file/directory/tree entries, sparse bootstrap without a file map, optional accepted-conflict metadata | deployed, installed | [tree operations](docs/overstory-spec/01-tree-operations.md) |
| Authored change identity: every candidate carries `change`, `trace` (up to 64 frames and 1024 operations) or `trace: null`, `resolves`, and optional `ifCurrent`; digests over domain `arbor-update/2`; whole-batch rejection of unsupported semantics before any prefix is accepted | deployed, installed | [tree operations §2.1](docs/overstory-spec/01-tree-operations.md#21-the-update-request), [source intent](docs/overstory-spec/10-source-intent.md) |
| Accepted-state contract: simplified receipts, predecessor identity and root chains, required unresolved signals, paged conflict inspection without a decision-count cap | deployed, installed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Merge sidecar: overstoryd forwards all eight operation kinds to `overstoryd-merge`, which executes exact authored operations, retains source choices, applies the conservative format rules, and returns retained state; overstoryd owns acceptance, authorization, retention, and identities (schema 12) | deployed | [merge tool](docs/architecture/overstoryd/merge-tool.md) |
| Incremental merge state and lazy history: shared history pages, editable-state reuse, one persistent FIFO worker, accepted-prefix preflight reuse; per-request phase logging and `Server-Timing` | deployed | [merge tool](docs/architecture/overstoryd/merge-tool.md#retained-state), [deployment](packages/overstoryd/deploy/README.md#overstoryd-runtime-environment) |
| Update timing: Native and Story Sync (the TypeScript runner, fixed 2026-09-25; its folders sent every request twice) defer watch-triggered receipt retrieval while the same POST is in flight, reusing its validated response or retrieving receipts after transport failure; overstoryd rechecks accepted-prefix traces so a plain prefix keeps its new tail on the fast path, while causal prefixes still use the sidecar. Regressions cover watch-before-response success and loss, and plain versus reordered-lineage prefixes across restart | implemented, not installed or deployed | `UpdateCoordinatorTests.swift`, `tests/unit/update-runner.test.ts`, `tests/integration/folder-deltas.test.ts`, `tests/integration/overstoryd/source-acceptance.test.ts`, [fast-forward](docs/architecture/overstoryd/merge-tool.md#fast-forward) |
| Merge boundary: overstoryd shares only the object store and `@ovst/merge-protocol` with the sidecar and keeps none of its state; overstoryd merges account configuration itself; `trees.yaml` is resource-rule grammar only | deployed 2026-09-24 (build `dd5313c8`) | [merge sidecar](docs/architecture/overstoryd/merge-tool.md#answer-checks) |
| Accepted history as log entries and one merge question (overstoryd 016): each accepted update is an immutable log entry in the object store naming its predecessor's; rows keep the entry hash and `conflicted` (schema 19); overstoryd asks the sidecar one question, accepts plain `editSource`/`addEntry` edits on the head without it, and the sidecar keeps an in-memory cache it rebuilds by replaying entries | deployed 2026-09-24 at schema 19 by migration 018 (build `dd5313c8`) | [writing a sidecar](docs/architecture/overstoryd/writing-a-sidecar.md), [merge sidecar](docs/architecture/overstoryd/merge-tool.md), [migration 018](packages/overstoryd/migrations/018-log-entries/README.md) |
| One access store (schema 20): a tree an account activated or hosts is that account's, and its owner's resource rules alone govern it; `access` keeps only unowned trees' entries; `trees.updated_at`, the reservation status, `account_challenges.claim_digest` and `meta.community_name` are gone | deployed 2026-09-24 at schema 20 by [migration 019](packages/overstoryd/migrations/019-one-access-store/README.md) (build `016f878a`); superseded at schema 22 by tree configurations | [host](docs/architecture/overstoryd/README.md#accounts-and-canonical-paths) |
| Profile facts per tree (overstoryd 018, schema 21): one `profile_facts` row per tree whose head declares `type: person` or `type: group`, keyed by TreeID with the head's `_index.md` object and declared avatar path; an accepted update recomputes it only when its entry changes touch `_index.md` or that avatar, parsing `_index.md` once per accept, and reconciles community accounts only when the members change; readers and the directory's group scan key by tree; the `meta` `profile:<root>` rows are gone. Tested by `tests/integration/overstoryd/profile-facts.test.ts` and the migration suite | deployed and verified 2026-09-25 at schema 21 by [migration 020](packages/overstoryd/migrations/020-profile-facts-per-tree/README.md) (build `fe0fccdb`) | [host](docs/architecture/overstoryd/README.md#accounts-and-canonical-paths), [schema history](packages/overstoryd/migrations/README.md#schema-history) |
| Tree configurations (overstoryd 005, schema 22): every hosted tree has one private configuration tree at a derived TreeID holding `access.yaml` and `mounts.yaml`, plus `apps.yaml` for a profile and `devices.yaml` for a person; rules have `admin` and `app`; lending names the lender; accounts are keyed by profile TreeID; the account configuration, `access`, `resource_policy` and `tree_reservations` are gone. The Mac and iPhone apps, CLI and Story Sync speak it | deployed and verified 2026-09-26 at schema 22 by [migration 022](packages/overstoryd/migrations/022-tree-configurations/README.md) (build `983c59da`; app fixes `35a9b320`) | [spec](docs/overstory-spec/04-accounts-and-devices.md#2-tree-configuration-graph), [decisions and failure cases](docs/architecture/overstoryd/tree-configurations.md) |
| Device keys and sessions (Security 006 Phases 2 and 3, schema 23): a `devices.yaml` entry may carry `key` (`ed25519:` or `p256:`); a key device signs a host challenge for a session token of at most an hour; a digest device moves to a key once, and its credential stops working in the same commit; pairing and claims accept a key; a person who has lost every administrator device is recovered by an operator-issued recovery pairing (`overstoryd recover`), whose claim leaves only the new key device; the profile-key reset built in Phase 2 was withdrawn on 2026-09-27. TypeScript protocol and overstoryd with shared vectors (`device-keys.json`); the Swift `Overstory` models, signing bytes and client calls pass the same vectors. Clients (Phase 3): Story Sync holds an Ed25519 key and hands local clients sessions through `GET /v1/credential`; the iPhone holds a Secure Enclave P-256 key; new claims and pairings use keys, `story device move-to-key` and both apps move an existing device, identity backups are passphrase-encrypted (version 2; version 1 still restores); client suites and the protocol gate pass. As a home host overstoryd also publishes each profile's key devices at `GET /.overstory/profiles/{ProfileTreeID}/device-keys` (accounts §5.4, Security 007's home role) | host deployed and verified 2026-09-26 at schema 23 by [migration 023](packages/overstoryd/migrations/023-device-keys/README.md) (build `0621789b`); clients and the device-keys route deployed at `8448a63f` the same day. Joe's Mac and iPhone moved to keys and the route lists both; he checked an encrypted backup and session renewal by hand. Pairing, revoking and recovering with keys were never tried by hand (Joe waived those checks on 2026-09-27). Digest devices are retired on the branch awaiting the [schema-26 cutover](#schema-26-cutover--2026-09-27) | [accounts §5](docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing) |
| Shared sidecar checkpoints (Performance 002): versioned SQLite stores compressed, content-addressed state records and binary private objects; direct restore preserves state identities, bucket shape and iteration order; interrupted replay checkpoints its verified frontier and protects the newer head while rebuilding an older authored basis. Legacy JSON checkpoints remain readable | implemented locally 2026-10-09, not deployed; legacy snapshot cache observed on the live host that day | [shared checkpoints](docs/architecture/overstoryd/merge-cache.md), [rollout](plans/performance/002-shared-merge-cache.md) |
| Historical catch-up (Performance 003): lazy history working maps avoid full-history copies/scans on exact-basis edits; successful old-basis recovery retains that basis with its head; deterministic complexity and fresh-process replay benchmarks | implemented and verified locally 2026-10-09; not deployed; broader cold-replay targets remain | [evidence](#historical-catch-up-improvements--2026-10-09), [remaining work](plans/performance/003-fast-historical-catch-up.md) |
| Object packing (overstoryd 001): `ObjectStore` reads, presence checks and freshens fall back from loose files to immutable packs under `objects/packs/` indexed in their own SQLite file (zstd frames of about 1 MiB holding one document's versions in order, an object that large alone; every read hash-checked); overstoryd's `PackMaintenance` packs loose objects older than an hour outside every current tree after acceptances cross a threshold, at startup and when idle, and removes loose files only after reading each packed object back; the collector drops dead packed rows under the same retention and grace rules and rewrites half-empty packs. On a copy of live data (2026-10-09: 22,370 objects, 380 MB raw, 431 MB loose) document frames of 1 MiB took 21.8 MB with 0.58 ms p95 cold single reads; per-version deltas took 40–50 MB; see [the plan](plans/performance/001-pack-object-storage.md) | implemented, on by default on the branch (`OVERSTORYD_OBJECT_PACKING=0` disables), not deployed; `pack-maintenance.ts` runs one pass or `--unpack` by hand | [plan](plans/performance/001-pack-object-storage.md) |
| Merge sidecar cleanup: the reference sidecar keeps each engine state decoded in memory, as frozen, interned values in persistent maps that share whatever an edit did not touch, identified by a digest of its content (the chunked state encodings and lazy history loading are gone); engine decisions convert straight to log decisions; the snapshot tree merge is its own package, `@ovst/tree-merge`, which Story Sync tree recovery now declares. Log entries and the question and answer are unchanged | implemented, not deployed | [merge sidecar](docs/architecture/overstoryd/merge-tool.md#retained-state) |
| Transfer merge extensions (overstoryd 014): identity-verified moves and copies of Markdown bullet-list items, pipe-table body rows and text with relative, fragment or reference links (with a proven binding); same-anchor pairs kept in contribution order; keyed JSON/YAML member moves and copies and top-level TS/JS function declaration moves within one file, each with its commutation proof in `format-rules.ts`, tested in both arrival orders with a failing-proof case (`tests/unit/overstoryd-merge/transfer-extensions.test.ts`). Server-side only; no wire or schema change | implemented, not deployed; gate in [small work](plans/small-work.md#server-refinements) | [transfers](docs/architecture/overstoryd/merge-tool.md#transfers) |
| Moves on the fast paths (Native 008): overstoryd accepts a head trace whose frames are basis `moveSource` operations and then `editSource` operations without the sidecar, executing them with `arrangeSources` in `@ovst/protocol`; the sidecar's exact-basis path also takes basis moves and ordered lineage. Tested against eager and full evaluation, with a peer edit in both arrival orders (`tests/unit/overstoryd-merge/source-moves.test.ts`, `tests/integration/overstoryd/source-acceptance.test.ts`). No wire or schema change | implemented, not deployed | [fast-forward](docs/architecture/overstoryd/merge-tool.md#fast-forward) |
| Accepted whole-entry and source-range conflicts: competing edits retained as alternatives with attribution, root decisions, guarded partial resolution, authorized historical inspection (schema 10 and 11) | deployed | [reference implementation](docs/architecture/protocol/README.md#conflict-inspection) |
| Resource policy and execution authority: shared `who` / `via` / `allow` / `within` grammar, governed policy index, host-private execution tokens, guarded scoped snapshot effects, revocation stream, restrictive-intersection conflict acceptance, Story consent review (schema 13) | deployed, installed | [access control](docs/overstory-spec/05-access-control.md), [reference implementation](docs/architecture/protocol/README.md#resource-policy) |
| Client synchronization machine: one working-tree update machine (Swift `UpdateMachine`, TypeScript `reduceUpdate`) executing one shared fixture, with held rejections, polling, explicit synchronization and an effect-driven Swift runner over a change log pinned by shared runner vectors; editors append each generation straight to the change log with no admission machine or recovery store (Clients 001 phases 1–3). Story Sync runs the TypeScript runner per placed folder (phase 4) | installed, verified (Mac, iPhone, daemon) | [working-tree updates](docs/overstory-spec/09-client-synchronization.md), [the update machine](docs/implementing-sync-services/update-machine.md), [editor sources](docs/implementing-editors/editor-source.md) |
| Durable change log (`sync/change-log.json`, formerly the source admission queue): exact source, basis, and candidate records with explicit predecessors, fsynced journals (schema 4, one frame per record), trace compaction, read-your-writes sessions, publication and settlement, recovery after restart; installed Story emits the supported operations and explicit structural snapshots | installed, verified | [local system](docs/architecture/story-browser/local-state.md#change-logs), [editor sources](docs/implementing-editors/editor-source.md#6-change-invariants-and-trace-compaction) |
| Story working-tree editors: the Mac and iOS apps edit placed trees directly as working trees over the object store; the daemon is the folder's client plus loopback bootstrap, credential, and object services and has no editor path (its leftover mutation path and write journal were deleted 2026-09-24; old `journal/` state directories are orphaned on disk) | installed, verified | [local system](docs/architecture/story-browser/local-state.md#native-working-trees), [client design](docs/implementing-editors/design.md) |
| Story navigation: observable Back availability, editor-link pushes, exact cross-tree destinations, and Back/Forward/native-pop provider reopening without resetting tab history | implemented; Mac user-verified | [client design](docs/implementing-editors/design.md) |
| Story editor recovery: edits recover from the change log, with no recovery store, admission debounce or local conflict review; History shows an empty state until the host serves history (Clients 001 phase 3) | installed, verified (Mac, iPhone) | [local system](docs/architecture/story-browser/local-state.md#editor-recovery), [editor sources](docs/implementing-editors/editor-source.md#4-recovery) |
| Story operation capture: ordinary and compound sibling-body entry moves and copies, explicit current-page path rename with subtree relocation and proactive link healing, post-copy page-ID edits, explicit removals for private Trash, same-document and cross-document copies, page-conversion undo and redo, exact CRLF and BOM preservation | installed | [client design](docs/implementing-editors/design.md#labels-and-actions), [Native 008](plans/merge/008-copies-with-changes-and-compound-undo.md) |
| Story block moves (Native 008): a generation that only rearranges blocks (reorder, drag, indent, outdent, move under another parent, several blocks at once) publishes `moveSource` of each relocated block's exact source plus edits to re-indented leading spaces, instead of a retyped replacement; a peer's concurrent edit to a moved paragraph follows it. Shared vectors in `source-moves.json` (Swift and TypeScript executors and change logs); codec tests in `StoryEditorTests`; live acceptance, restart replay and a peer edit in `LiveEditorAdmissionTests`. A final block moved up gains the blank line it needs, where it used to run into its new successor | implemented, not installed; needs the fast-path deploy first | [editor sources](docs/implementing-editors/editor-source.md#3-host-responsibilities), [Native 008](plans/merge/008-copies-with-changes-and-compound-undo.md) |
| Story Move to Document as one change (Native 008): moving blocks to another page of the same tree appends one record over both pages whose frame moves their exact source (`moveSource` into the destination, plus re-indentation and separators), with a `transfer` capture of the destination beside the record's document; its basis is decided from record ancestry, and diverged local work is published and retried once. Unsupported selections leave both pages unchanged; separated spans await overstoryd 014. Tested by `TransferPlanTests`, the live `Move to Document publishes one change over both pages` (restart replay, a peer edit to the moved paragraph arriving in the destination, diverged local work, the destination open in a second editor), and the cross-page fast-path engine tests | implemented, not installed; needs the fast-path deploy first | [editor sources](docs/implementing-editors/editor-source.md#3-host-responsibilities), [local system](docs/architecture/story-browser/local-state.md#change-logs) |
| Story conflict review: sidebar navigation, page markers, exact-source comparison and composition, durable grouped drafts, recursive previews, guarded source-range and structural resolution | implemented | [client design](docs/implementing-editors/design.md#synchronization-conflicts-and-devices), [accepted-state review](docs/overstory-spec/09-client-synchronization.md#accepted-state-review) |
| Entry dates and document versions: each file entry's last accepted change and each Markdown document's accepted content versions, kept beside the hashes (schema 16); `/entry-metadata` serves the dates, and the versions wait for [overstoryd 007](plans/history/007-document-history-routes-and-restore.md)'s history routes; Mac and iOS date pages from it and date incoming changes with the host's accepted time | server deployed; clients implemented, not installed | [tree reads §1.1.2a](docs/overstory-spec/01-tree-operations.md#112a-reading-entry-metadata), [schema history](packages/overstoryd/migrations/README.md#schema-history) |
| Traced entry creation: the `addEntry` authored operation takes the fast path; page creation and a directory's first body no longer publish snapshots | server deployed; clients implemented, not installed | [source intent](docs/overstory-spec/10-source-intent.md) |
| Effect records as piece deltas: `editSource` effects store each edit's range and removed/inserted pieces instead of two whole piece copies; older records are read by recomputation | deployed | [merge tool](docs/architecture/overstoryd/merge-tool.md#retained-state) |
| Communities, accounts, and directory: a host serves community plus person/group profile trees, derives an authorization-preserving user directory with names and avatars, reserves account paths, and reconciles synchronized account configuration; native People and Share surfaces cache and search that directory; `story me create` / `me set` manage the local profile | directory implemented, account core deployed and installed | [accounts and devices](docs/overstory-spec/04-accounts-and-devices.md), [client design](docs/implementing-editors/design.md#profile-control-and-claim), [deployment](packages/overstoryd/deploy/README.md) |
| Pending community invitations: Add Person can reserve a handle with a code digest and share a join link (the account's locator with `;overstory-invite=<code>`); the recipient uses an existing or newly created identity, and the signed claim replaces the pending entry with its Profile TreeID | implemented locally, not installed or deployed | [accounts and devices](docs/overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key), [client design](docs/implementing-editors/design.md#profile-control-and-claim) |
| Native sidebar Trees mode, People footer, and single-pane profile/sync/devices management with focused account and identity actions on Mac and iOS | implemented, not installed; macOS and iOS builds passed, manual UI verification pending | [client design](docs/implementing-editors/design.md#profile-control-and-claim) |
| Plural local accounts and devices: one data home holds several host accounts, including several at one origin, in `account.yaml`, `trees.yaml`, and `devices.yaml`; Mac-to-iPhone pairing | installed, verified | [local system](docs/architecture/story-sync/data-home.md#data-home) |
| Short-lived cloud workspaces: reusable one-account bundles, exact placements under an isolated root, detached Story Sync, explicit finish, bundle revocation, `story status`; Mac Share panel "Use with an agent" creates, shares, and revokes one-tree bundles (not yet exercised against a live host) | implemented | [CLI](docs/getting-started/cli.md#short-lived-cloud-sessions) |
| Declarative collection schemas: `schema.cddl` in the Overstory CDDL profile, one collection descriptor version (1, naming `schema.cddl`) in TypeScript and Swift, open rows that accept and preserve undeclared members while declared members validate strictly, schema-directed CSV cells, validation that never normalizes, generated collection types without Zod; overstoryd acceptance and projection, the merge rules and Story Sync providers use the pure `@ovst/collection-schema` package, and QuickJS is no longer a dependency. No collections existed before, so there is nothing to migrate; a `schema.ts` is an ordinary file | implemented, not deployed or installed; the Swift model edits are unverified (no Swift toolchain where they were made; [Mac gates](plans/small-work.md#collection-schema-mac-gates)) | [collection schemas](docs/architecture/collection-schema/README.md), [child backings §2.4](docs/overstory-spec/06-child-backings.md#24-collection-schema-profile) |
| Ignored filesystem content (Filesystem 005): one membership policy in `@ovst/fs` for discovery, listing, resolution, watching, snapshots, object reads and materialization; `.overstoryignore` and `.gitignore` in Git's grammar, mandatory exclusions that rules cannot negate, and tracked paths (the folder's last-held root) that stay synchronized until deleted; the Swift preview uses a port of the same matcher | implemented, not installed; `LocalFolderPreview` is unverified on a Mac ([Mac gate](plans/small-work.md#ignore-policy-mac-gate)) | [directory format §7](docs/overstory-spec/02-directory-format.md#7-tree-membership-and-ignore-files), [ignored content](docs/architecture/story-sync/data-home.md#ignored-content) |
| Headless executable-data core: SQLite-backed query lowering and execution over the Supplies corpus, dependency-sensitive live result streams, authorized transactional mutations with durable retry receipts | implemented | [apps runtime](packages/apps-runtime/README.md), [Supplies](examples/supplies/README.md) |
| One merge-state model and squashed history: every acceptance records a merge state (tree creation, pairing, account configuration and boundary rewrites checkpoint their root; no whole-entry conflict rows); schema 18 keeps one accepted update per tree, and migration 016 squashes history to each head, keeping roots, head ids, entry dates and document versions | deployed 2026-09-24 at schema 18; history cut 2026-09-24 by migration 016 | migration 016 (deleted; its runbook is `packages/overstoryd/migrations/016-squash-history/README.md` at `d15ddce`) |
| Operational hosting: Railway and VPS deployment, persistent storage, backup and restore, coordinated upgrades, one-off migrations | deployed | [deployment](packages/overstoryd/deploy/README.md), [migrations](packages/overstoryd/migrations/README.md) |

## In progress

| Area | State | Remaining | Owning plan |
|---|---|---|---|
| Story editing and review | implemented, not installed | Copies with changes, paste and inline provenance, compound undo, and interactive acceptance of the implemented review UI | [Native 008](plans/merge/008-copies-with-changes-and-compound-undo.md), [release gate](plans/small-work.md#native-release-and-hands-on-review) |
| Markdown source-transfer policy | paragraphs deployed, not hand-verified; the extensions below implemented, not deployed | Identity-verified paragraph copies and moves reconcile with independent prose edits in either arrival order (deployed). Implemented, not deployed: list items, table rows and contextual links, same-anchor ordering, keyed JSON/YAML members and TS/JS function declaration moves ([transfers](docs/architecture/overstoryd/merge-tool.md#transfers)); their deploy and hand checks are in [small work](plans/small-work.md#server-refinements). Swift/Python declaration moves, structured moves between files, cross-document fragment and reference links and richer list hosts still require review | [overstoryd 014](plans/merge/014-merge-handles-many-cases.md) |
| Resource policy providers | deployed | Provider-specific enforcement, source resolution, activation consent, the execution sidecar, observation and soak | [Apps 005](plans/apps/005-source-resolution-and-sidecar.md), [small work](plans/small-work.md#manual-recipes) |
| Working-tree client transition | installed | The explicit soak closeout | [small work](plans/small-work.md#observation-and-soak-closeout) |
| Story for the web | not mounted | The browser editor is out of the build until it is rebuilt as a working-tree client over the same machines as the Mac app | [Web 025](plans/story-web/025-story-web.md) |
| Executable documents | core only | MDX/TSX compilation, generated typing, editor integration, React presentation, activation, Story presentation, overstoryd hosting | [Apps 001, 003, 005 and 006](plans/README.md) |
| Group management | implemented, not deployed or installed | Deploy overstoryd group membership by Profile TreeID (it matched by handle, so handle-less group members gained nothing) and top-level `/~name` trees for administrators; install the Mac New Group, Members sheet, and People/Share entry points; iOS group creation; claimed-member restoration | [design](docs/implementing-editors/design.md#profile-control-and-claim) |

| Profile locators and placement by reservation (Security 011) | deployed and installed at schema 29, 2026-09-28 ([cutover](#profiles-on-other-hosts-by-locator--2026-09-28)); no live placement host yet | A profile on another host is named by its canonical locator there (`https://A/~joe`), pinned per tree to the TreeID it first resolved to; a community member so named is a placement account with its root declared on accept, and devices connect on first use (`story place`, Add another host…); the placement claim and `homeHost` are gone. Remaining with Security 007: the iPhone flow untried by hand | [cutover](#profiles-on-other-hosts-by-locator--2026-09-28), [Security 007](#trees-on-other-hosts--2026-09-28) |
| Trees on other hosts (Security 007, 009) | deployed and installed at schema 27, 2026-09-28 ([cutover](#trees-on-other-hosts--2026-09-28)); no live placement host yet | The iPhone opening trees on a placement host (installed at schema 29, untried by hand); making a folder into a tree from the Mac app waits on [Filesystem 024](plans/filesystem/024-disk-editors-for-non-tree-folders.md). A live second overstoryd is Joe's decision | [Security 007](#trees-on-other-hosts--2026-09-28) |

## Specified but not implemented

- Host-hosted agents and their portable frontmatter contract.
- Static baking and additional portable live-deployment adapters.
- A complete Postgres child provider, observation contract, and bidirectional projections.
- Deferred workspace capabilities: multiple local placements of one TreeID, durable pinned historical placements, reader-local overlays.
- Linux and Windows daemon supervision.

## Known gaps

- **Storage is unbounded.** The per-tree object and byte quotas were removed from update acceptance; nothing bounds retained history, the iOS replica keeps every accepted object, and the retired editor recovery store's directory is left on disk unpruned. An object collector runs by hand over `railway ssh`: `packages/overstoryd/src/collect-objects.ts` deletes objects outside the [retention definition](docs/architecture/overstoryd/README.md#retention-and-object-collection) the integrity audit also verifies, after a grace period, safely beside a serving overstoryd. Rehearsed 2026-09-24 on the 13:13Z live backup after migration 018 (`--delete --grace-hours 0`): 82,725 objects / 247 MB scanned, 2,760 / 116 MB live, 79,965 / 132 MB deleted, 12 s; the objects directory went from 479 MB to 118 MB on disk; `/.overstory/integrity` passed, tree refs matched migration 018's report, and the sidecar replayed every entry the same as on an uncollected copy. `document_versions` alone keeps 2,683 bodies / 106 MB (mostly versions of one 60 KB `_index.md`), so retained document history, not dead objects, is now the growth. First live run 2026-09-24 at build `14b8189c` (backup `.backups/railway/20260924T142722Z/`, sha256 `c10fd5a3…`; default 24-hour grace): 82,741 objects scanned, 2,776 / 116 MB live, 3,438 / 5 MB younger than the grace, 76,527 / 127 MB deleted in 11 s, none absent; `objects/` went from 490 MB to 144 MB on disk; `/.overstory/integrity` passed and a round-trip edit was accepted afterwards. Its schedule and a document-version retention decision are [small work](plans/small-work.md#schedule-the-object-collector); packing is [overstoryd 001](plans/performance/001-pack-object-storage.md).
- **Every accepted-state change requires review.** The host requires exact accepted-state guards, so a client must review the latest evidence even when projected bytes are equal or the update is unrelated.
- **Range translation across a merged predecessor** is future work; the host relates an authored predecessor to its accepted projection through a validated or exactly replayed prefix only.
- **Cross-account rehome** (`story mv` between accounts on different hosts) fails before mutation until a resource-policy transfer contract is reviewed. It worked only for legacy-grammar accounts, and that grammar is gone. After overstoryd 005 a profile has one home host, so `story mv` refuses any move to another host; placing trees on other hosts is [Security 007](#trees-on-other-hosts--2026-09-28).
- **Cross-process ownership of a client state directory** is not enforced; one process must own it by convention.
- **Latency.** The target is under 100 ms of server processing for a small fast-forward. Live on 2026-09-24 (255 update requests after the overstoryd 016 deploy, all accepted, no 503s): median 48 ms, p90 302 ms, max 1.4 s; single fast-forwards 39 ms median; requests that asked the sidecar 201 ms median, the slowest being batched catch-up uploads of 5–12 updates (0.4–0.9 s in the sidecar) and slow client uploads. Locally, from the client, a plain traced edit on the head takes 2 ms with 1 file, 8 ms with 110 and 41 ms with 1,000 files in one directory, so the 20 ms target at 1,000 files is not met; no live directory exceeds 63 entries. The first merge after a restart replays history (the production main tree's 282 entries in about 1.2 s locally, an estimated 3.5–4.5 s live) and answers retryably past 10 s; saved sidecar states (below, not deployed) make it replay only from the nearest save.
- **No accepted-history listing.** Known retained roots are readable as immutable snapshots by callers who can read the tree; there is no history or metadata route. Retained accepted history starts at migration 016's cut (each tree's head then); document versions and entry dates from before the cut are kept. The log entries of overstoryd 016 hold that history as a hash chain, which a listing can walk. [overstoryd 007](plans/history/007-document-history-routes-and-restore.md) owns it.
- **Compatibility cutoff.** Account configurations are gone (schema 22): clients read only tree configurations, and the readers of the old `account.yaml` / `trees.yaml` remain only in migration 022's `legacy.ts`, deleted with its directory after 2026-10-10. Workspace registries require complete object records and keep path-derived `rt_` root IDs as valid identities (106 on the Mac at the 2026-09-21 cutoff). From the schema-26 cutover, scalar group members are ignored, not read.
- **Moves made outside Story are not link-healed.** A Rename or Move in the Story app heals links to the page and to everything under it, plus the moved pages' own relative links. A page moved with Finder, `git mv`, an editor or an agent keeps working through its stable key, but readable paths that name it stay stale. Filesystem 025 would have had Story Sync heal those; Joe dropped it on 2026-09-25 as not needed.
- **Production recovery, dispute handling, and high availability** are not productized; the deployment guide documents backup, restore, and coordinated upgrades only.

## Where work is tracked

- [Outcome menu](plans/README.md), a short set of choices with open priorities.
- [Plans](plans/README.md), every remaining plan with why and when.
- [Small work](plans/small-work.md), small tasks and outstanding installation, deployment, hands-on and soak checks.
- [Ideas and open questions](plans/ideas.md).

## overstoryd cleanup review — 2026-09-28

Deployed with migration 032 at `bb1fc3f1`, 2026-09-28; the Mac and iPhone
apps are not rebuilt with it, and the Swift gate has not run (the one Swift
change is the descriptor access check below). A
review of overstoryd for legacy and redundant surface, and the fixes it led to:

- **Unknown update base.** A base the host does not hold for the tree, or a
  stale execution guard, is a non-retryable 409 `conflict` with
  `server-update` details (tree operations §4.2), no longer a retryable
  `resync-required`, which a retry met again. Tested in `update-host.test.ts`.
- **`resync-required` means one thing.** It ends a watch only when a snapshot
  will serve where catch-up does not (an unretained cursor or basis). A
  revoked caller's watch closes without an event; the reconnect is refused
  with 401 or 404 (tree operations §1.1.3). Both clients already reconnect on
  a clean end, so neither changed.
- **Descriptor access is `read` or `write`.** An unreadable tree is 404, never
  a descriptor with `none`: spec, TypeScript model, overstoryd and Swift
  validation. Story Sync's mapping of `none` to `read` is gone.
- **Other hosts through `ProtocolClient`.** Published device keys, remote
  groups and profile-locator resolution use one anonymous, no-redirect
  client (`other-host.ts`) instead of three hand-built fetchers; each keeps
  its 4xx-versus-outage rule. `ProtocolClient` gained a `redirect` option.
- **Account SQL in one place.** Account inserts, the claim digest, member
  enabling, placement accounts, the community host and account-guarded device
  revocation are `AccountDirectory` methods; `AccessControl` shares the
  daemon's directory.
- **Smaller fixes.** The CLI reads a reserved profile from
  `overstory-profile-state` only, not the page text; the overstoryd README and
  host doc were corrected (`reconcile.ts`, opt-in rate limits).
- **Migration 032 (schema 29 to 32).** Batch steps 030–032, cut over live
  as [`032-drop-unused-fields`](packages/overstoryd/migrations/032-drop-unused-fields/README.md),
  drop `trees.policy` (a tree's kind is whether it `governs` another), three
  unread timestamps and the profile facts version; no wire change. The live
  report matched the rehearsal, all 6 roots unchanged, `verify.ts --sync`
  ok, `/.overstory/integrity` ok (once), the authored manifest (112 files over 3
  placements) unchanged, a file-system round trip (5328/5329).
- **Left as they are.** The execution-token and app-runtime routes (dormant
  until [Apps 005](plans/apps/005-source-resolution-and-sidecar.md));
  `document_versions`, whose history columns nothing reads yet ([overstoryd
  007](plans/history/007-document-history-routes-and-restore.md)); the
  well-known resolution's `historical` and `stableKey`, and the error
  envelope's `tree` and `path`, which the spec defines.

## Profiles on other hosts by locator — 2026-09-28

Security 011 and batch 028–029 (schema 27 to 29) deployed at `d2b26575`;
the Mac app, Story Sync and the iPhone (Warthog) were rebuilt from it the
same day. The runbook, rehearsal and live logs are in the
[029-profile-locators README](packages/overstoryd/migrations/029-profile-locators/README.md).

- **Profiles by locator.** A group's member or a rule's subject names a
  profile on another host by its canonical locator (`https://A/~joe`),
  pinned per tree to the TreeID it first resolved to
  (`profile_locator_pins`, step 028); a community member so named is a
  placement account whose root is declared on accept. Devices connect on
  first use (`story place`, Add another host… on the Mac); the profile-key
  placement claim and `homeHost` are gone. The iPhone's Place a Tree lists
  the account's other hosts and their trees.
- **`trees.status` dropped (step 029).** Code before overstoryd 005 had
  retired one live tree, `tr_unkaimbksfitula6i5n4acid6y` (ordinary, one
  accepted update, unmounted, unconfigured); at Joe's decision the step
  deleted it, and the backup keeps it.
- **Wire changes with the batch.** The update response requires `head` and
  drops its top-level `observedThrough`; a `tree.update` watch frame is
  `{ transition, access, canonical }` with the cursor in the SSE `id`, and
  `resync-required` is `{ reason }` with no `id`; watches resume from
  `after` alone (hosts and Story Sync's local watch ignore `Last-Event-ID`);
  `/account`, `/trees` and `/directory` carry no cursor; `/access` answers
  administrators with `{ policy, locators }`.
- **Verification.** The full gate and both Story builds; the batch
  rehearsed on the live backup (6 roots unchanged, the retired tree the one
  expected difference), then live: the same report, `verify.ts --sync` ok,
  `/.overstory/integrity` ok (once), the authored manifest (112 files over 3
  placements) unchanged, a file-system round trip (5316/5317). Hand checks
  against local hosts A and B with scratch data homes: the Mac Add a person
  sheet takes `http://127.0.0.1:<A>/~joe`, derives the handle and B records
  the placement account and its root (after a fix: the URL field was not
  drawn when Invite with a code was cleared); `story place` names the URL to
  reserve before the reservation, then connects on first use for the root
  and a subfolder, which sync, and `story account` lists them; the Mac's
  Add another host… reconnects, and editing both ways and B's restart work;
  the sharing field takes a profile URL at another host and that person
  then reads the tree; a group on B listing a member by URL gives her its
  access. Not checked by hand: a remounted name making a rule match nobody
  (covered by `placement-hosts.test.ts`), and the iPhone flow, which pairs
  only with an HTTPS home host and needs a live second host.

## Trees on other hosts — 2026-09-28

Security 007 (placement hosts) and Security 009 (the placement grace and
remote groups) deployed at `02689859` with batch 027 (schema 26 to 27,
`accounts.home_host`); the Mac app, Story Sync and the iPhone were rebuilt
from it the same day. The runbook, rehearsal and live logs are in the
[027-placement-accounts README](packages/overstoryd/migrations/027-placement-accounts/README.md).

- **overstoryd.** A placement host records a claim's home host
  (`accounts.home_host`) and declares a placement root at `/~handle`; sessions
  open from an in-memory copy of the home host's published device keys (60 s
  lifetime, 5 s early refetch, one-hour grace while the home is unreachable,
  a session ending when its copy's grace does); a device deleted at the home
  loses its sessions and watches within the lifetime. A rule's
  `{profile, homeHost}` subject matches the members of a publicly readable
  group hosted elsewhere, refreshed every 30 s with the same grace; an
  unreadable group matches nobody. The challenge and pairing-claim limits are
  now opt-in (`OVERSTORYD_RATE_LIMITS=1`); in the hand check they turned a
  home outage into "Too many challenges".
- **Clients.** `story account place`, `story place` onto a placement host
  (the placement root first, then trees below it), `placements.yaml`
  `{tree, host}`, per-host sessions in Story Sync, whose `/v1/credential`
  keeps a placement host's retryable refusal as a 503 with `details.homeHost`,
  and `POST /v1/bootstrap/placements`. In Swift: the claim, placement
  connections, Other Hosts on the Mac and iPhone, and on the Mac opening,
  editing and sharing trees on a placement host, with the profile, devices and
  apps read at the home host and a home-host outage shown as one.
- **Verification.** `tests/integration/overstoryd/placement-hosts.test.ts`,
  `story-sync-placement-host.test.ts`, `story-sync-placement-route.test.ts`,
  `cli-account-place.test.ts`, the Swift packages, `StoryAppTests` and the
  full gate on the Mac. Hand checks against local hosts A, B and C with a
  scratch data home: CLI claim and placement; the Mac app placing on a host,
  opening and editing trees there both ways, recovering after the placement
  host restarts, syncing through a home outage inside the grace and naming the
  home host past it; a public group on A giving its member access on B, with
  the Mac sharing view showing the host and keeping it across a level change.
  Fixes from the Mac build: macOS Keychain listing, the sharing view and tree
  declaration on a placement host, host names with ports, and the refusal
  surfaced in the app.

## Schema-26 cutover — 2026-09-27

Deployed and cut over live 2026-09-27 at `377e87ac` (overstoryd 019, closed):
the host serves only schema 26, and the Mac app, Story Sync and the iPhone
were rebuilt from it in the same sitting. The runbook and its rehearsal and
live logs are in the
[026-key-devices-only README](packages/overstoryd/migrations/026-key-devices-only/README.md).

- **Batch 024–026.** `migrations/026-key-devices-only/` (batch 024–026) carries schema 23 to 26 in one
  transaction: 024 drops `profile_resets` (refusing a pending row), 025 makes
  `account_challenges` and `device_challenges` one `challenges` table apart by
  `purpose` (copying only redeemable rows; a challenge of one purpose is never
  found or consumed as the other), and 026 drops `devices.token_digest`, with
  `public_key` required unless the device is revoked, refusing while any
  unrevoked device has no key. The batch finishes with the product's schema
  and row checks. Tested from a synthetic schema-23 root (`migrate.test.ts`).
- **Key devices only (Security 006 close-out).** The spec (accounts §1.2, §5,
  access control §2) and overstoryd have one kind of device: every `devices.yaml`
  entry has a `key`, fixed at enrollment, and a device authenticates only by a
  session it opens by signing a challenge. overstoryd refuses an entry without a
  key or a changed key; historical configurations still parse. Gone: digest
  enrollment in pairing, claims and bootstrap accounts, move-to-key (the CLI,
  `POST /v1/device-key`, the apps' buttons), `StoredDeviceCredentialProvider`,
  `legacyCredentials`, the iPhone's `rekeyStoredAccounts`, and a placement
  without a configuration tree in the Mac app. `GET /v1/credential` serves
  sessions only; cloud bundles are `arbor-cloud-v2` with a device key seed.
  Tests sign in as named key devices through `tests/helpers/devices.ts`.
- **CBOR object transport (overstoryd 020).** Update requests and results and the
  account claim travel as JSON or as canonical CBOR of the same value
  ([tree operations §4.4](docs/overstory-spec/01-tree-operations.md#44-request-and-response-encodings)),
  negotiated by `Content-Type` and `Accept`, with JSON error envelopes and
  unchanged digests; clients default to CBOR. The claim carries its
  configuration as an activation element whose `change` is the DeviceID; the
  `{ root, objects }` reader is gone. Durable attempts record `contentType`
  (absent is JSON, so earlier attempts replay as JSON). `/v1/bootstrap`
  answers CBOR only. `protocol-cbor-transport.json` runs every request,
  response and claim vector through both encodings in both languages;
  overstoryd's update-host tests run once per encoding.
- **Legacy readers removed (Cleanup 007).** Scalar `/~handle` group members
  (now ignored, as the spec says), the pre-plural `account.yaml` refusal,
  placements without a configuration tree, Keychain identities without
  metadata and the app's second-identity reconciliation, `HostAccountStore`'s
  early connection records, `retireEarlierSyncState`, and bare node
  `modifiedAt`. Update control before schema 4 stays read (its removal was
  reverted): the survey found a schema-2 record under a Mac app placement
  and a schema-3 one under an iPhone placement. Kept: `NativePlacementStore` dropping unreadable
  records; `FolderSync.loadKnown`'s fallback to the placement's accepted base,
  which a configuration checkout needs before its first write; `rt_`
  workspace root IDs, which are live identities, not legacy.
- **The data home names what it holds.** `~/.arbor/accounts/<ConfigurationTreeID>/`
  is `~/.arbor/configurations/`, and the code says profile configuration
  (`ProfileConfigurationYAML`, `loadProfileConfigurations`,
  `editProfileConfigurationFile`, `profile-config.ts`). Per-tree sync state is
  keyed by TreeID, so the one install renames the directory by hand with Story
  Sync stopped; `.state/accounts/` keeps its name.
- **Survey.** `026-key-devices-only/survey.ts` and `survey-host.ts` check read-only
  that the state each removal assumes gone is gone on the Mac, the iPhone copy
  and the host, including no pending account claim; each failure names the
  commit to revert or the live step to take.

Evidence: `bun run typecheck`; `bun run test` with `STORY_CREDENTIAL_STORE=file`
(the container lacks libsecret) matches the base commit apart from two
environment failures (a saved-state timing test under load, and an
unreadable-folder test that passes as root); `bun run test:migration
packages/overstoryd/migrations/026-key-devices-only`; the TypeScript half of `bun run
test:protocol` (338); `bun run check:links`. The Swift packages (StoryKit,
Overstory, OverstoryObjectStore, OverstoryWorkingTree, OverstoryClient) were
built and tested on Linux with Swift 6.2 against stand-ins for CryptoKit,
Security, OSLog and UniformTypeIdentifiers: all pass except
`profileConfigurationFileEdit`, which fails on Linux Foundation's
`replaceItemAt` at the base commit too.

On the Mac before cutover: all six Swift package suites, `StoryAppTests`
(77 passed, 1 live-server skip), `bun run test:protocol` and the full gate
pass. The Mac fixes: the app did not compile (`a4dd2684`'s
`StorySyncCredentialProvider.shared` took a required configuration tree the
bootstrap descriptor leaves optional), the pairing test expected
`accounts/`, the cloud-bundle fixture is now Apple's own DEFLATE output, and
the survey read at most 1 MB of `security dump-keychain` (Joe's is 2 MB) and
checked the real Keychain for another `--home`. The survey found schema-2
and -3 update-control records under placed Mac and iPhone trees, so
"Remove update control before schema 4" was reverted.

Live, 2026-09-27: `dv_ry4dqmh32o5ovzccizd2xfhhje` removed from
`devices.yaml` (update 5183) before the backup
`.backups/railway/20260927T175419Z/` (volume.tar sha256 `8008cdba…`, with
the rehearsal copies, `dot-arbor.before` and the authored manifests; keep
until 2026-10-11; the volume's `/data/backups/026-key-devices-only` is for
Joe to delete). The live run matched the rehearsal (23 → 26 through
024–026); after the redeploy all 7 roots were unchanged, `verify.ts --sync`
ok, `/.overstory/integrity` ok (called once). `~/.arbor/accounts` became
`~/.arbor/configurations` with Story Sync stopped; on restart every
placement was idle at its old update, the configuration checkout included,
and the 112 authored files were unchanged. Round trips: a file created and
deleted in `/~joe/todos` (5186 → 5187 → 5188, page 200 then 404), then an
edit from the rebuilt Mac app and one from the iPhone (Joe; 5200). The Mac
app's Devices section shows the Mac (administrator) and the key iPhone.
Migration directories go when their backups age out: 018–021 after
2026-10-09, 022 after 2026-10-10, 026 after 2026-10-11.

## Host–client communication review — 2026-09-27

Implemented, not installed or deployed. A review of how overstoryd and its
clients talk, and the fixes it led to:

- **Errors keep their codes.** TypeScript's `ProtocolHTTPError` carries the
  envelope's `code`, `retryable` and `details`. A 409 other than a decodable
  conflict (`resync-required`, a boundary conflict) was a plain `Error` the
  working-tree coordinator retried forever; it now holds, as Swift did.
  overstoryd marks an expired account challenge `details.challenge: "expired"`
  and every protocol route answers 404/405 with the envelope; public pages
  give a browser a small page. A public raw file is typed by its name,
  `no-cache`, `nosniff` and sandboxed.
- **Watches.** overstoryd comments on every watch at once and every 20 s, with
  no opt-in header (spec §4.2); the TypeScript watch treats 60 s of silence as
  lost and Story Sync replaces an ended session on a watch 401. One host-wide
  ticker replaces each stream's 250 ms revocation timer. Swift's three
  observation loops share `runObservationLoop` and TypeScript's two share
  `reconnectingStream`: only an event resets the backoff, which fixes the
  visit follower's 500 ms retry loop.
- **Fewer round trips.** The update response's `head` is in the spec and
  installed by TypeScript, so a publish no longer reads the descriptor; a
  clean tree skips its 30 s poll while its watch is open. Visits replay the
  watch's transitions instead of downloading a snapshot per update. Each
  account shares one device session per process in both languages (Swift
  built a new provider, and so a new session, per request). `GET /trees`
  and every tree route make one access decision instead of `canRead` then
  `canWrite`; a snapshot's ETag is its root.
- **Smaller wire.** Update conflicts carry `kind`, `completed`,
  `failedIndex`, `current` and `conflicts`; the unused draft transition and
  echoed roots are gone from the spec, host and both clients.
- **One decode.** The accepted-read contracts and the codecs are one layer in
  each language, so a watch object is base64-decoded and hashed once (it was
  three times in TypeScript; Swift re-encoded each transition to JSON). The
  request codecs have one name each, one `arbor-update/2` digest chain
  remains, and snapshot codecs no longer duplicate each other.
- **Structure.** The profile identity, `placements.yaml` and the setup lock
  moved into `@ovst/client`, ending its import cycle with Story Sync.
  Swift has one CBOR encoder; `LayeredObjectStore` and the app's leftover
  mutation-path models are deleted.
- **Kept deliberately.** The Mac app and Story Sync each watch an open tree
  ([local state](docs/architecture/story-browser/local-state.md#native-working-trees));
  Railway's readiness probe stays `/`, since `/.overstory/health` runs
  `PRAGMA quick_check` over the whole database.

Client-side legacy readers went in the [schema-26 cutover](#schema-26-cutover--2026-09-27).
Evidence: `bun run typecheck`, `bun run test`,
`bun run test:protocol` (TypeScript half), `bun run build`, `bun run check:links`,
new tests in `tests/unit/transport-errors.test.ts`, `reconnecting-stream.test.ts`,
`coordinator-poll.test.ts`, `device-key-store.test.ts` and the Swift packages'
suites. The Swift packages and the app's account, visit and Story Sync files
were compiled and tested on Linux against stand-ins for Apple frameworks,
not on a Mac; the app target and `StoryAppTests` still need an Xcode build.

## Tree configurations (overstoryd 005) — 2026-09-26

Deployed and verified live 2026-09-26 at schema 22 by
[migration 022](packages/overstoryd/migrations/022-tree-configurations/README.md):
the live report matched the rehearsal on the 11:41 UTC backup in every
section (no access change, nothing lent before or after), `verify.ts --sync`
and `/.overstory/integrity` ok, Joe's authored files unchanged, a round-trip edit
accepted (updates 5098/5099), and Joe confirmed the Mac and iPhone apps. The
reasoning and the failure walk-through are in
[tree configurations](docs/architecture/overstoryd/tree-configurations.md); the
plan is deleted. Fixed during testing and the cutover: `apps.yaml` block edits
(Swift), Story Sync starting placements a claim or pairing adds, app approvals
listed in the permissions panel, hosted test helpers stopping with their app,
`yaml` declared for overstoryd's production image, and the Mac app dropping
unreadable saved placements (which had made every tree fail to open, silently)
and keeping its empty view on screen.

What landed, as recorded before the cutover:

- **Spec** (phase 1): [accounts](docs/overstory-spec/04-accounts-and-devices.md)
  §1–§3 and §5–§7 describe host accounts as host state keyed by profile, one
  home host per profile, the tree configuration graph (`access.yaml`,
  `mounts.yaml`, `apps.yaml`, `devices.yaml`), its derived TreeID and
  `;overstory-config`, who may edit it, its invariants and merge, and declare /
  activate / mount; [access control](docs/overstory-spec/05-access-control.md)
  §1 renames `via` to `app`, adds `admin`, and §1.1 replaces the sponsoring
  account with lenders. Vectors: `tree-configuration.json` (replaces
  `configuration-yaml.json`), `resource-policy.json`, `protocol-values.json`,
  `protocol-account-challenges.json`. The plan records the answers to its four
  open questions and a walk-through of the failure cases, each with its test.
- **Protocol** (phase 2): `packages/protocol/src/config/tree-config.ts`
  parses, validates, writes and merges the graph; `model/resource-policy.ts`
  has the `admin` operation, `members`, `app` and `apps.yaml` rules; the
  account configuration graph is deleted.
- **overstoryd** (phase 3): schema 22 (`tree_policy`, `tree_admins`,
  `app_policy`, `mounts`, `trees.governs`; accounts keyed by profile; no
  `access`, `resource_policy`, `tree_reservations` or `trees.account_id`);
  `tree-config-v1` authorization, merge and invariants
  (`tree-config-policy.ts`); boundaries recomputed from mounts; claims declare
  the profile tree and activation mounts it at `/~handle`; declaration by
  `POST /.overstory/trees/{T};overstory-config/updates`; execution grants name a
  lender (`execution-authority.ts`, `access.ts`); operator recovery
  rewrites `devices.yaml` as an accepted update (now `overstoryd recover`).
- **Clients** (phase 4): the TypeScript client, Story Sync and the CLI claim
  with the derived configuration, activate the profile, declare and mount
  trees, edit other trees' configurations through the host, and rename by
  renaming mounts; Story Sync's private-state stamp is 6. The Swift packages
  and apps (resource rules with `app`/`admin`, consent writing `apps.yaml` or
  a tree's `access.yaml`, `TreeConfigurationClient`, Keychain rekeying).
  Written without a Swift toolchain, then compiled and tested on the Mac.
- **Migration 022**: `run.ts` (with its refusals and report),
  `rekey-data-home.ts` for the Mac, and `migrate.test.ts`; rehearsed on the
  live backup, then run live.

Verification before the cutover, on the Mac: `bun run typecheck`, `bun run
test` (1500 pass, parallel-only flakes pass alone), the migration suite (5),
`bun run test:protocol`, the hosted smoke test, the full `StoryAppTests`
bundle (71), the Swift package suites, and an end-to-end run in a debug build
against a disposable overstoryd (claim, pair, revoke, share, approve and remove
an app). Earlier, in the cloud session: `bun run typecheck`, `bun run build`,
`bun run check:links`, `git diff --check`; `bun run test` 1497 pass, 1 skip,
1 fail (`tests/unit/discovery.test.ts` "skips unreadable descendants", which
fails the same way on `main` when run as root); `bun run test:migration
packages/overstoryd/migrations/022-tree-configurations` 5 pass;
`bun run test:protocol` 25 pass before its `xcodebuild` step, which needs a
Mac.

## Ignored filesystem content (Filesystem 005) — 2026-09-25

Implemented; Story Sync not yet restarted on it. A placed folder's
`.overstoryignore` and `.gitignore` now keep an untracked `.env`, cache or build
output out of the tree: it is not discovered, listed, indexed, snapshotted,
uploaded, overwritten, or deleted by a pull. `IgnorePolicy`
(`packages/fs/src/ignore-policy.ts`) is the one decision every consumer asks;
`snapshotDirectory` and `materializeTree` take a `skip` built from it
(`membershipSkip`) and the folder's tracked root (`trackedEntries`).
`WorkspaceFS` filters listings, resolution and watcher events through it,
reloads and rediscovers once per ignore-file edit, and reports changes at
ignored paths on a separate channel that `FolderSync` turns into a scan only
while the path is tracked.

Tracked needs no new state: it is `known.root`, the root the folder last held,
so an existing placement's already-uploaded `.env` stays synchronized and
needs no upgrade step. A first placement tracks nothing. Tracked-root
directories come from the scan that produced that root, then the object cache
inside `forTrackedLookup`, where a directory rebuilt from disk never consults
tracked paths itself, so lookups cannot recurse. A pull writes every tracked
entry; its cleanup keeps what either the pre-write rules (read from the root
the folder held) or the written root's rules ignore, and if a rule the pull
removed uncovers local content, the folder publishes it rather than failing
verification. `FilesystemObjectSource` rebuilds and audits with the same
policy and tracked root; a changed ignore file drops directory rows beneath
it. The CLI's cloud-placement readiness check applies the policy too.

The matcher is our own, not the `ignore` package: separate per-file instances
of it report `a/b` ignored when `.gitignore` says `a/` and `.overstoryignore` says
`!a` (Git includes it), and it matches case-insensitively by default. Unlike
Git, `?` and brackets match one Unicode character, not one byte. Git's
machine-private sources are never read. Evidence: `bun run typecheck`;
`tests/unit/ignore-policy.test.ts` (70 shared cases in
`tests/fixtures/ignore-policy/cases.json`, each non-mandatory case checked
against `git check-ignore`; UTF-8 diagnostic; global Git sources ignored);
a scratch differential against `git ls-files` directory traversal over
about 6,400 random paths with no disagreement;
`tests/unit/discovery.test.ts`, `tests/integration/workspace.test.ts` (live
rule edits, page-ID maps), `tests/unit/protocol-objects.test.ts`,
`tests/unit/filesystem-object-source.test.ts`, and
`tests/integration/self-sync.test.ts` against a live overstoryd (ignored content
never published and kept across a pull and a restart; a tracked `.log`
uploaded when edited through the ignored-path channel, pulled, deleted, then
kept local; remote deletions and rule changes keep ignored bytes, and a
removed rule publishes what it uncovered; an ignore file that is not UTF-8).
`bun run test` in the cloud container: 1,485 pass, 3 fail, the same 3 as an
unchanged `HEAD` there (`supplies-*` cannot resolve `overstory/data`; the
unreadable-directory discovery test runs as root). The overstoryd merge suites passed (360); the TypeScript half of
`bun run test:protocol` passed; its Swift half needs `xcodebuild`.
`IgnorePolicy.swift` compiled in Swift 6 language mode with the Swift 6.2 Linux
toolchain and passed the shared fixture under swift-testing, plus 9,600 random
cases compared with the TypeScript decisions; `LocalFolderPreview.swift` and
the preview test depend on Apple-only modules and have not compiled
([Mac gate](plans/small-work.md#ignore-policy-mac-gate)). A warm
50,000-file scan with the policy took about 10% longer in that container
(8.5 s against 9.4 s, noisy); one decision costs about 5 µs. Not done: marking
ignored paths in the Mac app's "what it would publish" view, and an
`story untrack` command ([small work](plans/small-work.md#smaller-candidates)); the recovery tool
(`packages/story-sync/recovery/`) still snapshots disk without the policy.

## Declined folder paths (Filesystem 011) — 2026-09-25

Implemented; Story Sync not yet restarted on it. A rejection no longer stops a
placed folder. When overstoryd definitively rejects a folder request, `FolderSync`
records the request's footprint (the smallest entries differing between its
base and final candidate) as **declined paths** in `sync/declined.json`, and
discards the request from the change log. The folder keeps its bytes. Each
later scan publishes the folder against the accepted state with the accepted
entry at every declined point, as a fresh change; accepted updates are written
everywhere except declined points. A declined path climbs to the highest
ancestor where the folder and the accepted state are not both directories, so a
declined directory deletion is never published in part, and accepted content
missing from a declined path is declined wherever it reappears, so a declined
move is never half published (`packages/story-sync/src/declined-paths.ts`). A
path is released when the folder matches the accepted state there.
`GET /v1/declined`, `POST /v1/declined/restore` and `POST /v1/declined/resend`
back the new `story declined [--restore|--resend]`;
`LocalTreeDescriptor.declined` lists the paths and `story status` shows
`declined`. A request rejected as `unsupported` is still held whole
(`sync: "conflict"`) until `POST /v1/held/discard`, which now handles only that
case. "Declined" is the user-facing word; the update machine's `held` state is
unchanged, as are the control schema and Swift runner; the coordinator gained
`heldRequest()`. The folder is the record of declined intent, so there is no
effect ledger: snapshot reconciliation is by state. Spec 09 §5 gained the
snapshot rule. Evidence: `tests/unit/declined-paths.test.ts`;
`tests/integration/self-sync.test.ts` (a real overstoryd rejection of an account
configuration path, kept across restart and restored; independent edits
published and a remote update written while a path is declined, then resent; a
path released when the folder is put back); `bun run test`. overstoryd's child-tree
boundary rejection (`ReservedBoundaryConflictError`) answers 409 `conflict`
without update details; since 2026-09-27 both clients treat that as a refusal
and hold it rather than retrying (`tests/unit/transport-errors.test.ts`). The hands-on gate is in
[small work](plans/small-work.md#observation-and-soak-closeout).

## Story Sync write path removed — 2026-09-25

`WorkspaceFS` now only reads, discovers and watches. Its write side had no production caller after the daemon's editor path went on 2026-09-09 (`8e4ae386`), so it was removed along with the tests that covered only it: `writeMarkdown`, `writeFile`, `mutate`, the per-node coordinators and echo/stomp settlement, the `fs-transactions` journal and its recovery, `FsConflictError`, `FsInjectedCrashError`, and `faultInjector`, which nothing passed. `FsEvent` no longer carries `origin`, `classification` or `batch`, since the watcher is its only source. Also removed: the protocol's `ContentWorkspaceOperation`/`StructuralWorkspaceOperation`/`MutationRequest` family, `NodeWriteRequest`, and story-sync's `RevisionConflictError`. `WorkspaceEditor` is now `WorkspaceNodes` (`workspace.nodes`); its `snapshot`/`children` stay for Apps 005. The old daemon healer had already gone with Cleanup 001. `story-web` still names the deleted types; it is excluded from typecheck and Web 025 rebuilds it. Existing `.arbor/fs-transactions/` directories are left in place and are no longer read. Filesystem 025 was deleted: Story's Rename/Move already heals subtrees (see Known gaps). Evidence: `bun run typecheck`, `bun run test`, `tests/unit/fs.test.ts`, `tests/integration/workspace.test.ts`.

## File-relative Markdown links and readable key tokens — 2026-09-25

Deployed (overstoryd build `20d068ea`), Story Sync restarted and the Mac and iOS apps rebuilt on 2026-09-25; the todos tree was rewritten the same day, and Joe verified links in the Mac and iPhone apps. Cleanup 001 is closed; its plan (which absorbed Cleanup 005) is in git history before this entry. A
relative link in Markdown resolves from the directory holding its source file
and names the target's body file (`Calendar.md`, `x/_index.md`), so Obsidian
and other Markdown readers follow it; a stable key is the readable token
`#overstory-key=id:h31mlm` or `;overstory-key=id:h31mlm` everywhere except the `~row-`
segment ([locators §2](docs/overstory-spec/03-locators.md#2-stable-keys-revisions-and-fragments)).
A bare `#fragment` is only a content fragment, the `arbor://…/node/…?stableKey=`
read shim is gone, Markdown IDs convert to keys only through
`markdown-identity.ts` and Swift's `markdownStableKey`, and Story Sync's owner
maps are keyed by stable key. Same-tree Swift document rows are relative
links; moving or re-forming a page heals its own outbound links as well as
inbound ones (`healMarkdownLinks`, TS and Swift). The Swift search index is
format 2 and rebuilds from older files. Evidence: the shared vectors
`url-resolution`, `node-targets`, `stable-key-tokens`,
`markdown-source-directories`, `markdown-links`, `markdown-link-healing`,
`markdown-link-destinations` and `directory-documents` pass in TypeScript
(`tests/unit/logical-url.test.ts`, `directory-document.test.ts`) and Swift
(`LogicalURLTests`, `OverstoryWorkingTreeTests`, `StoryEditorTests`);
`tests/unit/overstoryd/public-page.test.ts`; `tests/integration/workspace.test.ts`.
The todos rewrite is [migration 021](packages/overstoryd/migrations/021-file-relative-links/README.md): update 5002 rewrote 135 links in 21 files, verified before publishing with `story pending` (every change was inside a link destination), and update 5003 repointed 15 already-dangling links by hand. Five links with no matching page are left for Joe.

## Story Sync folder deltas, pause and pending — 2026-09-25

Implemented; Story Sync not yet restarted on it. A folder change against an
accepted basis sends each changed file and directory as an object delta from
the object at the same path whenever that is smaller, as Swift editors already
did; a change chained on an unsettled change still sends whole objects. The
pairing and size rule moved from overstoryd's accepted transitions into
`transitionPayload` in `@ovst/protocol`, with `walkTreeDiff` beside it, and
overstoryd now calls it. Evidence: `tests/integration/folder-deltas.test.ts` (a
large Markdown edit publishes as a delta and overstoryd accepts it; a chained
change goes whole), and the unchanged `accepted-transition` tests.

A placed folder can be paused: `POST /v1/placements/pause` and
`/v1/placements/resume`, `story pause` and `story resume`, a durable
`sync/paused.json` flag, and `sync: "paused"` on the tree descriptor (the
Swift client decodes `sync` as a string and needed no change). `GET
/v1/pending` and `story pending [--json]` show the exact request the next
publication would POST, assembled by `localChangeRequest`, which the change
log now uses too; the human view is `describeTransitionPayload` in
`@ovst/protocol`. Evidence: `tests/integration/folder-pause.test.ts`
(nothing publishes while paused, across a daemon restart; pending is empty
with no changes; resume sends exactly the last pending body) and
`tests/unit/protocol-updates/describe.test.ts`.

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
These are the names as of 2026-09-24; [Rename 001](plans/rename/001-overstory-names.md)
renames the `Arbor*` and `Canopy*` names that remained.

Verified on Linux with Bun 1.3.14: `bun run typecheck`, `bun run build`, the
canopyd-merge suites (335 passes), `bun run build:cli:package`,
`bun run test:cli:package` (12 passes), `bun run check:links` and
`git diff --check` pass. `bun run test` has 1,332 passes and 14 failures, all
in the known environment set (libsecret, sidecar restart, workspace
discovery, client-generated profile bootstrap, journal compaction, a
node-query race that passes alone). Not verified: every Swift rename is
uncompiled, and `swift/Canopy.xcodeproj` was hand-edited for the renamed app
files and must be regenerated with xcodegen on a Mac; the gates are in
[small work](plans/small-work.md#overstory-identifier-rename-mac-gates).

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
`HostAccountService` (`swift/StoryApp/HostAccountService.swift`), chosen
once per platform by `StoryWorkspaceState.accountService`:
`KeychainAccountService` on iOS (over `NativeAccountService`,
`KeychainDeviceCredentialStore` and `KeychainProfileIdentityStore`) and
`StorySyncAccountService` on macOS (`swift/StoryApp/StorySync/`, over the
daemon's REST client and `StorySyncCredentialProvider`; it uses the connected
daemon and never launches one). The surface is `state()` (accounts, identity,
pending claim and pairing), `accounts()`, `credentialProvider(configurationTree:)`
(and `client(for:)` on top), `createIdentity`, `restoreIdentity`,
`backupIdentity`, `claimAccount`, `cancelPendingClaim`, `claimPairing`,
`resumePairing` and `forget`. What only one store can do is declared in
`capabilities` and otherwise throws `HostAccountServiceError.unsupported`:
the iPhone cannot restore or back up an identity file, cancel a claim or
resume a pairing without its payload; the Mac cannot forget an account (the
daemon has no such route).

The account-operation forks in `StoryAppModel.swift` collapsed: directory
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
`swift/Story.xcodeproj` was hand-edited for the two new files and must be
regenerated with xcodegen on a Mac. The plan is deleted; its Mac gates are in
[small work](plans/small-work.md#native-011-mac-gates).

## Native 011 daemon-client folds — 2026-09-24

Implemented, not installed. Both daemon clients now live with their only
caller: the TypeScript `StorySyncRESTClient` is `packages/cli/src/daemon-client.ts`
(the `@ovst/story-sync-client` package, its workspace entry and root
dependency are deleted; `tests/unit/protocol.test.ts`,
`tests/integration/{server,self-sync,cli-sync}.test.ts` import the CLI module
and `swift/scripts/hosted-smoke.ts` posts its claim directly), and the Swift
client is Mac app code in `swift/StoryApp/StorySync/` behind `#if os(macOS)`
(the `StorySyncClient` package is deleted and dropped from `project.yml` and
`StoryEditor/Package.swift`; its tests are in `StoryAppTests`, the provider
contract in `OverstoryWorkingTreeTests`, and the protocol gate runs the moved
suites through `xcodebuild`). The daemon no longer serves
`POST /v1/bootstrap/pairings` or `POST /v1/local/forget`; the Mac creates
pairing offers on the host with the account credential, as iOS does. The
Mac's data-home identity, claim and pairing-claim routes, `GET /v1/accounts`,
`GET /v1/credential`, `POST /v1/placements/move` and `POST /v1/held/discard`
are kept after the source audit: there was no Swift writer for the data
home's identity store, the CLI has no claim command, `story status` may target
a cloud-session daemon, and `story mv` needs the daemon to pause and relocate a
watched root. The daemon and iOS keep credentials in different stores, so the
[account service](#native-011-account-service--2026-09-25) records the
ownership decision that followed.

Verified on Linux with Bun 1.3.14 on top of `5145569`: `bun run typecheck`
passes. `bun run test` has 1,163 passes and 19 failures against 1,168 and 14
at `5145569` in the same environment (libsecret, iCloud, sidecar timing). The
five extra failures are in files this change does not touch (overstoryd-merge
tool, child provider, protocol objects, tree-merge, Wire client transfer)
and those files pass 89/89 run alone. With `STORY_CREDENTIAL_STORE=file`
the server, self-sync, cli-sync, cli-mv, cli-rehome, local-handlers,
protocol and community-hosting suites pass 74/74 both before and after.
`bun run build`, `bun run build:cli:package`, `bun run test:cli:package`
(12 passes), `bun run check:links` and `git diff --check` pass.
`bun run test:protocol` (file credential store) passes its TypeScript suites
and live daemon setup and stops at the first Swift step: this machine has no
Swift toolchain or `xcodebuild`.

Not verified: every Swift edit is uncompiled. `swift/Story.xcodeproj` was
edited by hand to match `project.yml` and must be regenerated with xcodegen on
a Mac; `StoryEditor/Package.resolved` was left unchanged. The remaining Mac
gates are in [small work](plans/small-work.md#native-011-mac-gates).

## Declarative collection schemas — 2026-09-24

Apps 007 is implemented and tested, not deployed or installed. A collection's `schema.cddl` is parsed and
checked under the profile in [child backings §2.4](docs/overstory-spec/06-child-backings.md#24-collection-schema-profile)
by `@ovst/collection-schema`, which executes no code and has no
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
  manifests, the lockfile and the bundled module closures of overstoryd, the merge
  worker, `tree-merge`, Story Sync and `story`, and runs acceptance decoding,
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

## Story Sync downloads iCloud placeholders — 2026-09-24

Implemented on branch `claude/arborsync-icloud-dataless`, not merged or
installed. Joe's placed folder in iCloud Drive (Optimize Mac Storage) went to
`sync: error` because the launchd daemon's reads of evicted, dataless files and
directories failed with `EDEADLK`: a launchd agent starts with the kernel's
dataless-materialization policy off. The daemon now turns that policy on for
its own process at startup, so reads download placeholders instead of failing,
and a residual `EDEADLK` is logged as `cloud-placeholder` rather than
`io-error` ([cloud placeholders](docs/architecture/story-sync/data-home.md#cloud-placeholders)).
Verified by unit tests, including a real macOS subprocess that starts with the
policy off; no evicted file was read, because the test may not touch iCloud
Drive. The Story app's working trees live in Application Support, outside
iCloud, and are not exposed.

## Clients 001 phase 4: TypeScript runner and daemon — 2026-09-24

On `main` and running on Joe's Mac since 2026-09-24. The installed daemon's
three trees were clean; the new daemon retired their `sync/<tree>.json` files
and came back idle on the same accepted updates. A live round-trip on the
Console tree (arb.nxhx.org) published a new file in 1.3 s and its removal in
1.2 s through the watcher alone, leaving no retained request. The longer soak
is on Joe's own list. Clients 001 closed the same day; its plan is deleted (git
history). Its follow-ups: held folders in the Mac app
([small work](plans/small-work.md#show-declined-folders-in-the-mac-app)), the browser client
([Web 025](plans/story-web/025-story-web.md)), a Hetzner sync lab run
([small work](plans/small-work.md)), and History on
working trees ([open questions](plans/ideas.md#open-questions)).
**Runner.** `@ovst/working-tree`
holds `reduceUpdate`, `LocalChange` preparation, entry transfer, the
`UpdateControl` codec (Swift's schema 4) and `UpdateCoordinator`, a port of the
Swift runner over a change log, a control store, a transport, and an accepted
tree; `./node` holds the file-backed `ChangeLog` (moved from
`@ovst/client`'s source admission queue, adopting an earlier
`source-admissions.json` in place) and `FileControlStore`.
`SourceAdmissionPublisher` and `SourceDocumentSession` are deleted. Evidence:
`tests/unit/update-runner.test.ts` executes all nine runner vectors of
`tests/fixtures/update-runner.json`; the overstoryd source-acceptance test
publishes a stale change through the runner against a real overstoryd, restarts,
continues it and follows a resolution; `tests/unit/change-log.test.ts` covers
adoption and discard.

**Daemon.** Story Sync runs one `FolderSync` per placed folder
(`packages/story-sync/src/folder-sync.ts`): the folder is the runner's accepted
tree and its only source. Watcher events schedule a scan; a changed root
appends a sparse `trace: null` change against what the folder last held;
accepted bytes are written only when nothing is pending and the folder still
holds what it last wrote or scanned; the machine polls at the old sync
interval. A refusal is held (`sync: "conflict"`) until `POST /v1/held/discard`,
which rewrites the folder to the host's state. Both runners now hold any 4xx
refusal except 408 and 429, not only a 409. Deleted: `TreeSynchronizer`, the
pending and conflict formats of `sync/<tree>.json` (a clean one is retired, one
with work is refused), the conflict workspace, `/v1/conflicts*`,
`reviewableConflict`, and the Swift `StorySyncClient` conflict API. Evidence:
`tests/integration/self-sync.test.ts` (8 scenarios, including a held refusal
across restart and its discard, and a transmitted chain a same-credential peer
extends, replayed by digest without a merge); the server, CLI, placement-move
and community-hosting integration suites; `bun run test` (1182 passing);
`OverstoryWorkingTree` 105 and `StorySyncClient` tests; the hosted smoke (50,
including the signed app editing a placed tree through its bundled daemon).
Not run: a soak with Joe's live placements, and the Hetzner sync lab, whose
binary scenario now expects an accepted alternative instead of a daemon
conflict.

## Log entries and one merge question — 2026-09-24

Deployed 2026-09-24 at schema 19 by migration 018, from schema 18 (build `dd5313c8`),
together with the merge boundary below (overstoryd 016 steps 1 to 7 and the documentation).

- **Cutover.** Backup `.backups/railway/20260924T131328Z/` (sha256 `7468b0d3…`; 5 trees,
  22 accepted updates). Check 017 found no legacy `trees.yaml`. The live run reported
  exactly the rehearsal's heads (roots, update ids and entries), 22 entries,
  `unmappedResolutions` 0, `nextOrdinal` 4346, 147 ms. `verify.ts --sync` passed; the
  Mac's authored-file manifest was unchanged; placements resumed without re-place. A
  round-trip edit was accepted as 4346, whose entry names the migrated head's entry,
  and its deletion as 4347. The cold rebuild of the longest chain (18 entries) took
  120 ms on the rehearsal copy.
- **Conflict lab** (`swift/scripts/conflict-lab.ts`, local overstoryd on this build): every
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
  rebuild outlasts overstoryd's 30-second timeout, which ended the process and lost the
  progress: every snapshot and concurrent merge on that tree would then fail. One question
  now replays for at most `OVERSTORYD_MERGE_REPLAY_MS` (10 s), answers retryably and keeps its
  progress (`replay-budget.test.ts`). overstoryd's timeout is now 45 s, above the replay
  and 20-second evaluation budgets together, so the entry that overruns the replay
  deadline (checked between entries) still ends in that answer. Starting replay at every 64th entry instead was tried
  and rejected: the stale-edit acceptance test showed an imported start drops the current
  side's attribution for any merge whose base precedes it. The replay cost itself, a
  per-file cache, is a [candidate](plans/ideas.md#speed).
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
  overstoryd into the sidecar. A batch suffix names its base entry and the earlier
  candidates as `prefix`.
- **Fast-forward.** `checkPlainTrace` in `@ovst/protocol` (the former test-support
  `validateSourceTrace` family moved beside it) accepts `editSource` and `addEntry`
  frames overstoryd reproduces exactly and no open decision concerns; misses are logged
  with their reason. overstoryd's own acceptances write entries without the sidecar when
  no decision is open.
- **The sidecar** keeps engine states per entry and their objects in memory only
  (`OVERSTORYD_MERGE_CACHE_MB`), rebuilt by replaying entries from each chain's start and
  aligning to them, and reuses the last 32 solved questions. The engine and its state
  format are unchanged; the plan's per-file cache (step 6's last part) is not done.
- **Reference sidecar.** `tests/support/reference-sidecar.ts`, 114 lines, no cache,
  three-way file merge with a whole-file choice, passes overstoryd's rule-agnostic
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
- **Editor.** `EditorSource` (StoryKit) appends each generation and
  acknowledges on durability; `StoryDocumentBinding` keeps capture, keystroke
  guards, self-acknowledgement and anchored re-reads. `EditorRecoveryStore`,
  `DocumentAdmissionMachine`, conflict analysis, the Review Edit Conflict UI
  and the compare-and-swap admission policy are deleted.
- **Verification.** `bun run test:protocol` passed (including live host
  change-log, review and editor suites); OverstoryWorkingTree 105 tests including
  runner vectors; StoryEditor 58 through `test-story-editor-local.sh`;
  StoryKit 25; StoryAppTests 50; the Mac app builds from
  `Story.local.xcworkspace`. After merging `main`, the protocol gate and
  `swift/scripts/hosted-smoke.ts` (50 tests, run with a separate bundle id
  because Joe's app was open) passed.

## Merge boundary — 2026-09-24

Implemented on `claude/merge-tool-canopyd-api-dcic82` on top of the one merge-state
model; deployed 2026-09-24 with migration 018 (build `dd5313c8`). overstoryd no longer imports `@ovst/overstoryd-merge`: the two
share `@ovst/object-store` and the new `@ovst/merge-protocol` (request and
response schemas, decision reports, rule summaries, error codes). overstoryd dropped its
copy of the sidecar's state validator (proofs, history caches, typed retention and
the startup warm-up that primed them) and builds each merge state from the
sidecar's decision reports instead of reading its state; the integrity audit asks
the sidecar to walk its retained closure. The sidecar's now-unused validation code
is deleted. Account configuration is merged in overstoryd beside its authorization, and
`trees.yaml` accepts only the resource-rule grammar in TypeScript and Swift, so
cross-account `story mv` now refuses until a policy transfer is reviewed. A host
fast-forward that skipped the sidecar was reverted when this work was ported onto
the one merge-state model; it is to be redesigned.

Evidence: `bun run typecheck` is clean; `STORY_CREDENTIAL_STORE=file bun run test`
passes all but 4, which also fail on `main` in this container (missing
`react/jsx-dev-runtime` twice, one surrogate byte-offset case, one
unreadable-directory case as root); the merge suites pass all but the same
byte-offset case. The Swift half of `bun run test:protocol`, `swift test` and the
`Story` build were not run (no Swift toolchain in the Linux container), so the
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
Migration 016 (deleted; its runbook is `packages/overstoryd/migrations/016-squash-history/README.md` at `d15ddce`) kept each tree's
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
[schema history](packages/overstoryd/migrations/README.md#schema-history); the migration
directory is deleted and lives in git history.

## 2026-09-21 onboarding and package verification

Bun 1.3.14: typecheck, build, protocol, performance (50,000 files), and the
244-test merge suite passed. The focused identity/challenge suite passed all
20 tests, including corrupt metadata, unavailable/mismatched keys, recovery,
community-only lookup, ambiguous reservations, and a lost successful claim
response resumed by a fresh client. Shared challenge fixtures are consumed by
both TypeScript and Swift. Swift StorySyncClient, Overstory, and OverstoryClient
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
accounts; Story Sync persists the pairing before contact and verifies the returned
profile/device before installing the account. The UI exposes pending pairing
resume and no longer silently ignores edits to an address behind a pending claim.

Verification on macOS arm64 with Bun 1.3.14: 26 focused identity/community tests
passed, including separate-process creation, denied Keychain writes, lost claim
and pairing responses, and damaged metadata recovery. A separate process-death
lock regression and the protocol dependency-boundary test also passed. Typecheck,
build, StorySyncClient tests, the protocol gate (on rerun), and Mac/iOS Simulator
builds passed. The protocol gate's first run hit an intermittent StoryKit rename
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
has not been manually verified. The broader StoryKit suite encountered the
existing `renameByPageID` failure (the historical Welcome fixture was selected),
also reproduced from an untouched HEAD export. Link and whitespace checks passed.


### Shared source publication performance — 2026-09-21

Implemented locally, not installed or deployed: TypeScript and Swift update
machines select contiguous pending admission chains for one frozen request.
Uncertain requests survive restart unchanged. Both queues compose plain source
generations before building intermediate trees; separate durable change IDs
remain intact. Accepted prefix transport payloads are omitted, overstoryd skips
receipt-proven delta reconstruction, and the merger avoids duplicate matching
state validation and an unnecessary full authored-state copy. See
[publication batching](docs/implementing-editors/editor-source.md#7-publication-batching-and-preparation-costs)
for boundaries and local benchmark results.

Verification with Bun 1.3.14: focused publication/host/queue suites passed
(48 tests, then 23 queue tests after adding a 60-generation regression);
OverstoryWorkingTree passed 98 tests; StorySyncClient passed 16. Typecheck, CLI
build, and the 50,000-file performance gate passed. The full product suite had
1,131 passes, the existing CLI placement failure, and a merge-history timeout.
The focused merger rerun passed; the CLI failure also reproduced in an untouched
baseline checkout. The standard protocol gate stopped at the existing AppKit
`renameByPageID` fixture failure, also previously reproduced on untouched HEAD.

The remaining live protocol gate passed with only that known rename test
excluded: StorySyncClient 16, StoryKit 22, Overstory 44, OverstoryClient 20,
OverstoryWorkingTree 98, and live editor admission 5 tests. The structural lost-ack
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
passed with only that test excluded (16 StorySyncClient, 22 StoryKit,
44 Overstory, 20 OverstoryClient, 98 OverstoryWorkingTree, and 5 live-editor tests).
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
StorySyncClient tests, and the live protocol gate with only the previously
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

Retired overstoryd 010 after checking implementation, tests and the September 19
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
Production behavior is accepted; storage packing/accounting remains overstoryd 001.
Undo is an ordinary edit; the retired causal-undo journal had reached 432 records,
75 MB and 7.2 seconds per admission. Retained history remains unbounded.

Gap closed 2026-09-22 (`f83194c8`): `checkpointIntent` never enabled the lazy
path, so a snapshot candidate (a page created beside a traced edit) loaded the
whole history DAG, 12.7k reads on `/~joe/todos`, and hit the 5 s budget on every
retry; the worker's error was then hidden behind a response-schema complaint
returned as a 400. Checkpoints now detect an editable state as `run()` does, and
worker failures surface as `merge-failed`. Follow-ups were overstoryd 011 (traced
page creation) and 012 (effect-record size), both closed out below.

### overstoryd 011, 012 and 013 closeout — 2026-09-22

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
- **013 entry metadata.** `entry_metadata` and `document_versions` (overstoryd
  007's storage half; its routes, access rule, restore and UI remain in
  [overstoryd 007](plans/history/007-document-history-routes-and-restore.md)) are written
  inside every accepted transaction and were backfilled by migration 014: 2,515
  updates, 113 entries, 2,569 versions over 90 documents, all roots unchanged.
  Every client reads `/entry-metadata` directly; the Story Sync bootstrap no
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
that test excluded (16 StorySyncClient, 22 StoryKit, 44 Overstory,
20 OverstoryClient, 98 OverstoryWorkingTree, and five live editor tests).
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
23 StoryKit tests and the live editor cases. Standalone StoryKit tests
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

Production follow-up after Joe pushes and uses Story for one or two days should
compare warm single-update timings, separately from cold starts and batches:
`worker-validate-state`, `worker-retention`, total host time, proof hits/rejections,
and the two retention counters. Compare similar edit/conflict workloads. No live
data, installed app, or deployment was changed by this implementation.

Verification on Bun 1.3.14: all 1,155 product tests, the complete protocol gate,
270 focused merger/retention tests, 16 standalone StorySyncClient tests,
typecheck, build, links, and whitespace checks passed. The 50,000-file gate
passed (217 ms startup, 17.06 s cold walk, 2.81 s warm, 2.61 s incremental).
The disposable five-tree schema-15 copy passed a full integrity audit with its
account, device, access, boundary, reservation, policy, and tree rows unchanged.


## Shared merge cache and iPhone replay recovery — 2026-10-09

Implemented Performance 002 locally. The sidecar stores shared state records in
approximately 1 MiB gzip-compressed SQLite packs, restores buckets and frozen
values directly, and stores cache-only objects as deduplicated binary bytes.
Publication, snapshot reads and collection have transactional boundaries;
missing/corrupt shared dependencies invalidate the private graph and fall back
to replay. Legacy expanded checkpoints remain readable until replaced. The
accepted object store, log entries, request identities and merge semantics are
unchanged. [Architecture and benchmark command](docs/architecture/overstoryd/merge-cache.md).

The iPhone diagnosis found its original queued `todos` request repeatedly getting
503s during an old-basis rebuild. The deployed logs cycled back to approximately
4,200 entries after partial progress. The repair checkpoints interrupted replay,
including below 32 entries, and retains a computed head alongside two replay
frontiers when an older concurrent basis is rebuilding. Regression tests force
one-entry replay budgets and process replacement on every retry, including an
older concurrent basis and open choices.

Measured with Bun 1.4.2 on read-only copies of the October 9 production cache:

| Representation | Combined bytes | MiB |
| --- | ---: | ---: |
| Two original expanded snapshots | 741,940,290 | 707.6 |
| Individually gzip-compressed original snapshots | 108,217,498 | 103.2 |
| Shared SQLite cache, including indexes and private objects | 63,639,552 | 60.7 |

Legacy parse/decode took 7.52 and 6.81 seconds. The first shared save took 2.01
seconds and the overlapping second save 0.53 seconds. Fresh-process native
restores took 1.66 and 1.55 seconds, with peak RSS about 699 and 680 MiB. These
are local measurements, not a production memory or latency guarantee. The
benchmark verified exact serialized state shape and ordering for both originals.
Raw output is local at `/tmp/canopy-iphone-diagnosis-20261009/benchmark-final.json`.

The exact queued iPhone candidate, original change identity, authored basis
(update 8542), and copied accepted head (update 8669) were passed to the sidecar
against a read-only copy of the accepted object store. A resumed rebuild
advanced through its remaining 1,693 entries over four retryable responses and
then answered in 0.73 seconds, retaining one conflict choice. Checkpoint save
and collection between those attempts took about 2.1–3.3 seconds. A new process
restored both head and frontier and answered the same question in 6.93 seconds
with 14 entries replayed. A further cold run took 5.99 seconds; repeating the
same question warm took 0.37 seconds and returned an identical answer. This
proves local sidecar completion, not live host acceptance or phone convergence. Raw local results are
`/tmp/canopy-iphone-diagnosis-20261009/replay-result-resumed.jsonl` and
`replay-cold-final.jsonl` in that directory.

No deployment, installed app or live data was changed. Joe will push the candidate;
[Performance 002](plans/performance/002-shared-merge-cache.md) now contains only
remaining deployment and physical-phone verification.

Validation on Bun 1.4.2: `bun run test:affected` over the changed implementation,
benchmark, tests and documentation passed typecheck, 733 tests across 59 affected
files, links (137 Markdown files), and whitespace. No HTTP route or wire shape
changed, so this private-cache implementation did not require a protocol change.


## Historical catch-up improvements — 2026-10-09

Implemented the first measured improvements from Performance 003 locally:

- Loaded history maps use persistent buckets plus local writes. Loading, cloning,
  append-only comparison and recording an exact-basis edit no longer enumerate
  unrelated history. Mutable nodes/decisions remain detached; the full evaluator
  can still enumerate history when required. Retained identities and checkpoint
  formats are unchanged.
- After recovering an older requested basis, a successful question saves it with
  its head. Ordinary successful retention stays at two checkpoints per tree;
  interrupted recovery still protects the head beside two frontiers. Already-warm
  bases do not cause a save for each question. This is a narrow requested-basis
  policy, not geometric coverage or a storage-byte budget.

Local Bun 1.4.2 measurements against the pre-change `c0a68ebf` implementation:

| Workload | Before | After |
| --- | ---: | ---: |
| Fixed edit, 10,000 unrelated history records per map, median | 15.98 ms | 0.17 ms |
| Synthetic 4,201-entry history, empty cache, answer plus saves | 19.57 s / 2 attempts | 0.96 s / 1 attempt |
| Same synthetic question after fresh-process restart | 4.09 s / 2,101 replayed | 0.45 s / 0 replayed |
| Copied original iPhone question, cached head but missing historical basis, immediate retries plus saves | 74.88 s / 7 attempts | 45.43 s / 4 attempts |
| Copied iPhone question after saving its basis, fresh process | — | 3.73 s / 0 replayed |

The fixed-edit benchmark's after run used 20 measured repetitions; its earlier
baseline used 10. At both 1,000 and 10,000 unrelated records, deterministic
counters report zero historical records enumerated, one compared and four
recorded. The synthetic fixture simulates host fast-forward acceptances without
warming the worker; it is much simpler than the incident. Peak RSS in its empty
and restart processes changed from about 592/721 MiB to 406/391 MiB (macOS
`maxRSS` reports KiB). Timing samples are local and filesystem-warm, without
host CPU/memory isolation or actual client retry waits; these are not p95 or
production guarantees.

The copied iPhone benchmark uses the original retained candidate/change and
read-only accepted-object copy. The baseline and improved implementations return
the same full answer digest (`sha256:464c1a88a6613efc8031a5f2ffb7bdcbd5993879acebd7345391e79baba412b8`),
including objects, decisions and evidence. The original accepted root and one
conflict choice are retained. Restart restored two checkpoints and needed zero
replay. Its first recovery still misses the 30-second/10x target; native restore,
full-evaluator work and post-response maintenance remain material. No live data,
installed application or public host was changed by this work.

Repeatable commands and representation details are in
[merge checkpoints](docs/architecture/overstoryd/merge-cache.md). Private copied-data
results are under `/tmp/canopy-iphone-diagnosis-20261009/` in
`history-baseline-replay.jsonl`, `history-lazy-final-replay.jsonl`,
`history-lazy-restart.jsonl`, and `verify-{baseline,optimized}.jsonl`.
Synthetic outputs are `/tmp/catch-up-4200{,-baseline}.jsonl`.

Validation: affected checks passed with 736 tests across 59 files, TypeScript
checking and whitespace checks; subsequent focused checks cover the added warm
basis write regression and broader unrelated-history counters. The plan remains
open for host-class profiling, general historical coverage, cheaper divergent
replay and bounded maintenance/queue latency.

## Checkpoint store v2 — 2026-10-09

The shared checkpoint store moved to `records-v2.sqlite`. These changes come from
a parallel Performance 002 prototype; its store was dropped in favor of this one.

- **Packs:** raw records in zstd packs indexed by binary hash in a `WITHOUT ROWID`
  table, instead of gzip JSON packs with a text-keyed rowid table plus its unique
  index.
- **Objects:** cache-only objects go into the same packs instead of one gzip per
  object.
- **Restore:** one index query per restore, and frozen values are built directly
  from their decoded members.
- **Collection:** it runs once garbage doubles, not on every checkpoint removal.

A deployed `records-v1.sqlite` is read until each of its checkpoints is saved again in v2 or removed, then deleted. Semantics,
identities and the sidecar's retention policy are unchanged.

Measured with `packages/overstoryd-merge/scripts/benchmark-cache.ts` on two saves
(54.5 and 57.2 MB of JSON). The saves were made by `tests/performance/storage/`
from this repository's history with traced Markdown edits (1,500 entries). Timings
are single local runs in a shared container:

| | v1 | v2 |
| --- | ---: | ---: |
| Database | 64.9 MB | 38.0 MB |
| First / incremental save | 7.6 / 2.6 s | 6.5 / 3.1 s |
| Fresh-process restore | 7.4–7.6 s | 5.4–6.0 s |

In v1 the index (28.6 MB) and per-object gzip (18.4 MB) outweighed the packs.
A variant that wrote frozen values under 256 bytes inside their parent took
27.0 MB here, but in Joe's rehearsal on a copy of the live cache (2026-10-09,
two checkpoints of three states and about 19,500 objects each) its fresh-process
restores took 3.6–3.9 s against 2.0–2.5 s for the same checkpoints read from v1:
a small value shared by many records was rebuilt in each. That rehearsal also left the v1 file behind after both checkpoints moved.

Joe re-ran the rehearsal at `57804b80`, where every frozen value is its own record
again and a checkpoint saved in v2 drops its v1 copy. The input was a fresh
read-only copy of the live cache (byte-identical to the first) on an Apple M4.

| Checkpoint | v1 read | v2 read (two fresh processes) |
| --- | ---: | ---: |
| `80fd4101` | 2,248 ms | 961 / 972 ms |
| `ef7760e9` | 2,722 ms | 886 / 883 ms |

- **Correctness:** both checkpoints round-tripped exactly (states, shape, key
  order and objects).
- **Conversion:** writing them to v2 took 911 and 189 ms.
- **Resources:** a fresh-process restore took about 1.9 s in total with about
  0.95 GB peak memory.
- **Disk:** `records-v2.sqlite` is 34.7 MB. `records-v1.sqlite` and its WAL were
  removed, and the cache directory went from 93 MB to 34 MB.

Gate on `e9778cd4`:

- **Passed:** typecheck, the product suite (1,738), build, performance, links and
  whitespace.
- **Failed:** `test:protocol`, in four `LiveChangeLogTests` (`OverstoryWorkingTree`).
  They fail identically on main at `0b19ced5`.
tests pass.
