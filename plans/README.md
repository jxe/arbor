# Arbor plans

Active planning starts with the outcomes to pursue soon, then keeps the remaining work grouped by why it matters. Numbers are stable identifiers within each directory, not a global execution sequence; the order and status stated here determine what should happen next.

For what works now, use [status.md](../status.md). For portable behavior, use the [specification](../spec.md). The [documentation map](../docs/README.md) explains the remaining document types.

## What to do soon

The near-term direction is intentionally broad. Refine these into smaller executable plans only after the relevant measurements and design choices are clear.

- Implement [Reliability 007](reliability/007-reify-composable-canopy-conflicts.md) so Canopy accepts composable algebraic tree states, keeps an ordinary projected root, and derives local conflict regions without blocking unrelated synchronization.
- Rearchitect Arbor Sync, starting with [Arbor Sync 001](arborsync/001-file-bytes-are-the-object.md) (a file's bytes are its object; directory entries carry the kind) and then [Arbor Sync 002](arborsync/002-object-directory.md) (the placed folder's objects as an on-disk hardlink directory, and the loopback object route deleted).
- Make sure Canopy storage is not unreasonably big.
- Support a user directory so a person sharing a tree can type someone's name instead of their Arbor URL or TreeID, and so profiles can have avatar images.

[Reliability 007](reliability/007-reify-composable-canopy-conflicts.md) now owns the staged Wire, Canopy, migration, client, and native-review work. It stores Jujutsu-style ordered expressions over exact tree roots and treats paths/regions as derived views, so it does not depend on durable Markdown anchors. [Reliability 004](reliability/004-contextual-canopy-conflict-resolution.md) remains active for hard policy/exact-match and local divergence conflicts until Reliability 007's client rollout gate passes. Arbor Sync 001 and Reliability 007 both rewrite Canopy's update internals and the Swift update coordinator: land 001 first, or rebase 007 onto the new object model, never interleave them. The user-directory/profile work still needs its next outcome defined; the list above deliberately does not prejudge that design.

## Arbor Sync

Carve the daemon into pieces with one clear owner each. The first two plans make the placed folder itself the content-addressable store; later pieces are not numbered until these have soaked.

- [Arbor Sync 001 — File bytes are the object](arborsync/001-file-bytes-are-the-object.md) — **P1 · PLANNED.** A file object's hash is the SHA-256 of its bytes; directory entries are `file`, `directory`, or `tree`; the bootstrap `files` map and Swift CBOR-prefix sniffing go; Canopy schema 7 with a gated live migration.
- [Arbor Sync 002 — The object directory](arborsync/002-object-directory.md) — **P1 · PLANNED; depends on Arbor Sync 001 and its soak.** New `@arbor/object-store` with an `ObjectDirectory` maintainer keeping `objects/<TreeID>/<hex>` equal to the placed folder through hardlinks; arborsync composes it; `GET /v1/objects` is deleted and the Mac reads the directory.

## Cleanups

Bounded deletion, simplification, and deduplication whose result is less temporary machinery or one clearer owner, rather than unrelated refactoring.

- **Compatibility removal**
  - [Cleanup 001 — Retire the PageID-shaped stable-key bridge](cleanups/001-pageid-stable-key-cutoff.md) — **WAITING** for its read-only data audit, an explicitly closed compatibility window, and Joe to resume it.
  - [Cleanup 002 — Retire v1 account and legacy local-state adapters](cleanups/002-retire-v1-account-and-local-state-adapters.md) — **WAITING** until Migration 003's rollback window ends, every supported Canopy and client is proven current, Joe removes the retained backups, and the v1 compatibility window is explicitly closed.
  - [Cleanup 003 — Remove singular update compatibility](cleanups/003-remove-singular-update-compatibility.md) — **WAITING** for every supported Canopy server and Arbor client to complete the plural-update rollout and for the mixed-version observation window to show no supported singular callers.
- **Smaller cleanup candidates and shared seams**
  - **Shared runtime protocol decoding** — **Deduplication · WAITING.** Promote when a second trusted boundary besides Arbor Sync needs runtime decoding; then colocate browser-safe pure decoders in `@arbor/core`, without adding schema generation solely to reduce repetition.
  - **Provider scalar normalization** — **Deduplication · OWNED by Postgres 001 and 002.** Freeze one language-neutral representation for blobs, 64-bit integers, booleans, nullability, and other provider scalars before implementations drift.
  - **Bounded-placement conformance** — **Deduplication · OWNED by Smaller projects 001 and 003 and Postgres 001.** Reuse the common placement corpus when deferred providers land; do not create another placement algorithm.
  - **Other ownership boundaries.** Private SQLite property receipts and direct-write bridges are removed under [Postgres 002](postgres/002-observation-and-semantic-sync.md); temporary whole-source query evaluation under [Apps 003](apps/003-development-compiler-and-editor-tooling.md); web-editor undo/history architecture under [Smaller project 005](smaller-projects/005-web-editor.md).

## Product Completion

This is work that fills out Arbor's product feature surface. It is useful and often substantial, but is not near-term merely because an older plan carries a P1 product priority.

- **Working-tree follow-ons** — The native working-tree transition is implemented and live; these plans restore surfaces deliberately left for later.
  - [Native 023 — Rebuild the web editor on the working tree](native/023-rebuild-the-web-editor-on-the-working-tree.md) — **PLANNED; after the Native 022 soak and Arbor Sync 002.** Build TypeScript `@arbor/working-tree` as a twin of the Swift package (`@arbor/object-store` lands in Arbor Sync 002), pass the same fixture, and mount the Arbor web editor again on its own backend rather than the daemon's deleted object route.
  - [Native 024 — Add disk editors for non-tree folders](native/024-disk-editors-for-non-tree-folders.md) — **PLANNED; depends on Native 023 for the web.** Add a simple local-file backend without synchronization machinery and refuse paths inside placed trees.
- **Apps** — Make authored Arbor applications executable through complete product slices that freeze the shared compiler, runtime, hosting, and agent contracts. The implemented headless SQLite query, observation, and mutation phases are documented in [`@arbor/data`](../packages/data/README.md).
  - [Apps 001 — Run the unchanged Supplies tree locally, natively, and on Canopy](apps/001-supplies-executable-site.md) — **P1 · IN PROGRESS; depends on Apps 003 and 004**, the completed SQLite runtimes, and historical Data 002. This owns the next vertical gate: the unchanged [`examples/supplies`](../examples/supplies) corpus as executable documents in local Arbor web, signed macOS Arbor, and its canonical Canopy website.
  - [Apps 002 — Host authored conversational interfaces over compiled Arbor handles](apps/002-canopy-hosted-agents.md) — **P1 · PLANNED; depends on Apps 001**, Arbor users, and Canopy execution. Agents reuse the same compiled query/mutation handles and authenticated Arbor-user context rather than introducing a separate data/runtime framework.
  - [Apps 003 — Compile and typecheck executable documents consistently](apps/003-development-compiler-and-editor-tooling.md) — **P1 · PLANNED; depends on historical Data 002 and the Apps 001 Supplies corpus.** This owns the shared compiler and development tooling across `arbor check`, editors, local Arbor, and Canopy.
  - [Apps 004 — Let readers invoke explicitly permitted reviewed mutations](apps/004-mutation-permissions.md) — **P1 · PLANNED; depends on the Apps 003 reviewed manifest and activation path.** This owns the caller authorization boundary without granting arbitrary tree writes.
- <a id="later-portable-deployment"></a>**Deploy Arbor apps to third-party web hosts, later** — After Apps 001 proves one compiled Arbor application on local Arbor, native Arbor, and Canopy, make that same application deployable to a third-party platform such as Vercel or Cloudflare. This is not a numbered plan yet because the compiled output does not exist and no specific external host has supplied real requirements.
  - A fully static application can be emitted as ordinary immutable web files for any static host, but only when all of its documents and queries can be validated and resolved at build time.
  - An application with live queries or mutations needs an adapter for the chosen hosting platform that preserves Arbor identity, transactions, subscriptions, reconnect behavior, validation, user identity, execution authority, and resource limits.
  - Either form keeps each document's assets, initial results, live handlers, declared capabilities, and schema requirements together rather than flattening the application into unrelated pages.
  - Deployed pages advertise their Arbor source through ordinary web metadata such as `<link rel="arbor">` and `Arbor-Tree`.
- **Postgres** — Complete a Postgres-backed child surface, then add coherent observation and optional local SQLite materializations. Query and mutation meaning remain owned by Apps; this project must not create a Postgres-specific node, endpoint, or query language.
  - [Postgres 001 — Complete the provider-neutral Postgres child backing](postgres/001-child-provider.md) — **P2 · PLANNED; depends on historical Data 002 and 007 and Apps 003.**
  - [Postgres 002 — Define observation and semantic synchronization](postgres/002-observation-and-semantic-sync.md) — **P1 · DESIGN REVIEW REQUIRED; depends on Postgres 001.** Define database snapshots, committed observation, logical effects, checkpoints, and semantic synchronization.
  - [Postgres 003 — Build a read-only SQLite projection](postgres/003-read-only-sqlite-projection.md) — **P2 · PLANNED; depends on Postgres 001**, the snapshot/observation subset of Postgres 002, and Apps 003. Materialize a reviewed Postgres query into a rebuildable read-only SQLite placement.
  - [Postgres 004 — Add bidirectional SQLite/Postgres projection](postgres/004-bidirectional-projection.md) — **P2 · DEFERRED; depends on Postgres 001–003.** Add offline mutation intent and Arbor-managed bidirectional materializations only after the one-way sequence is complete.
  - **Sequence and ownership.** The order is provider, observation and checkpoints, read-only materialization, then bidirectional mutation. Historical [Data 002](_done/data/002-reconcile-node-data-model.md) owns the common logical-node contract, [Data 007](_done/data/007-provider-runtime-ownership.md) owns provider runtime ownership, and [Data 011](_done/data/011-collection-file-wire.md) owns the current collection-file object shape and terminology.
- **Smaller projects** — Bounded product or model outcomes that do not yet justify a major project directory. Promote a cluster only when several related plans share one durable outcome; do not create a one-file top-level directory merely to avoid this grouping.
  - [Smaller project 001 — Preserve representation equivalence](smaller-projects/001-representation-equivalence.md) — **P1 · PLANNED; depends on historical Data 002 and 011.** Preserve node identity and logical equivalence when a child set changes representation.
  - [Smaller project 002 — Unify locator identity surfaces](smaller-projects/002-locator-identity-surfaces.md) — **P2 · PLANNED; depends on Smaller project 001 and Cleanup 001.** Give stable keys one spelling per surface and one segment-parameter grammar.
  - [Smaller project 003 — Project collection files into native offline replicas](smaller-projects/003-native-offline-collection-file-projection.md) — **P2 · PRIORITY RAISED by Native 022; depends on historical Data 002 and 011 and Apps 003.** Needed by the Mac working tree now and by the web working tree in Plan B.
  - [Smaller project 004 — Give external agents safe structured access](smaller-projects/004-external-agent-access.md) — **IN PROGRESS; not near-term.** General status and cloud-session discovery are implemented; structured read/mutation commands and the reusable agent skill remain.
  - [Smaller project 005 — Close web-editor interaction and fidelity gaps](smaller-projects/005-web-editor.md) — **P2 · BACKLOG.** Its items are independently selectable unless the plan says otherwise.
  - [Smaller project 007 — Surface accepted document history from Canopy](smaller-projects/007-canopy-document-history.md) — **P1 · PLANNED; execute before Smaller project 006 and coordinate retained-root policy with Canopy storage 001.** Surface accepted document history and restore-as-new-change from Canopy while keeping Arbor Sync filesystem repair separate; replica archive removal was completed in `b610d40`.
  - [Smaller project 006 — Attribute accepted updates and show line provenance](smaller-projects/006-line-provenance.md) — **P2 · PLANNED; depends on Smaller project 007 and coordinates retained-root policy with Canopy storage 001.** Reuse Canopy's document-version index for Git-blame-like current-line provenance without adding a revision DAG.
  - [Smaller project 008 — Bring Arbor web to native interface parity](smaller-projects/008-web-native-interface-parity.md) — **P2 · WAITING on Native 022 Plan B; coordinates safe search excerpts with Security 001.** Port the native shell, search, sidebar, Share, Accounts, and Sync Status information architecture into platform-appropriate browser UI.
- **Product gaps awaiting design** — These outcomes need interaction, ownership, recovery, and acceptance decisions before receiving numbered executor plans.
  - **First-party group creation and membership management** — **NEEDS DESIGN.** Create, place, and own a group profile coherently; add and remove structured profile members without teaching users to edit YAML; preserve Canopy reservation and account-disable semantics.
  - **Profile/device recovery, claim disputes, and administrator reset** — **NEEDS DESIGN.** Preserve the same self-certifying Profile TreeID and provide auditable proof of control rather than raw-credential transfer.
  - **Claimed-member removal/restoration and access-history recovery** — **NEEDS DESIGN.** Define confirmation, revocation, historical visibility, and restoration without a parallel group database.
  - **Persistent-host administration** — **NEEDS DESIGN.** Productize permanent domains, graceful restart, replacement-host restore, and verification while keeping migration scripts procedural.

## Hardening, Efficiency, Polish, etc.

- **Further reliability hardening**
  - [Reliability 007 — Reify composable Canopy conflicts as algebraic tree states](reliability/007-reify-composable-canopy-conflicts.md) — **P1 · PLANNED.** Add a projected root plus an ordered exact-root merge expression; derive local regions under versioned rules, keep syncing through accepted conflicts, and resolve only exact reviewed state.
  - [Reliability 002 — Serialize write-journal counters and appends per document](reliability/002-journal-append.md) — **DEFERRED.** The race remains real, but it is not near-term work.
  - [Reliability 006 — Preview and resume initial working-tree bootstrap](reliability/006-progressive-replica-bootstrap.md) — **PLANNED; not near-term.** Applies to iOS placement and visits; show a verified read-only root early, resume immutable snapshot bytes, then atomically install the complete working tree.
  - **Explicit web-editor unload drain** — **WAITING on Native 022 Plan B.** App-controlled navigation already awaits the admission machine's flush; browser `beforeunload`/`pagehide` has no bounded drain and no visible pending state, which Reliability 005 left as a documented limitation. Add one or surface the limitation in the UI.
  - **Commit native control text before flush** — **REVERIFY.** Confirm that Quagmire can still hold text outside `ArborDocumentBinding` at background, navigation, and close boundaries; if so, add commit-then-flush lifecycle behavior and visible checkpoint-pending state.
  - **Per-key frontmatter conflict semantics** — **READY.** Preserve independent external and local changes, detect same-key conflicts and deletions, and test them beside block three-way merge.
  - **Malformed and partial legacy-state recovery** — **OWNED by Cleanups 001 and 002.** Reject unsupported or ambiguous retained state without overwriting it, and retain focused failure-path tests through each cutoff.
  - **Provider-specific materialization controls** — **NEEDS DESIGN.** Add a control only when one concrete backing can report a reliable snapshot, progress, cancellation, and failure boundary; keep provider semantics in the owning Postgres or backing plan.
  - **Web-editor boundary.** Structural undo, exact reorder restoration, pointer lifecycle, keyboard access, context-menu focus, bounded history, and scroll restoration stay together in [Smaller project 005](smaller-projects/005-web-editor.md).
- **Security** — Alpha-stage injection, authorization, secret-handling, hostile-input, sandboxing, and trust-boundary work.
  - [Security 001 — Render search excerpts without treating indexed content as HTML](security/001-search-excerpts.md) — **P1 · TODO; rescoped by Native 022.** The daemon's search route and FTS index were deleted in Phase 7; the requirement applies to the native search index now and to the Plan B client text index when the web editor returns.
  - [Security 002 — Decode URL paths once at the external boundary](security/002-path-decoding.md) — **P1 · TODO.**
  - [Security 003 — Harden Canopy host responses](security/003-canopy-host-responses.md) — **P2 · TODO.** Apply safe response headers and trustworthy pairing-rate-limit identity.
  - [Security 004 — Complete access-link sharing without leaking secrets](security/004-access-link-secrets.md) — **P1 · TODO.** Keep native link creation out of the UI until protected browser/native navigation, revocation, and recipient editing pass their staged gates.
  - [Security 005 — Keep ignored filesystem content outside Arbor trees](security/005-ignore-policy.md) — **P1 · PLANNED.** Add portable `.arborignore` and `.gitignore` compatibility through one discovery/watch/index/snapshot/materialization policy; preserve accepted tracked content until explicit removal and never delete ignored local bytes during pull.
  - **Isolate Canopy application-code execution** — **WAITING until Canopy executes synchronized `schema.ts`, SSR, query, or mutation code.** Use one separately contained, quota-bound, version-pinned execution boundary shared with Apps 003 rather than a schema-only retrofit.
  - **Validate directory-entry names on every Wire client read path** — **READY.** Reject empty, dot, parent, and separator-bearing names before materialization; reuse the server graph invariant and add hostile-object fixtures.
  - **Replace prose-derived authorization status** — **READY.** Canopy/Wire responses should classify authorization failures with typed errors rather than English-text matching; coordinate with Security 003 if both touch the response helper.
  - **Bound unauthenticated object reachability checks** — **NEEDS DESIGN; coordinate with Native 022 Phase 1**, which widens the object route to any retained accepted root and must not widen access. Build a staleness-safe reachability index before replacing full readable-tree graph scans. Performance work belongs in Speed; the access invariant remains security-critical.
  - **Upgrade reachable YAML parsing advisory** — **READY.** Move the direct `yaml` dependency to a release containing the nested-collection stack-overflow fix, then run frontmatter and `_store.postgres` parsing tests.
  - **Safe ordinary-file metadata and previews** — **NEEDS DESIGN.** Define bounded size/type detection and inert preview rules before exposing richer untracked-file metadata; never parse binary or placeholder bytes as authored text.
- **Testing and evidence**
  - [Testing 001 — Run maintained gates in CI](testing/001-ci.md) — **P2 · TODO.** Cover TypeScript, browser, protocol, performance, and Swift; Testing 002 should land first if the repeated parallel lane is not stable.
  - [Testing 002 — Make parallel integration tests independent](testing/002-parallel-integration-isolation.md) — **DEFERRED · LOW PRIORITY.** Revisit only if shared process-global fixture state causes recurring failures or blocks CI.
  - **Developer browser smoke harness** — **WAITING on Native 022 Plan B.** Preserve DOM, state, and network probes for deterministic invariants; reserve hands-on checks for hover, focus, pointer drag, and feel.
  - **Canopy authorization characterization** — **READY.** Cover revoked grants, read-link write denial, non-admin access mutation, and removal of transitive group access in a dedicated daemon suite.
  - **Cross-client group workflow coverage** — **WAITING.** Add browser and native creation/membership coverage after the first-party flow is designed; do not freeze manual YAML as the UX.
  - **Accessibility and responsive browser audits** — **READY.** Establish repeatable keyboard, focus, semantic, contrast, and narrow/wide layout checks around the existing objective editor audit.
  - **`mergeBlocks` characterization** — **READY.** Add direct unit coverage for conservative conflict behavior before changing its alignment algorithm.
  - **Markdown/BlockNote round-trip fixtures** — **READY.** Add table-driven source-fidelity coverage for marks, raw fallback, nesting, and untouched bytes before expanding Smaller project 005.
  - **Historical boundary.** Exact-artifact native acceptance and completed device-management browser E2E remain in [history](_done/README.md); they are not duplicated here.
- **Speed** — Measured removal of unnecessary rebuilding, unbounded scanning, and response costs.
  - **File-provider exact-source cache invalidation** — **READY.** Add filesystem-driven invalidation and metrics and deduplicate schema, store, and Markdown reads while retaining exact complete-key-set validation; do not extend the cache to database providers.
  - **Canopy object reachability index** — **NEEDS DESIGN; coordinate with Native 022 Phase 1** (retained-root reachability). Replace per-request graph scans only with an index whose update and invalidation rules cannot widen object access; coordinate the invariant with Security.
  - **Static response caching and render code splitting** — **READY.** Add ETag/cache policy for immutable built assets and measure a split that avoids eagerly loading KaTeX on routes that do not render it.
  - **Minimal changed-document reconciliation** — **CONDITIONAL.** Promote only if measured large external rewrites make whole-document `replaceBlocks` disruptive; preserve the first surviving block and cursor rather than optimizing speculatively.
  - **Representative cold/warm workspace benchmarks** — **READY.** Measure startup, discovery, indexing, navigation, and resynchronization against checked-in shape distributions before choosing another cache or index.
  - **Extension-aware lazy indexing** — **REVERIFY.** Keep deferred indexing from reading known binary, unavailable, or placeholder content; add metrics and hostile-extension fixtures before widening discovery.
  - **Ownership boundary.** Whole-table database hashing belongs to [Postgres 002](postgres/002-observation-and-semantic-sync.md), and bounded portable-query evaluation belongs to [Apps 003](apps/003-development-compiler-and-editor-tooling.md).

## Open Questions and Completed Work

- [`open-questions.md`](open-questions.md) contains unresolved design questions. An open question is not implementation status or an accepted executor plan.
- [`_done/`](_done/README.md) contains completed, rejected, and superseded plans plus durable implementation evidence (Native 022 Phase 7 moved Smaller project 009, Speed 001, and two hardening items there as superseded). Its historical indexes remain local to `_done` and are not part of the active catalog above.
- Deployment migrations are procedures, not plans. Each lives in its own directory under [`migrations/`](../migrations/README.md) with reusable procedure and tools, and is deleted after cutover; a plan whose change needs one links there.

## Planning Rules

- An active plan describes only work that remains. When completed, move its executor document to `_done/`, preserve the identifier used by old commits and discussions, and record verification evidence.
- **Implemented** means the focused behavior and acceptance checks pass in current source. **In progress** means source is incomplete. **Planned** has an accepted outcome and executable design. **Backlog** or **needs design** is not ready for implementation.
- Product priority is stated explicitly; filename order does not imply dependency order.
- Keep path-scoped access as a nested-tree boundary, groups as authored trees, and server history private unless an accepted product requirement changes those choices.
- Do not add a generic store, transport, credential, deployment, SDK-generation, replay, or production-HA framework without a second concrete implementation that needs it.
- Implement the smallest end-to-end system that proves visible behavior while preserving durable acknowledgement, conflict safety, deterministic protocol behavior, and cross-language agreement.
- Inspect source, tests, and `git status` before trusting any status label. Do not rewrite partial implementation as future work or weaken a future-facing specification to match a staged UI.
