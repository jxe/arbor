# Detailed plan catalog

Directories group plans by the component or product surface they change. This is an inventory,
not an execution queue; use the [outcome menu](README.md) to choose work. Priorities remain open.
Historical identifiers are recorded in each moved plan. Number gaps do not imply missing work or ordering.
Old P1/P2 labels are workstream assessments, not current global priorities.

[Release and verification](verification/release-and-soak.md) owns remaining installation, deployment,
manual acceptance and soak gates. Check current source/tests before executing any older plan.

## Native clients

`native/` — Native placement, offline data, editor command capture and accepted-choice review.

- [Native 003 — Project collection files into native offline replicas](native/003-native-offline-collection-file-projection.md) — **DEFERRED; depends on historical Data 002 and 011 and Apps 003.** Promote when offline collection-row browsing is selected as a product requirement; its plan does not currently authorize implementation.
- [Native 006 — Preview and resume initial working-tree bootstrap](native/006-progressive-replica-bootstrap.md) — **PLANNED; not near-term.** Applies to iOS placement and visits; show a verified read-only root early, resume immutable snapshot bytes, then atomically install the complete working tree.
- [Native 008 — Complete native move, copy, and undo capture](native/008-complete-native-move-copy-undo-capture.md) — **FOUNDATION IMPLEMENTED; additional command coverage.** Extend remaining move/copy/compound-undo cases; existing capture and durable publication are not pending work.
- [Native 010 — Extend accepted-choice review](native/010-client-conflict-review.md) — **REVIEW UI IMPLEMENTED; release verification outstanding.** Remaining implementation is richer previews, finer source mapping and additional fault coverage. Installation and hands-on gates live in verification/.

## Web client

`web/` — Restore the browser working-tree client, then its interface and editor features.

- [Web 005 — Close web-editor interaction and fidelity gaps](web/005-web-editor.md) — **P2 · BACKLOG; waits for Web 023.** Its items are independently selectable after the browser client returns.
- [Web 008 — Bring Arbor web to native interface parity](web/008-web-native-interface-parity.md) — **P2 · WAITING on Web 023; coordinates safe search excerpts with Security 001.** Port the native shell, search, sidebar, Share, Accounts, and Sync Status information architecture into platform-appropriate browser UI.
- [Web 023 — Rebuild the web editor on the working tree](web/023-rebuild-the-web-editor-on-the-working-tree.md) — **PLANNED; after the Native 022 soak.** Build TypeScript `@arbor/working-tree` as a twin of the Swift package (including the browser-safe object-store interface), pass the same fixture, and mount the Arbor web editor again using the retained sync object endpoint. Fold in removal of `/v1/me`, `/v1/local/forget`, `/v1/resolve`, and filesystem-path byte serving; migrate callers and retain `/v1/bootstrap/accounts` for browser account claiming.

## Local filesystem

`filesystem/` — Filesystem writes, membership and ordinary-folder editing.

- [Filesystem 002 — Serialize write-journal counters and appends per document](filesystem/002-journal-append.md) — **DEFERRED.** Recheck the inherited journal-ordering concern against current code before resuming.
- [Filesystem 005 — Keep ignored filesystem content outside Arbor trees](filesystem/005-ignore-policy.md) — **P1 · PLANNED.** Add portable `.arborignore` and `.gitignore` compatibility through one discovery/watch/index/snapshot/materialization policy; preserve accepted tracked content until explicit removal and never delete ignored local bytes during pull.
- [Filesystem 011 — Keep independent filesystem writes moving after a rejection](filesystem/011-independent-writes-after-rejection.md) — **NEEDS DESIGN.** Retain rejected work while publishing only effects proven independent.
- [Filesystem 024 — Add disk editors for non-tree folders](filesystem/024-disk-editors-for-non-tree-folders.md) — **PLANNED; depends on Web 023 for the web.** Add a simple local-file backend without synchronization machinery and refuse paths inside placed trees.

## Canopy authority, storage and history

`canopy/` — Merge policy, retained state, accepted history and provenance.

- [Canopy 001](canopy/001-pack-object-storage.md): measure storage before choosing packing or pruning.
- [Canopy 002](canopy/002-composable-conflict-fragments.md): reassess only residual fragment-representation gaps against schema 12.
- [Canopy 006 — Attribute accepted updates and show line provenance](canopy/006-line-provenance.md) — **P2 · PLANNED; depends on Canopy 007 and coordinates retained-root policy with Canopy 001.** Reuse Canopy's document-version index for Git-blame-like current-line provenance without adding a revision DAG.
- [Canopy 007 — Surface accepted document history from Canopy](canopy/007-canopy-document-history.md) — **P1 · PLANNED; execute before Canopy 006 and coordinate retained-root policy with Canopy 001.** Surface accepted document history and restore-as-new-change from Canopy while keeping Arbor Sync filesystem repair separate; replica archive removal was completed in `b610d40`.
- [Canopy 009](canopy/009-canopy-provenance-merges.md): format policies, transfer proofs and measured server costs.
- [Canopy 010 — Operations as evidence frames; history loaded lazily](canopy/010-operation-frames-and-lazy-history.md) — **P1 · PLANNED (approved 2026-09-19).** Optional root-to-root operation frames on the wire, one frame per editor generation coalesced by concatenation, and a server that loads history by touched page with a deletion watermark instead of scanning it whole; collapsing old history is deferred.

## CLI and external agents

`cli/` — Structured access for independently installed agents.

- [CLI 004 — Give external agents safe structured access](cli/004-external-agent-access.md) — **IN PROGRESS; not near-term.** General status and cloud-session discovery are implemented; structured read/mutation commands and the reusable agent skill remain.

## Executable applications

`apps/` — Resource policy → sidecar/source resolution → durable authoring/compiler → Supplies; hosted agents follow.

- [Apps 001 — Run the Supplies tree locally, natively, and on Canopy](apps/001-supplies-executable-site.md) — **P1 · IN PROGRESS; depends on Apps 003–006**, the completed SQLite runtimes, and historical Data 002. This owns the next vertical gate: the adapted [`examples/supplies`](../examples/supplies) corpus as executable documents in local Arbor web, signed macOS Arbor, and its canonical Canopy website.
- [Apps 002 — Host authored conversational interfaces over compiled Arbor handles](apps/002-canopy-hosted-agents.md) — **P1 · PLANNED; depends on Apps 001**, Arbor users, and Canopy execution. Agents reuse the same compiled query/mutation handles and authenticated Arbor-user context rather than introducing a separate data/runtime framework.
- [Apps 003 — Compile and typecheck executable documents consistently](apps/003-development-compiler-and-editor-tooling.md) — **P1 · PLANNED; depends on historical Data 002 and the Apps 001 Supplies corpus.** This owns the shared compiler and development tooling across `arbor check`, editors, local Arbor, and Canopy.
- [Apps 004 — Resource policy and coordinated configuration cutover](apps/004-mutation-permissions.md) — **P1 · PLANNED; first.** Implement `who` / `via` / `allow`, scoped updates/watches, and upgrade Joe's configuration, clients and Canopy together.
- [Apps 005 — Source resolution and HTTP sidecar](apps/005-source-resolution-and-sidecar.md) — **P1 · PLANNED; after 004.** Define the bridge, implement authorized bindings, then extract current runtime machinery without preserving unused APIs.
- [Apps 006 — Durable query/mutation authoring](apps/006-durable-authoring.md) — **P1 · PLANNED; after 004/005, with 003.** Combined author/user requirements, resumable steps, backing receipts and the three lifecycle examples.

## Postgres

`postgres/` — Provider → observation/checkpoints → read-only projection → bidirectional projection; preserve logical identity across representations.

- [Postgres 001 — Complete the provider-neutral Postgres child backing](postgres/001-child-provider.md) — **P2 · PLANNED; depends on historical Data 002 and 007 and Apps 003.**
- [Postgres 002 — Define observation and semantic synchronization](postgres/002-observation-and-semantic-sync.md) — **P1 · DESIGN REVIEW REQUIRED; depends on Postgres 001.** Define database snapshots, committed observation, logical effects, checkpoints, and semantic synchronization.
- [Postgres 003 — Build a read-only SQLite projection](postgres/003-read-only-sqlite-projection.md) — **P2 · PLANNED; depends on Postgres 001**, the snapshot/observation subset of Postgres 002, and Apps 003. Materialize a reviewed Postgres query into a rebuildable read-only SQLite placement.
- [Postgres 004 — Add bidirectional SQLite/Postgres projection](postgres/004-bidirectional-projection.md) — **P2 · DEFERRED; depends on Postgres 001–003.** Add offline mutation intent and Arbor-managed bidirectional materializations only after the one-way sequence is complete.
- [Postgres 005 — Preserve representation equivalence](postgres/005-representation-equivalence.md) — **P1 · PLANNED; depends on historical Data 002 and 011.** Preserve node identity and logical equivalence when a child set changes representation.

## Security boundaries

`security/` — Search rendering, URL decoding, host responses and access-link secrets.

- [Security 001 — Render search excerpts without treating indexed content as HTML](security/001-search-excerpts.md) — **P1 · TODO; rescoped by Native 022.** The daemon's search route and FTS index were deleted in Phase 7; the requirement applies to the native search index now and to the Plan B client text index when the web editor returns.
- [Security 002 — Decode URL paths once at the external boundary](security/002-path-decoding.md) — **P1 · TODO.**
- [Security 003 — Harden Canopy host responses](security/003-canopy-host-responses.md) — **P2 · TODO.** Apply safe response headers and trustworthy pairing-rate-limit identity.
- [Security 004 — Complete access-link sharing without leaking secrets](security/004-access-link-secrets.md) — **P1 · TODO.** Keep native link creation out of the UI until protected browser/native navigation, revocation, and recipient editing pass their staged gates.

## Testing and CI

`testing/` — Maintained automated gates and conditional test isolation.

- [Testing 001 — Run maintained gates in CI](testing/001-ci.md) — **P2 · TODO.** Cover TypeScript, browser, protocol, performance, and Swift; Testing 002 should land first if the repeated parallel lane is not stable.
- [Testing 002 — Make parallel integration tests independent](testing/002-parallel-integration-isolation.md) — **DEFERRED · LOW PRIORITY.** Revisit only if shared process-global fixture state causes recurring failures or blocks CI.

## Verification

`verification/` — Evidence and acceptance checks for implemented behavior, separate from feature work.

- [Verification 011 — Client compatibility](verification/011-client-compatibility.md): map requirements to passing tests across snapshot and operation-aware clients; report implementation gaps to their owners.
- [Release and soak](verification/release-and-soak.md): remaining installs, deployments, hands-on checks and dated ordinary-use observation.

## Compatibility cutoffs

`cleanups/` — Gated compatibility removal and simplification of locator identity surfaces.

- [Cleanup 001 — Retire the PageID-shaped stable-key bridge](cleanups/001-pageid-stable-key-cutoff.md) — **WAITING** for its read-only data audit, an explicitly closed compatibility window, and Joe to resume it.
- [Cleanup 002 — Retire v1 account and legacy local-state adapters](cleanups/002-retire-v1-account-and-local-state-adapters.md) — **WAITING** until Migration 003's rollback window ends, every supported Canopy and client is proven current, Joe removes the retained backups, and the v1 compatibility window is explicitly closed.
- [Cleanup 005 — Unify locator identity surfaces](cleanups/005-locator-identity-surfaces.md) — **P2 · NEEDS DESIGN; depends on Cleanup 001.** Give stable keys one spelling per surface and one segment-parameter grammar.

## Product Completion

The numbered product work is grouped by owner above. These additional outcomes need design
or a concrete implementation trigger; they are not new executor plans.

- <a id="later-portable-deployment"></a>**Deploy Arbor apps to third-party web hosts, later** — After Apps 001 proves one compiled Arbor application on local Arbor, native Arbor, and Canopy, make that same application deployable to a third-party platform such as Vercel or Cloudflare. This is not a numbered plan yet because the compiled output does not exist and no specific external host has supplied real requirements.
  - A fully static application can be emitted as ordinary immutable web files for any static host, but only when all of its documents and queries can be validated and resolved at build time.
  - An application with live queries or mutations needs an adapter for the chosen hosting platform that preserves Arbor identity, transactions, subscriptions, reconnect behavior, validation, user identity, execution authority, and resource limits.
  - Either form keeps each document's assets, initial results, live handlers, declared capabilities, and schema requirements together rather than flattening the application into unrelated pages.
  - Deployed pages advertise their Arbor source through ordinary web metadata such as `<link rel="arbor">` and `Arbor-Tree`.

- **Product gaps awaiting design** — These outcomes need interaction, ownership, recovery, and acceptance decisions before receiving numbered executor plans.
  - **Name-based sharing and profile avatars** — **NEEDS DESIGN.** Define user lookup, ambiguous-name selection, visibility and avatar ownership before writing an executor plan.
  - **First-party group creation and membership management** — **NEEDS DESIGN.** Create, place, and own a group profile coherently; add and remove structured profile members without teaching users to edit YAML; preserve Canopy reservation and account-disable semantics.
  - **Profile/device recovery, claim disputes, and administrator reset** — **NEEDS DESIGN.** Preserve the same self-certifying Profile TreeID and provide auditable proof of control rather than raw-credential transfer.
  - **Claimed-member removal/restoration and access-history recovery** — **NEEDS DESIGN.** Define confirmation, revocation, historical visibility, and restoration without a parallel group database.
  - **Persistent-host administration** — **NEEDS DESIGN.** Productize permanent domains, graceful restart, replacement-host restore, and verification while keeping migration scripts procedural.

## Shared cleanup candidates

- **Shared runtime protocol decoding** — **Deduplication · WAITING.** Promote when a second trusted boundary besides Arbor Sync needs runtime decoding; then colocate browser-safe pure decoders in `@arbor/core`, without adding schema generation solely to reduce repetition.
- **Provider scalar normalization** — **Deduplication · OWNED by Postgres 001 and 002.** Freeze one language-neutral representation for blobs, 64-bit integers, booleans, nullability, and other provider scalars before implementations drift.
- **Bounded-placement conformance** — **Deduplication · OWNED by Postgres 005, Native 003 and Postgres 001.** Reuse the common placement corpus when deferred providers land; do not create another placement algorithm.
- **Other ownership boundaries.** Private SQLite property receipts and direct-write bridges are removed under [Postgres 002](postgres/002-observation-and-semantic-sync.md); temporary whole-source query evaluation under [Apps 003](apps/003-development-compiler-and-editor-tooling.md); web-editor undo/history architecture under [Web 005](web/005-web-editor.md).

## Hardening, Efficiency, Polish, etc.

These inherited candidates are unverified or conditional. Inspect current behavior and tests
before promoting one; an old audit finding is not proof of a current implementation gap.


- **Further reliability hardening**
  - **Explicit web-editor unload drain** — **WAITING on Web 023.** App-controlled navigation already awaits the admission machine's flush; browser `beforeunload`/`pagehide` has no bounded drain and no visible pending state, which Reliability 005 left as a documented limitation. Add one or surface the limitation in the UI.
  - **Commit native control text before flush** — **REVERIFY.** Confirm that Quagmire can still hold text outside `ArborDocumentBinding` at background, navigation, and close boundaries; if so, add commit-then-flush lifecycle behavior and visible checkpoint-pending state.
  - **Per-key frontmatter conflict semantics** — **REVERIFY.** Preserve independent external and local changes, detect same-key conflicts and deletions, and test them beside block three-way merge.
  - **Malformed and partial legacy-state recovery** — **OWNED by Cleanups 001 and 002.** Reject unsupported or ambiguous retained state without overwriting it, and retain focused failure-path tests through each cutoff.
  - **Provider-specific materialization controls** — **NEEDS DESIGN.** Add a control only when one concrete backing can report a reliable snapshot, progress, cancellation, and failure boundary; keep provider semantics in the owning Postgres or backing plan.
  - **Web-editor boundary.** Structural undo, exact reorder restoration, pointer lifecycle, keyboard access, context-menu focus, bounded history, and scroll restoration stay together in [Web 005](web/005-web-editor.md).
- **Security** — Alpha-stage injection, authorization, secret-handling, hostile-input, sandboxing, and trust-boundary work.
  - **Isolate Canopy application-code execution** — **WAITING until Canopy executes synchronized `schema.ts`, SSR, query, or mutation code.** Use one separately contained, quota-bound, version-pinned execution boundary shared with Apps 003 rather than a schema-only retrofit.
  - **Validate directory-entry names on every Wire client read path** — **REVERIFY.** Reject empty, dot, parent, and separator-bearing names before materialization; reuse the server graph invariant and add hostile-object fixtures.
  - **Replace prose-derived authorization status** — **REVERIFY.** Canopy/Wire responses should classify authorization failures with typed errors rather than English-text matching; coordinate with Security 003 if both touch the response helper.
  - **Object reachability authorization** — owned by the Canopy object-reachability candidate under Speed below. Its access and invalidation tests must prove that the optimization cannot widen access.
  - **Upgrade reachable YAML parsing advisory** — **REVERIFY.** Move the direct `yaml` dependency to a release containing the nested-collection stack-overflow fix, then run frontmatter and `_store.postgres` parsing tests.
  - **Safe ordinary-file metadata and previews** — **NEEDS DESIGN.** Define bounded size/type detection and inert preview rules before exposing richer untracked-file metadata; never parse binary or placeholder bytes as authored text.
- **Testing and evidence**
  - **Developer browser smoke harness** — **WAITING on Web 023.** Preserve DOM, state, and network probes for deterministic invariants; reserve hands-on checks for hover, focus, pointer drag, and feel.
  - **Canopy authorization characterization** — **REVERIFY.** Cover revoked grants, read-link write denial, non-admin access mutation, and removal of transitive group access in a dedicated daemon suite.
  - **Cross-client group workflow coverage** — **WAITING.** Add browser and native creation/membership coverage after the first-party flow is designed; do not freeze manual YAML as the UX.
  - **Accessibility and responsive browser audits** — **WAITING on Web 023.** Establish repeatable keyboard, focus, semantic, contrast, and narrow/wide layout checks around the existing objective editor audit.
  - **`mergeBlocks` characterization** — **REVERIFY.** Add direct unit coverage for conservative conflict behavior before changing its alignment algorithm.
  - **Markdown/BlockNote round-trip fixtures** — **REVERIFY.** Add table-driven source-fidelity coverage for marks, raw fallback, nesting, and untouched bytes before expanding Web 005.
  - **Historical boundary.** Exact-artifact native acceptance and completed device-management browser E2E remain in [history](_done/README.md); they are not duplicated here.
- **Speed** — Measured removal of unnecessary rebuilding, unbounded scanning, and response costs.
  - **File-provider exact-source cache invalidation** — **REVERIFY.** Add filesystem-driven invalidation and metrics and deduplicate schema, store, and Markdown reads while retaining exact complete-key-set validation; do not extend the cache to database providers.
  - **Canopy object reachability index** — **NEEDS DESIGN; preserve Native 022’s implemented retained-root authorization** (retained-root reachability). Replace per-request graph scans only with an index whose update and invalidation rules cannot widen object access; coordinate the invariant with Security.
  - **Static response caching and render code splitting** — **REVERIFY.** Add ETag/cache policy for immutable built assets and measure a split that avoids eagerly loading KaTeX on routes that do not render it.
  - **Minimal changed-document reconciliation** — **CONDITIONAL.** Promote only if measured large external rewrites make whole-document `replaceBlocks` disruptive; preserve the first surviving block and cursor rather than optimizing speculatively.
  - **Representative cold/warm workspace benchmarks** — **REVERIFY.** Measure startup, discovery, indexing, navigation, and resynchronization against checked-in shape distributions before choosing another cache or index.
  - **Extension-aware lazy indexing** — **REVERIFY.** Keep deferred indexing from reading known binary, unavailable, or placeholder content; add metrics and hostile-extension fixtures before widening discovery.
  - **Ownership boundary.** Whole-table database hashing belongs to [Postgres 002](postgres/002-observation-and-semantic-sync.md), and bounded portable-query evaluation belongs to [Apps 003](apps/003-development-compiler-and-editor-tooling.md).
