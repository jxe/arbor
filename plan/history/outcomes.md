# Implemented outcomes
*Delivered Arbor milestones. The forward roadmap lives in [`roadmap.md`](../roadmap.md); native application history lives in [`native/`](native/README.md).*

This file records implemented outcomes, source ownership, intentional limits, and verification evidence. Completed work belongs here rather than remaining as future imperatives in the active plan.

## Supplies transactional mutation runner

**Status: Live data documents Phase 3 implemented and verified on 2026-08-27.**

The SQLite mutation broker resolves a reviewed handle and version, validates and transforms its Standard Schema input before data access, then invokes the handler inside one serialized runner-owned transaction. The injected context carries only the trusted `ArborUser | null`, one logical timestamp, a deterministic generated-ID namespace, and reviewed transaction capabilities. Point reads require a proved unique key; relation writes validate fields, nullability, types, defaults, and primary-key constraints. Authorization reads and all resulting writes therefore share the same transaction and roll back together.

Ordered relation append, replacement, and removal validate their partition and stable key, serialize concurrent writers with `BEGIN IMMEDIATE`, never infer a position from row count, and normalize the final order. Connection-local observation triggers record the intermediate SQL, but the broker coalesces each primary key to its final before/after state and publishes only after commit. The durable store cursor is allocated atomically in SQLite across broker instances, and reserved `__arbor_*` runtime tables remain outside authored schema fingerprints and relation capabilities.

Every committed call stores its data, subject-scoped retry receipt, canonical request digest, original result, logical time, and `observedThrough` cursor in the same SQLite transaction. Exact ambiguous retries return the original receipt with one effect; reuse of the caller mutation ID for different intent conflicts. Expected `publicError` values remain sanitized, unexpected failures expose only a generic public error while retaining a private diagnostic, and failed multi-row work leaves neither data nor a receipt.

The accepted-update and mutation paths now share `semanticRequestDigest` and the durable committed-intent vocabulary without merging their transaction domains or representing SQLite rows as file patches. Tree watches and stateless query-result streams share one validated SSE frame encoder; watches retain `id`, retained history, `Last-Event-ID`, and resync semantics, while query streams omit replay identity and reestablish current derived state with `ready`. The Wire specification records both reconciliations and leaves the actual React Action/named-call transport binding to the compiled manifest phases.

Primary ownership:

- [`packages/data/src/mutation.ts`](../../packages/data/src/mutation.ts)
- [`packages/data/src/observer.ts`](../../packages/data/src/observer.ts)
- [`packages/core/src/protocol.ts`](../../packages/core/src/protocol.ts)
- [`packages/core/src/sse.ts`](../../packages/core/src/sse.ts)
- [`packages/wire/src/updates/intent.ts`](../../packages/wire/src/updates/intent.ts)
- [`spec/04-wire.md`](../../spec/01-data-model.md)
- [`tests/integration/supplies-mutations.test.ts`](../../tests/integration/supplies-mutations.test.ts)

Intentional limits:

- the runtime registry is transport-neutral until Phase 4 compiler manifests and Phase 5 React/host adapters bind it;
- mutation receipts and Canopy accepted-update receipts use separate atomic stores even though their semantic identity model is shared;
- SQLite remains the only data driver required for the Supplies milestone;
- external effects and cross-store transactions remain outside deterministic collection mutations.

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun run build           passed
bun run test            260 passed, 0 failed
focused protocol/data   31 passed, 0 failed, 8 retained query snapshots
git diff --check        passed
```

## Supplies query-result streaming

**Status: Live data documents Phase 2 implemented and verified on 2026-08-27.**

The SQLite store broker owns Arbor write transactions and observes them with connection-local TEMP triggers. An ordered transaction event contains the affected collection, primary key, exact changed fields, and before/after rows, but is published only after commit; rollback produces no event. A supported `data_version` check driven by database/WAL filesystem notifications detects another SQLite connection conservatively and invalidates the complete store without parsing undocumented WAL structures.

Each query execution now owns an isolated read-only transaction. The live broker combines normalized-plan relation, field, predicate, aggregate, order/window, and correlation sensitivity with exact result-row keys, relationship correlation tuples, schema identity, ProfileID tree/ref dependencies, and Arbor-user context. A listener is attached before the initial snapshot. Changes racing an execution are checked against both its former and newly observed dependencies, bursts coalesce into a stable rerun, identical canonical output hashes are suppressed, and only complete current replacement values are published.

The shared stateless POST contract is available at Local REST `/v1/query-stream` and Arbor Wire `/.arbor/query-stream`. Its versioned document and complete mounted query graph resolve through an injected registry rather than a Supplies-specific server path. SSE publishes `result`, `ready`, and terminal `reload` events, ignores replay headers, retains no execution ID or acknowledgement state, releases listeners on close, and treats every reconnect as a fresh snapshot-then-follow request. Canopy supplies the authenticated stable profile identity; neither host exposes raw database access or server handle implementations.

Primary ownership:

- [`packages/data/src/observer.ts`](../../packages/data/src/observer.ts)
- [`packages/data/src/live.ts`](../../packages/data/src/live.ts)
- [`packages/core/src/protocol.ts`](../../packages/core/src/protocol.ts)
- [`packages/arborsync/src/server.ts`](../../packages/arborsync/src/server.ts)
- [`packages/canopy/src/host.ts`](../../packages/canopy/src/host.ts)
- [`tests/integration/data-live-query.test.ts`](../../tests/integration/data-live-query.test.ts)
- [`tests/integration/query-stream-api.test.ts`](../../tests/integration/query-stream-api.test.ts)

Intentional limits:

- complete replacements are the only result transport; keyed diffs remain measurement-driven;
- the document compiler and activation watcher will construct registries and call `reload` in Phase 4;
- mutation primitives, authorization inside write transactions, and durable retry receipts begin in Phase 3;
- SQLite is the only live-data driver required for the Supplies milestone.

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun run build           passed
focused data/API tests  19 passed, 0 failed, 8 retained Phase 1 snapshots
isolated self-sync      4 passed, 0 failed
git diff --check        passed
```

The repository-wide runner reached 250 of 251 tests on the final serialized pass; its existing binary-conflict self-sync case intermittently returned a 500 after earlier files, while the complete self-sync file passed immediately in isolation. No Phase 2 test failed in that run.

## Supplies SQLite query engine

**Status: Live data documents Phase 1 implemented and verified on 2026-08-26.**

The new `arbor/data` package supplies `database`, symbolic callable relations, `query.many`/`one`/`maybe`, Standard Schema input validation, `mutation`, `publicError`, `RowOf`, and `ResultOf`. Query planner callbacks run once against symbolic rows, input, and Arbor-user values. Compilation rejects unknown fields, unsupported projections, unstable repeated results, and singular roots without a proved unique predicate before execution.

The SQLite driver introspects both `schema.sql` and `_store.sqlite3`, checks their complete table/index definitions, and combines them with the reviewed schema-adjacent `relationships.json` declaration and virtual `arbor_profiles` relation in one fingerprint. Module-relative `database("./data")` and `database("../data")` locations canonicalize to the same physical store while retaining the longest nested-tree boundary. Queries compile to parameterized projected SQL with deterministic stable-key tie-breakers, correlated counts, batched nested reads, and batch ProfileID resolution. Declared SQLite booleans normalize from physical `0`/`1` values at the driver boundary.

The formerly empty Supplies database is now a reproducible nonempty fixture with public/private lists, practices, authors, ordered memberships, reactions, tags, contributors, and separate ProfileID fixtures. All seven checked-in query handles run directly in a headless harness. Result and `EXPLAIN QUERY PLAN` snapshots cover nested shapes and index use; disclosure tests prove anonymous callers cannot read private lists while their owner can.

Primary ownership:

- [`packages/data`](../../packages/data)
- [`sites/supplies/data`](../../sites/supplies/data)
- [`tests/integration/supplies-queries.test.ts`](../../tests/integration/supplies-queries.test.ts)
- [`tools/seed-supplies-fixture.ts`](../../tools/seed-supplies-fixture.ts)

Intentional limits:

- query result observation and streaming were delivered in Phase 2;
- transactions, durable mutation receipts, and ordered writes begin in Phase 3;
- generated source types, source-located diagnostics, document compilation, and `arbor/react` begin in Phase 4;
- executable web/native/Canopy presentation and real-data migration remain later Supplies phases;
- Postgres execution remains need-driven and is not part of the SQLite-first milestone.

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun test                241 passed, 0 failed
bun run build           passed
focused query tests     9 passed, 8 result/query-plan snapshots
SQLite integrity/FKs    passed
git diff --check        passed
```

## Immediate editor-patch synchronization

**Status: Plan 021 implemented and verified on 2026-08-25.**

ArborQuagmire's guarded UTF-8 source edits now survive the provider boundary without entering Quagmire's public model. Arbord verifies them against the exact current source before recording durable mutation intent and retains the complete resulting source as the local authority. The offline replica returns a one-shot confirmed admission only after its journal, immutable objects, materialization, history, and control heads are durable. Neither local acknowledgement path waits for the network.

Both sync coordinators map an immediately eligible admission to canonical base/result file-object hashes, verify the result again at request creation, freeze the exact sparse attempt, and send `filePatches` instead of the complete changed Markdown object. A retained-base mismatch, earlier pending attempt, intervening generation, provider adjustment, invalid mapping, or unfavorable size automatically uses the sparse complete-object request. Overlapping immediate schedules coalesce without composing patch lineage. The authority reconstructs canonical file objects only from retained base-reachable payloads, verifies the declared result hash, and then uses the unchanged root validation, merge, and accepted-history path.

Clients now send `returnSnapshot: "if-result-differs"`: unchanged candidate acceptance needs no download, while current/merged roots and conflicts still carry the complete graph needed for safe application. Shared TypeScript/Swift fixtures and hostile authority tests cover byte bounds, overlap, overflow, base64, wrong/unreachable hashes, duplicate result objects, sparse envelopes, fallback, exact retry, and conditional snapshots. A real arbord/authority self-sync test captures the patch request and proves saving still returns while that authority is unavailable; native tests capture the equivalent iOS request and its size fallback. The large-file accounting test also exposed and fixed Swift canonical-CBOR length encoding beyond one-byte payloads.

## Native replica synchronization and Quagmire bridge

**Status: Plans 015 and 016 implemented and verified on 2026-08-24.**

`ArborSync` wraps the completed offline replica in a durable exact-request coordinator. It freezes and fsyncs one root-based update body before upload, requests the optional complete returned accepted snapshot, rehashes and validates the graph, distinguishes clean remote replacement from guarded pending-candidate integration, and advances the accepted base only after durable local application. New local roots admitted after a request remain the next candidate. Conflict responses retain local, current, and draft graphs plus structured reasons; explicit resolution uses the returned current update as its next base. Injected crashes before/after request persistence, upload, server acceptance, graph download, merged materialization, and base advancement replay the same body and semantic digest.

Native account integration scans or pastes the versioned pairing payload, independently confirms the short code, stores a distinct device credential with ThisDeviceOnly Keychain protection, lists/revokes/forgets devices, lists writable trees, and places a selected tree in app-private replica storage. Sync state is projected through ArborKit without making local admission or close depend on the authority. The disposable protocol harness proves pairing/revocation, all update outcomes, returned graph bundles, two live Swift replicas, and shared authority merge behavior; the existing arbord self-sync qualification remains the independent macOS writer gate.

`ArborQuagmire` depends on exact remote Quagmire `0.1.0` and keeps its Markdown parser, stable BlockID/source ledger, reference scope, and admission chain private to the host. Unchanged frontmatter, CRLF, raw Markdown, compatible blocks, and represented inline marks remain exact; an edited block is canonically regenerated in isolation and admitted as one range-guarded UTF-8 replacement against the authoritative revision. Sequential Quagmire commits enqueue immediately, flush awaits the tail, duplicate tabs share one PageID binding, accepted replacement remaps both BlockIDs and source records without authored undo, and failed cross-document destinations leave source exact.

The wire spec also defines `returnSnapshot` as a transport-only hint excluded from semantic request identity. Plan 021 subsequently implemented its first-alpha `file-patches-v1` representation, hostile fixtures, authority reconstruction, Swift clients, accounting proof, and ordinary complete-object fallback. Alpha clients, arbord, and authorities continue moving together rather than negotiating mixed protocol versions.

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun test                226 passed, 0 failed
bun run test:sync-merge 45 passed, 0 failed
bun run test:protocol   8 TypeScript fixture tests, 13 ArborClient tests,
                        9 ArborWire tests, and 7 ArborSync tests passed
bun run build           passed
ArborKit                7 tests passed
ArborReplica            8 tests passed
ArborQuagmire           8 tests passed
Quagmire verify         package tests plus macOS/iOS builds passed unchanged
Arbor app               macOS tests and iOS 27 build-for-testing passed
```

## Offline Swift replica

**Status: Plan 014 implemented and verified on 2026-08-24.**

`ArborReplica` is a Foundation-first, actor-serialized local durability domain behind `ReplicaWorkspaceProvider`. Its private root separates materialized state, canonical immutable objects, PageID-keyed transaction journals, linear local history, rebuildable indexes, and control heads for materialized, pending, and last-accepted roots/update cursor. It neither imports ArborWire nor performs network access. A transport-neutral, root-checked system-replacement boundary exists for Plan 015 and refuses to overwrite pending local work.

Every mutation durably records intent before writing objects, materialization, history, and root heads. Only then are indexes written and the journal compacted. Restart replay is idempotent after injected failure at the journal, object, materialization, history, or control stage. Directory reads compute complete operational Markdown without materializing it; first document admission mints durable identity, stores the exact accepted source, and guards the stored body plus immediate-child descriptors. Structural operations retain identity across rename, move, Trash, and restore; copy deliberately remints PageIDs.

The provider covers Markdown and directory documents, bodyless directories, ordinary files, nested-tree boundaries, recognized collections, integrity diagnostics, assets, search, backlinks, local history, and Recover. Private journals, history, heads, indexes, and materialized metadata never enter authored snapshots. Swift reproduces the shared canonical wire-object vectors independently and consumes the same directory-completion fixture as TypeScript. Eight package tests cover full offline behavior, repeated restarts, all five transaction fault boundaries, move/Trash recovery, root-checked replacement, index deletion/rebuild, and object-store diagnostics.

## Native Arbor shell and Swift wire client

**Status: Plans 012 and 013 implemented and verified on 2026-08-24.**

The generated `Arbor` Xcode project now establishes the independent `org.nxhx.Arbor` iOS/macOS 27 product. `ArborKit` owns UI-independent node, surface, provider, document-session, coordinator, and browser-tab contracts over a deterministic in-memory provider. Session identity is tree plus PageID with path fallback only before durable identity; duplicate tabs lease one canonical write stream while retaining independent presentation state. The foundation deliberately contains no real persistence, network transport, editor, Quagmire, or Hunch state.

`ArborWire` independently implements Arbor's canonical CBOR subset, immutable object hashing and graph validation, strict authority models, exact update-intent retry, byte-level SSE framing, and injected credentials. `ArborClient` remains the arbord REST client and forwards its source-compatible authority surface through ArborWire. Shared TypeScript fixtures now include strict invalid objects, and the TypeScript decoder applies the same hostile-input invariants.

Verification passed six ArborKit tests, two ArborApp smoke tests, sequential macOS and specified iOS 27 builds, nine ArborWire tests, thirteen ArborClient tests, sync/merge tests, and the unified protocol harness. The harness starts a disposable authority and proves Swift create/fetch/rehash/watch/update/conflict/pairing/revocation behavior plus the absence of accepted-history and historical-object access. No production authority or user data participates in these tests.

## Railway authority backup, migration, and clean-runtime cutover

**Status: Production migration and clean-runtime restart passed on 2026-08-24.**

The production authority on Railway project `strong-truth`, service `resplendent-freedom`, remained online while SQLite created a transactionally consistent `VACUUM INTO` snapshot. That database, the complete immutable-object store, and a secret-free preflight manifest were archived on the mounted volume and downloaded to `/Users/joe/src/arbor-backups/railway/20260824T120458Z/arbor-authority-20260824T120458Z.tar.gz`. The archive SHA-256 is `3fdfd1b4638d37708d573543f61070c58d05a8e8aa90c97f8175691657b21eff`.

The off-volume copy passed SQLite `quick_check`. All 101 object files, totaling 947,073 bytes, matched their hash-derived filenames; the manifest recorded four trees, two accounts, eight access entries, 49 reflog entries, and four public resources without credential material. Each tree's last reflog root already matched its current ref. A separate restored copy then started successfully from deployed Arbor commit `dc34126` under exact Bun 1.3.14, bound only to localhost while retaining the production canonical origin. Its health endpoint passed, and the HTML and untouched Markdown hashes for `/`, `/~joe`, `/~joe/drift`, and `/~mariana` matched the live preflight exactly.

Another fresh restored copy then ran the real one-way startup upgrade from exact candidate commit `ddd0edd15f6261e3cb07234e14a561b47965c4c4`, also under exact Bun 1.3.14. All 49 reflog rows became exact accepted-update rows without an extra baseline; the two account credential digests became two unrevoked `Initial device` records; and no pairing was created. All legacy database rows, current roots, access, 101 object hashes, and public output hashes remained exact. Restart added no history or device rows and retained their generated IDs. The existing locally stored Joe credential authenticated successfully against the isolated candidate with the same account/profile identity and migrated device; only its expected `last_used_at` changed. No raw secret entered output or evidence.

After explicit operator approval and with arbord still stopped, migration release `c16a878` deployed successfully to Railway. The live startup produced 49 accepted updates and two unrevoked initial devices with zero pairings. SQLite `quick_check`, exact legacy table digests, all current roots, canonical paths, access, 101 object hashes and byte count, and all four public HTML/Markdown hashes matched the final preflight. The locally retained Joe credential authenticated as the same account/profile and migrated device without exposing credential material.

The migration compatibility paths were then removed in clean runtime `875f52b`: startup no longer backfills accepted updates/devices, migrates legacy owner/slug trees, mutates accepted-update columns, or drops old replay tables. New authorities create the current schema; existing authorities must pass an explicit exact-schema and data-invariant assertion or fail without modification. That runtime deployed successfully, passed the same live checks, restarted explicitly, and passed them again. Live discovery advertises `updates-v1`, while the former per-tree `/push` route is absent.

Railway-managed snapshots were unavailable on the Hobby workspace, so the application-consistent export above remains the retained rollback artifact alongside the tested old revision. No rollback was needed.

The final private production smoke completed on tree `tr_75flw3eeibv52jjmlpamnodz3q` with exactly seven accepted updates: initial state, one-sided acceptance, two offline additive submissions including one authority merge, one canonical semantic-replay acceptance, one binary winner, and one explicit conflict resolution. The duplicate semantic request added no row. The rejected binary conflict retained local bytes across arbord restart without advancing authority history. A fresh paired device could read before revocation and received `401` afterward. Five bounded-smoke credentials were created across the stopped and completed attempts; all five are revoked, both test trees remain private, temporary Keychain credentials and local sandboxes were removed, and no secret entered evidence.

The default local arbord then reconnected the community, Joe, and drift placements. All reached `idle`, their registry refs/update IDs matched Railway, physical authored snapshots were byte-identical before and after, and no reconnect update was accepted. Joe's root changed only to record the two new private child-tree boundaries; community, drift, and all four public HTML/Markdown pairs remained exact. Final production checks passed SQLite integrity/foreign keys/latest-root invariants and all 128 immutable object hashes. Plan 011 is complete.

## Four-host accepted-update and authorization qualification

**Status: Passed and torn down on 2026-08-24.**

The disposable Hetzner gate ran exact committed Arbor revision `ddd0edd15f6261e3cb07234e14a561b47965c4c4` on `arbor-community`, `arbor-alice`, `arbor-bob`, and `arbor-carol`. Run `20260824t112449z-98dedd` passed both full pre-Railway suites. The accepted-update suite repeated smoke, serial and offline additive convergence, canonical semantic-request replay, durable client-owned conflict and explicit resolution, current-object/private-history isolation, `/push` absence, one-use pairing, and revoked-device denial. The distinct-user suite proved Alice ownership, Bob byte-exact read access with existence-hiding write denial and no rejected-object/history retention, Carol write access with byte-exact convergence back to Alice and Bob, authenticated no-access denial for the original community owner, and anonymous `404` denial.

The collected evidence contains the run state, four service/system reports, an SQLite authority backup, and the immutable-object archive. Its authorization tree was `tr_aba7pv3h2vxrexf3qvgab2ju6q`; the accepted-update trees were `tr_bpbc233d335owolxzetq7jf5ny` (additive), `tr_iqiwlnw2vwbgxsvpuecmjht34y` (conflict), and `tr_6q6aqsrd4p5t7x4udxeqwklbqy` (replay). The authority backup recorded four accounts, five devices, ten trees, and thirty accepted updates. The authorization tree had exactly two accepted updates, confirming that Bob's denied candidate created no authority history. The state and journals matched no credential/token patterns. Evidence was collected before all four exact-ID, label-verified VMs were deleted and Tailscale logout was requested.

## First four-host accepted-update qualification

**Status: Passed and torn down on 2026-08-24.**

The disposable Hetzner gate ran the exact committed Arbor revision `68e60111bd8344bc1c0dffd0951a35424465e366` on `arbor-community`, `arbor-alice`, `arbor-bob`, and `arbor-carol`. Run `20260824t101153z-e54dba` passed smoke plus serial and offline additive convergence, canonical semantic-request replay across restart, durable client-owned binary conflict without rejected authority history, explicit local resolution and three-client byte convergence, private history/historical-object isolation, `/push` absence, one-use pairing, and revoked-device denial.

The collected evidence contains the run state, four service/system reports, an SQLite authority backup, and the immutable-object archive. Its acceptance trees were `tr_cbts2k2f5ri5gz65gabuhqu2ee` (additive), `tr_vmhxwchjy3dqdjvxvjxapmgede` (conflict), and `tr_42nbmcwxe65hwu3a7sq7ne4pwu` (replay). The authority backup recorded one account, two devices, one pairing, and twenty accepted updates. Evidence was collected before all four exact-ID, label-verified VMs were deleted and Tailscale logout was requested.

## Local browser/editor baseline

**Status: Implemented.**

Delivered:

- logical filesystem nodes joining `x.md`, `x/`, and `x/_index.md`;
- symlink-safe discovery, watching, indexing, search, generated collection types, and request-time containment;
- source-preserving Markdown through ArborNote/BlockNote, including raw fallback, toggles, footnotes, and LaTeX;
- journal-before-file Markdown writes, recovery, CAS, crash-safe structural transactions, Trash, restore, imports, and assets;
- file, CSV, JSONL, and Postgres collection reads through one collection surface;
- responsive TreeHopper web navigation, editing, properties, actions, and reconciliation without editor remounts.

Primary ownership:

- [`packages/core`](../../packages/core)
- [`packages/fs`](../../packages/fs)
- [`packages/editor`](../../packages/editor)
- [`packages/stores`](../../packages/stores)
- [`packages/render`](../../packages/render)
- [`packages/arborsync/src/workspace.ts`](../../packages/arborsync/src/workspace.ts)

Important constraints:

- Markdown files remain canonical; BlockNote is the interaction layer only.
- Untouched Markdown remains byte-identical; only edited regions normalize.
- CSV/JSONL/Postgres rows are not edited through the Markdown editor.
- `.claude` remains workspace content; only known generated/build directories are excluded.

## Exact-source and complete-directory foundation

**Status: Implemented on 2026-08-18.**

Delivered:

- `MarkdownDocument.source` is authoritative on REST, TypeScript, and Swift reads; `writeMarkdown` accepts only exact `source` plus `baseContentRevision`, and `createMarkdown` accepts optional exact source;
- arbord/filesystem providers parse submitted source internally for indexing, backlinks, rendering, recovery, and validation rather than trusting client-authored block arrays;
- every physical directory returns provider-owned complete operational Markdown: the first eligible standalone link represents each immediate child and deterministic ordinary links are appended for unmatched children without read materialization;
- directory content revisions include exact stored bytes plus canonical immediate-child descriptors, so child-set changes conflict while enumeration reorder does not;
- child-link order is a content edit, while physical moves carry only sources and a destination; obsolete placement and Markdown anchor fields are rejected;
- the web editor, TypeScript client, and Foundation-only Swift client consume this contract directly; client projection types, synthetic rows, manifests, and projection fixtures were removed;
- PageID handling now accepts opaque non-empty values in both logical URL implementations.

This supersedes the client-projection architecture recorded in the historical Milestone 2 section below. That section remains as delivery history rather than current guidance.

Primary ownership:

- [`spec/02-directory-format.md`](../../spec/03-directory-format.md)
- [`docs/arborsync-api.md`](../../docs/arborsync-api.md)
- [`packages/editor/src/directory-document.ts`](../../packages/editor/src/directory-document.ts)
- [`packages/fs/src/workspace-fs.ts`](../../packages/fs/src/workspace-fs.ts)
- [`packages/arborsync`](../../packages/arborsync)
- [`packages/client`](../../packages/client)
- [`native/Packages/ArborClient`](../../native/Packages/ArborClient)
- [`packages/render`](../../packages/render)

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun test                175 passed, 0 failed
bun run test:protocol   8 TypeScript fixtures and 9 live Swift tests passed
bun run build           passed
bun run test:e2e        13 passed
swift test --package-path native/Packages/ArborClient
                        9 passed, 1 live-server test skipped as designed
git diff --check        passed
```

## Quagmire/Hunch editor foundation

**Status: Implemented locally on 2026-08-18; review follow-ups complete through
Hunch `ef37cc6`.**

This cross-repository prerequisite was implemented in `/Users/joe/src/hunch`
before Quagmire extraction so the first public package can start with the
intended neutral API rather than publishing a Hunch-specific boundary.

Delivered:

- one format-neutral `documentLink` row with an authored attributed label and
  opaque host-defined reference, replacing the Hunch-specific subpage model;
- H1–H6 representation without clamping, while creation UI remains H1–H3;
- a read-only unsupported/raw block for exact host-owned source fallback;
- a tested stable `BlockID` lifecycle across edits, structure, undo, paste,
  duplication, and cross-document operations;
- per-target present/pending/missing/unavailable presentation and capabilities,
  async mention suggestions, and observation-driven pending-to-present updates;
- safe system replacement that rebases undo for insert/remove/value changes and
  honestly falls back to wholesale replacement for reparenting or sibling
  reorder;
- synchronous commit notification, async flush, and duplicate-over-loss
  ordering for cross-document create, append, inline, retire, and Trash flows;
- a simultaneous Hunch migration preserving former subpage-row behavior through
  the neutral type.

Verification after review:

```text
Packages/Quagmire/scripts/verify.sh
                        passed package tests and macOS/iOS builds
Hunch macOS tests       349 passed
Hunch iOS simulator     test build passed
git diff --check        passed
```

The detailed completed executor plan was retired after this outcome was folded
into history and the active publication/integration preconditions. Extraction,
publication, and remote Hunch adoption remain active work in
[`native/001-publish-quagmire.md`](native/001-publish-quagmire.md).

## Canonical and community-hosting foundation

**Status: Implemented as a reference slice on 2026-08-02.**

Delivered:

- deterministic immutable wire objects, mutable CAS tree refs, immediate push/background pull, conflict preservation, and raw `TreeID` fallback;
- one mounted community namespace with complete person/group profile trees and longest-accessible-prefix resolution;
- in-place nested promotion that preserves canonical URLs, Markdown bytes, `PageID`s, and external OS folder locations;
- independently evaluated public, person, group, and link access with revocation and reserved-boundary protection;
- multi-account authority credentials, authored member reservations, atomic first-claim-wins person profiles, and authored group membership;
- browser profile, Claim, and additive Share surfaces plus `browse`, `sync`, `unsync`, `serve`, and credential-recovery CLI plumbing;
- shallow untracked browsing, sessionless remote visits, writable reopening of local placements, read-only BlockNote remote rendering, and server-rendered public Markdown without iframes.

Contract and reference documentation:

- [`spec/04-wire.md`](../../spec/01-data-model.md)
- [`spec/03-locators.md`](../../spec/04-locators.md)
- [`docs/client.md`](../../docs/client.md)
- [`docs/cli.md`](../../docs/cli.md)
- [`spec/05-configuration.md`](../../spec/05-accounts-and-devices.md)
- [`docs/arborsync-api.md`](../../docs/arborsync-api.md)

The delivered slice intentionally does not claim end-user device pairing, claim recovery/dispute resolution, multiple active local identities, nested or cross-community groups, boundary moves/aliases, or production hosting administration. Those follow-ups have their own position in the forward roadmap rather than keeping the foundation permanently partial.

Verification on 2026-08-02:

```text
bun run typecheck       passed
bun test                167 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift live tests passed
bun run build           passed
bun run test:e2e        13 passed
git diff --check        passed
```

Delivered across the community-hosting series ending at `001ea16`.

## Workspace composition (forward Milestone 1)

**Status: Implemented on 2026-08-02.**

Delivered:

- distinct shared trees can be placed at nested, locally meaningful paths and resolve by longest local prefix;
- a reader-local mount is excluded from the parent's discovery, watcher, page-ID map, search index, generated types, wire snapshot, and pull deletion, so it never changes the parent graph/ref, canonical URL, ACL, or another reader's layout;
- canonical nested boundaries remain separately authored graph entries, including virtual external-folder projections;
- mounted roots are protected by structured `reserved-boundary` conflicts, placement requires an absent/empty destination, and unsyncing leaves local files untouched;
- remote visits persist safe `system:visited` records and private credential-free node snapshots, reopen read-only during transport outages, and expose **Add to workspace**;
- Home renders nested placements, recently visited trees, and a provenance-correct merged recovery inventory; existing all-tree search now excludes locally mounted children from their parent index;
- backlinks fan out across visible trees for explicit `arbor://tree/<TreeID>/…` links and retain the referring tree on every result.

Primary ownership:

- [`packages/arborsync/src/tree-manager.ts`](../../packages/arborsync/src/tree-manager.ts)
- [`packages/arborsync/src/service.ts`](../../packages/arborsync/src/service.ts)
- [`packages/fs/src/discovery.ts`](../../packages/fs/src/discovery.ts)
- [`packages/fs/src/workspace-fs.ts`](../../packages/fs/src/workspace-fs.ts)
- [`packages/wire/src/objects.ts`](../../packages/wire/src/objects.ts)
- [`packages/stores/src/visits.ts`](../../packages/stores/src/visits.ts)
- [`packages/stores/src/indexer.ts`](../../packages/stores/src/indexer.ts)
- [`packages/render/src/App.tsx`](../../packages/render/src/App.tsx)

Intentional limits:

- one local placement per `TreeID`; several placements of the same tree remain deferred;
- no reader-local content overlay or shadowing of occupied parent content;
- no pinned historical placements or placement-specific local access ceiling;
- merged recovery remains a client-side set of per-tree operations, not a cross-tree transaction or fabricated aggregate tree;
- cross-tree backlink indexing recognizes stable raw TreeID locators; DNS canonical-link matching can be added when the index has a durable authority mapping.

Verification on 2026-08-02:

```text
bun run typecheck       passed
bun test                171 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift tests passed
bun run build           passed
bun run test:e2e        13 passed
git diff --check        passed
```

## Milestone 1 — REST v1 and both reference clients

**Status: Implemented on 2026-07-25.**

Outcome:

- REST v1 is the sole application API.
- `NodeRef` supports logical paths or durable `PageID` references.
- Content and directory revisions remain distinct.
- Mutations are durable, idempotent, restart-safe, and split by durability domain.
- State reads carry observation cursors; SSE replay and deterministic `resync-required` close fetch/subscribe gaps.
- TypeScript and Foundation-only Swift reference clients implement exact retry, multipart transfers, cursor tracking, and observed node views.

Implemented in:

- [`docs/arborsync-api.md`](../../docs/arborsync-api.md)
- [`packages/core/src/protocol.ts`](../../packages/core/src/protocol.ts)
- [`packages/arborsync`](../../packages/arborsync)
- [`packages/client`](../../packages/client)
- [`native/Packages/ArborClient`](../../native/Packages/ArborClient)
- [`conformance`](../../conformance)

Intentional limits:

- no general local authentication layer;
- no editor-session lifecycle API;
- no SDK generator, persisted replay service, mount, wire, sharing, or native app integration.

Completion evidence recorded at delivery:

```text
bun run typecheck       passed
bun test                80 passed
bun run test:protocol   TypeScript fixtures + 8 live Swift tests passed
bun run build           passed
bun run test:e2e        8 passed
bun run test:performance
                        50,000 files; 1,828 ms startup; 0.27 ms incremental; 37.06 ms search
```

Commit: `0cb565c`.

## Milestone 2 — whole-workspace daily driver

**Status: Implemented on 2026-07-27, with explicit polish deferrals.**

Outcome:

- complete directory documents were originally delivered as pure client projections over a storage-shaped node plus the fully paginated child listing (superseded by the provider-owned contract above);
- managed-row manifests preserve child identity/origin/kind/materialization without serializing synthetic rows;
- one logical URL resolver handles child, sibling, rooted, identity-bearing, and global Arbor destinations in TypeScript and Swift;
- bodyless directories remain side-effect free until authored body/order/identity requires materialization;
- logical ordinary-file routes serve bytes with revision `ETag`, HTTP range, and explicit raw document access;
- per-root backlinks return referring document identity and link context;
- per-root recovery supports paginated recursive subtree inventory across lost/purged blocks and Trash;
- TreeHopper web exposes “Linked from,” subtree recovery, minimal ordinary-file actions, and honest unavailable state;
- iCloud `.name.icloud` markers map to the logical unavailable node and are never read or indexed as content.

Implemented in:

- `packages/core/src/projection.ts` (historical; removed by the provider-owned complete-directory foundation)
- [`packages/core/src/logical-url.ts`](../../packages/core/src/logical-url.ts)
- [`packages/client/src/index.ts`](../../packages/client/src/index.ts)
- [`native/Packages/ArborClient`](../../native/Packages/ArborClient)
- [`packages/stores/src/indexer.ts`](../../packages/stores/src/indexer.ts)
- [`packages/fs/src/materialization.ts`](../../packages/fs/src/materialization.ts)
- [`packages/arborsync/src/workspace.ts`](../../packages/arborsync/src/workspace.ts)
- [`packages/arborsync/src/server.ts`](../../packages/arborsync/src/server.ts)
- [`packages/render/src/PageEditor.tsx`](../../packages/render/src/PageEditor.tsx)
- [`packages/render/src/App.tsx`](../../packages/render/src/App.tsx)

Explicitly deferred to the non-blocking polish milestone:

- rich ordinary-file metadata, previews, and host-app actions;
- provider-specific download/retry commands and broader provider classification;
- representative personal-tree measurement beyond the retained synthetic regression gate.

Explicitly deferred to sharing/workspace composition:

- aggregation of recovery/Trash inventories across multiple roots or mounts.

Verification on 2026-07-27:

```text
bun run typecheck
                        passed
bun test tests/unit/protocol.test.ts tests/unit/fs.test.ts \
  tests/integration/server.test.ts tests/integration/fs-scope.test.ts
                        55 passed, 0 failed
```

The combined protocol/build verification is recorded below after Milestone 3 because both milestones share one delivery set.

## Milestone 3 — filesystem-wide browsing and tracked roots

**Status: Implemented on 2026-07-26.**

Outcome:

- `arbor dev <path>` treats its argument as a starting location, not a workspace boundary;
- navigation walks to the OS root and into any readable local path;
- Arbor intelligence activates only inside session/tracked roots;
- path-keyed `~/.arbor/trees.yaml` entries persist tracked roots and project through `system:roots`;
- arbord is split into `ArborService`, `RootManager`, per-root `Workspace`s, and a reduced untracked `FilesystemService`;
- protocol refs, snapshots, events, effects, results, and both clients carry the tree dimension;
- local refs canonicalize into their owning root; bare `PageID` references fan out across live roots;
- TreeHopper uses OS-shaped URLs, unclamped breadcrumbs, root provenance, tracking affordances, and focus revalidation in untracked scope.

Implemented in:

- [`packages/arborsync/src/service.ts`](../../packages/arborsync/src/service.ts)
- `packages/arbord/src/roots.ts` (historical; later consolidated into the current arborsync `service.ts`)
- [`packages/arborsync/src/fs-service.ts`](../../packages/arborsync/src/fs-service.ts)
- [`packages/stores/src/trees.ts`](../../packages/stores/src/trees.ts)
- [`packages/stores/src/private-state.ts`](../../packages/stores/src/private-state.ts)
- [`packages/arborsync/src/root-title.ts`](../../packages/arborsync/src/root-title.ts)
- [`packages/core/src/protocol.ts`](../../packages/core/src/protocol.ts)
- [`packages/render/src/App.tsx`](../../packages/render/src/App.tsx)

Coverage:

- [`tests/integration/fs-scope.test.ts`](../../tests/integration/fs-scope.test.ts)
- `tests/integration/roots.test.ts` (historical; coverage later consolidated into `fs-scope.test.ts`)
- shared tree-qualified protocol fixtures decoded by TypeScript and Swift;
- filesystem-wide browser end-to-end coverage.

Verification recorded on 2026-07-26:

```text
bun run typecheck       passed
bun test                126 passed
bun run test:protocol   TypeScript and Swift conformance passed
bun run build           passed
bun run test:e2e        11 passed
bun run test:performance
                        50,000 files; 1,218 ms startup; 0.28 ms incremental; 33.5 ms search
```

Manual acceptance covered untracked launch, parent navigation to `/`, external CAS reconciliation, Keep tracking, and readable `system:roots`.

### Storage refinement — 2026-07-28

Arbor's default private state home is now `~/.arbor` on every platform. An unoverridden first launch atomically relocates the former platform data directory and leaves a compatibility symlink; explicit `ARBOR_DATA_HOME` runs remain isolated. Colliding real directories are never merged.

Tracked placements now live in the comment- and order-preserving, path-keyed `~/.arbor/trees.yaml`. Only `source: local` is operational; valid shared Arbor sources parse but remain blocked until the wire milestone. RootIDs, state-directory IDs, canonical paths, and device/inode fingerprints remain private in the upgraded `workspaces.json`, allowing unambiguous same-filesystem moves to retain identity. Root names come from the first H1 in `_index.md`, with the directory basename as fallback. Invalid live registry candidates leave the preceding active configuration in place and surface diagnostics.

## Current combined verification

Verified on 2026-07-28 after the `~/.arbor` and `trees.yaml` refinement:

```text
bun run typecheck       passed
bun test                141 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift live tests passed
bun run build           passed
bun run test:e2e        11 passed
bun run test:performance
                        50,000 files; 1,302 ms startup; 0.27 ms incremental; 32.24 ms search
swift test --package-path native/Packages/ArborClient
                        9 passed, 1 live-server test skipped as designed
git diff --check        passed
```

Joe's unoverridden local state was migrated after stopping/checking for arbord. The move retained all 108 files and the 56,040 KiB state footprint, preserved the pre-move `workspaces.json` checksum before its shape upgrade, left only the compatibility symlink in Application Support, and passed an SQLite `quick_check` plus a real `/v1/roots` open against the existing Arbor workspace state.
