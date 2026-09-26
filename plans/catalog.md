# Detailed plan catalog

Directories group plans by the component or product surface they change. This is an inventory,
not an execution queue; use the [outcome menu](README.md) to choose work. Plans chosen for
near-term work live in `soon/` but are listed here under their owner, marked **SOON**. Priorities remain open.
Historical identifiers are recorded in each moved plan. Number gaps do not imply missing work or ordering.
Old P1/P2 labels are workstream assessments, not current global priorities.

[Release and verification](release-and-soak.md) owns remaining installation, deployment,
manual acceptance and soak gates. Check current source/tests before executing any older plan.

## Native clients

`swift/` — Native placement, offline data, editor command capture and accepted-choice review.

- [Native 003 — Project collection files into native offline replicas](swift/003-native-offline-collection-file-projection.md) — **DEFERRED; depends on historical Data 002 and 011 and Apps 003.** Promote when offline collection-row browsing is selected as a product requirement; its plan does not currently authorize implementation.
- [Native 006 — Place trees sparsely on iOS](swift/006-sparse-ios-placement.md) — **PLANNED · M.** Place an iOS tree by walking its spine (directories and Markdown) object by object, as catch-up already does, instead of downloading one whole snapshot; resume by keeping what arrived, and state what an unfetched file does offline.
- [Native 008 — Capture copies with changes and compound undo](swift/008-copies-with-changes-and-compound-undo.md) — **PLANNED; needs Quagmire 0.9.0.** Copies at a new depth, paste and inline provenance, and undo of Move to Document and inline-and-retire; block moves and Move to Document as one change are implemented, not installed.
- [Native 012 — Show declined folders in the Mac app](swift/012-show-declined-folders.md) — **NOT STARTED.** List placed folders with declined paths in Sync Status and offer Restore and Resend through Arbor Sync's `/v1/declined` routes.
- **Choice review extensions** — promote one only when a real review needs it. Safe binary previews and export, richer directory browsing and format-specific collection reconstruction; richer long-source comparison (beyond 4,000 lines it falls back to raw source) and visual checks of whitespace and line-ending differences; a compatible freshness policy so unrelated accepted updates need not force renewed review (host and client together); wider fault injection across review persistence, submission, installation, retirement, authorization changes and cancellation; explanations of verified moves, copies and deletions; rule-provided combination previews; bulk resolution and offline review.

## Web client

`canopy-web/` — Restore the browser working-tree client, then its interface and editor features.

- [Web 025 — Canopy for the web: one browser editor for `arbor open` and canopyd](canopy-web/025-arbor-web.md) — **P1 · PLANNED; after the Native 022 soak closeout.** One bundle behind a `WebHost` interface, served by Arbor Sync on loopback and by canopyd at canonical URLs; TypeScript twins of the Swift working tree, app model and editor host; three projects (B1 local editor, B2 canopyd host and account surfaces, B3 choice review and editor depth) with a soak between each. The [surface inventory](canopy-web/surfaces.md) lists every native surface with its web treatment. Supersedes Web 023, 008 and 005, now in `_done/web/` (completed plan, deleted; see git history).

## Local filesystem

`filesystem/` — Filesystem writes, membership and ordinary-folder editing.

- **`arbor untrack`** — candidate. Ignore rules keep new content out but never untrack a path the folder already published ([status](../status.md#ignored-filesystem-content-filesystem-005--2026-09-25)); today the recipe is to move the file out, let the deletion sync, and move it back. One command could publish the deletion while leaving the bytes in place. The bytes stay in accepted history either way, so a leaked secret must still be rotated.
- **Ignored paths in the Mac app's publish view** — Native candidate. Mark which local paths the folder's ignore rules keep out, and which ignored paths it still tracks, in "what it would publish".
- [Filesystem 024 — Add disk editors for non-tree folders](filesystem/024-disk-editors-for-non-tree-folders.md) — **PLANNED; depends on Web 025 for the web.** Add a simple local-file backend without synchronization machinery and refuse paths inside placed trees.

## canopyd authority, storage and history

`canopyd/` — Merge policy, retained state, accepted history, provenance and hosted-tree configuration.

- [canopyd 001](canopyd/001-pack-object-storage.md): measure storage before choosing packing or pruning.
- [canopyd 005 — Configure each hosted tree, profiles included, in its own configuration tree](soon/005-tree-configuration-trees.md) — **SOON · P3 · ADOPTED; four open questions.** Move a tree's address, access rules and administrators (`admin` rules for person or group profiles) out of each account's `trees.yaml` into a private per-tree configuration tree, fold the account configuration into the profile's (devices and `apps.yaml`), and replace code sponsors with lending by the named subject.
- [canopyd 006 — Record who submitted each update and show line provenance](canopyd/006-line-provenance.md) — **P2 · PLANNED; after canopyd 007.** Record a safe actor on each accepted update, replace the public `subject` with it, and compute current-line blame over the `document_versions` rows; versions from before the migration 016 squash show an unknown actor.
- [canopyd 007 — Document history routes, restore, and the History view](canopyd/007-document-history-routes-and-restore.md) — **P1 · PLANNED; execute before canopyd 006.** The `document_versions` index is live (canopyd 013, migration 014); what remains is the write-credential-only history routes over it, restore as an ordinary new change, and the native History view.
- [canopyd 014 — The merge handles many cases brilliantly](canopyd/014-merge-handles-many-cases.md) — **P3 · IDEAS AND CANDIDATES.** The first transfer round (Markdown list/table/link transfers, same-anchor ordering, keyed JSON/YAML moves, TS/JS function moves) is implemented, not deployed. Sets the constraints (lose nothing, keep the syntax, keep the meaning as far as possible) and three outcomes (merge, merge with a note, review), biased away from review; then 34 candidates across anchors, Markdown, structured data, code, new formats and presentation. First: portable notes in source intent §7, and a count of what reaches review. Open: bump the rule revisions the first round changed.
- [canopyd 017 — Run the object collector live](canopyd/017-collect-objects-live.md) — **P2 · READY; gated on Joe.** The collector is implemented and rehearsed; deploy it, back up, dry-run, delete, then schedule `railway ssh` runs. Open: a document-version retention bound, which holds most of what remains.
- **Sidebar creations as `addEntry`** — candidate. Editor page creation and a directory's first body are traced (canopyd 011, [closeout](../status.md#canopyd-011-012-and-013-closeout--2026-09-22)); the sidebar's `createMarkdown`/`createDirectory` actions still publish snapshots because their admission records carry no editor document. Emit `addEntry` from `retainStructure` for those actions too.

## CLI and external agents

`cli/` — Structured access for independently installed agents.

- [CLI 004 — Teach external agents to work in placed folders](cli/004-external-agent-access.md) — **PLANNED · S.** A publication wait on `arbor status` if needed and one reusable skill for Claude Code and Codex; agents edit placed folders with their own tools. The old read/mutation command surface is dropped.

## Executable applications

`apps/` — Sidecar/source resolution with resource policy → durable authoring/compiler → Supplies; hosted agents follow.

- [Apps 001 — Run the Supplies tree locally, natively, and on canopyd](apps/001-supplies-executable-site.md) — **P1 · IN PROGRESS; depends on Apps 003–006**, the completed SQLite runtimes, and historical Data 002. This owns the next vertical gate: the adapted [`examples/supplies`](../examples/supplies) corpus as executable documents in local Canopy for the web, signed macOS Overstory, and its canonical canopyd website.
- [Apps 002 — Host authored conversational interfaces over compiled Overstory handles](apps/002-canopy-hosted-agents.md) — **P1 · PLANNED; depends on Apps 001**, Overstory users, and canopyd execution. Agents reuse the same compiled query/mutation handles and authenticated Overstory-user context rather than introducing a separate data/runtime framework.
- [Apps 003 — Compile and typecheck executable documents consistently](apps/003-development-compiler-and-editor-tooling.md) — **P1 · PLANNED; depends on historical Data 002 and the Apps 001 Supplies corpus.** This owns the shared compiler and development tooling across `arbor check`, editors, local Overstory, and canopyd.
- [Apps 005 — Source resolution and HTTP sidecar](apps/005-source-resolution-and-sidecar.md) — **P1 · PLANNED; after the implemented 007 and authority prerequisites of 004.** Extract the headless HTTP runtime, prove failure independence and a QuickJS-free daemon graph; browser hosting follows in 001/003.
- [Apps 006 — Durable query/mutation authoring](apps/006-durable-authoring.md) — **P1 · PLANNED; after 004/005, with 003.** Combined author/user requirements, resumable steps, backing receipts and the three lifecycle examples.

## Postgres

`postgres/` — Provider → observation/checkpoints → read-only projection → bidirectional projection; preserve logical identity across representations.

- [Postgres 001 — Complete the provider-neutral Postgres child backing](postgres/001-child-provider.md) — **P2 · PLANNED; depends on historical Data 002 and 007 and Apps 003.**
- [Postgres 002 — Define observation and semantic synchronization](postgres/002-observation-and-semantic-sync.md) — **P1 · DESIGN REVIEW REQUIRED; depends on Postgres 001.** Define database snapshots, committed observation, logical effects, checkpoints, and semantic synchronization.
- [Postgres 003 — Build a read-only SQLite projection](postgres/003-read-only-sqlite-projection.md) — **P2 · PLANNED; depends on Postgres 001**, the snapshot/observation subset of Postgres 002, and Apps 003. Materialize a reviewed Postgres query into a rebuildable read-only SQLite placement.
- [Postgres 004 — Add bidirectional SQLite/Postgres projection](postgres/004-bidirectional-projection.md) — **P2 · DEFERRED; depends on Postgres 001–003.** Add offline mutation intent and Overstory-managed bidirectional materializations only after the one-way sequence is complete.
- [Postgres 005 — Preserve representation equivalence](postgres/005-representation-equivalence.md) — **P1 · PLANNED; depends on historical Data 002 and 011.** Preserve node identity and logical equivalence when a child set changes representation.

## Security boundaries

`security/` — Search rendering, URL decoding, host responses and access-link secrets.

- [Security 001 — Render search excerpts without treating indexed content as HTML](security/001-search-excerpts.md) — **P1 · TODO; rescoped by Native 022.** The daemon's search route and FTS index were deleted in Phase 7; the requirement applies to the native search index now and to the Plan B client text index when the web editor returns.
- [Security 002 — Decode URL paths once at the external boundary](security/002-path-decoding.md) — **P1 · TODO.**
- [Security 003 — Harden canopyd host responses](security/003-canopy-host-responses.md) — **P2 · TODO.** Apply safe response headers and trustworthy pairing-rate-limit identity.
- [Security 004 — Complete access-link sharing without leaking secrets](security/004-access-link-secrets.md) — **P1 · TODO.** Keep native link creation out of the UI until protected browser/native navigation, revocation, and recipient editing pass their staged gates.
- [Security 006 — Device keys alongside credential digests, and recovery](security/006-device-keys.md) — **P3 · PROPOSED; after canopyd 005.** Devices may hold a signing key instead of a bearer credential, moving over without a forced migration, and the profile key can reset a lost device list; one host only.
- [Security 007 — Place trees on other hosts](security/007-placement-hosts.md) — **P3 · PROPOSED; after Security 006.** A placement host accepts a profile's key devices from the device keys its home host publishes, cached briefly, so one profile holds canonical trees on several hosts with no per-account data; `apps.yaml` across hosts waits for Security 008.
- [Security 008 — Portable profiles and delegation across hosts](security/008-portable-profiles.md) — **P3 · PROPOSED; after Security 007.** A device list that traces to the profile key, profile configuration beyond the home host, `apps.yaml` and delegation across hosts, remote groups, retiring credential digests; to be split once designed.

## Verification

[Release and soak](release-and-soak.md) owns remaining installs, deployments, hands-on checks and dated ordinary-use observation, separate from feature work.

## Compatibility cutoffs


## Product Completion

The numbered product work is grouped by owner above. These additional outcomes need design
or a concrete implementation trigger; they are not new executor plans.

- <a id="later-portable-deployment"></a>**Deploy Overstory apps to third-party web hosts, later** — After Apps 001 proves one compiled Canopy application on local Overstory, Canopy, and canopyd, make that same application deployable to a third-party platform such as Vercel or Cloudflare. This is not a numbered plan yet because the compiled output does not exist and no specific external host has supplied real requirements.
  - A fully static application can be emitted as ordinary immutable web files for any static host, but only when all of its documents and queries can be validated and resolved at build time.
  - An application with live queries or mutations needs an adapter for the chosen hosting platform that preserves Overstory identity, transactions, subscriptions, reconnect behavior, validation, user identity, execution authority, and resource limits.
  - Either form keeps each document's assets, initial results, live handlers, declared capabilities, and schema requirements together rather than flattening the application into unrelated pages.
  - Deployed pages advertise their Overstory source through ordinary web metadata such as `<link rel="arbor">` and `Arbor-Tree`.

- **Product gaps awaiting design** — These outcomes need interaction, ownership, recovery, and acceptance decisions before receiving numbered executor plans.
  - **Name-based sharing and profile avatars** — **NEEDS DESIGN.** Define user lookup, ambiguous-name selection, visibility and avatar ownership before writing an executor plan.
  - **Profile/device recovery, claim disputes, and administrator reset** — **NEEDS DESIGN.** Preserve the same self-certifying Profile TreeID and provide auditable proof of control rather than raw-credential transfer.
  - **Claimed-member removal/restoration and access-history recovery** — **NEEDS DESIGN.** Define confirmation, revocation, historical visibility, and restoration without a parallel group database.
  - **Persistent-host administration** — **NEEDS DESIGN.** Productize permanent domains, graceful restart, replacement-host restore, and verification while keeping migration scripts procedural.

## Shared cleanup candidates

- **Shared runtime protocol decoding** — **Deduplication · WAITING.** Promote when a second trusted boundary besides Arbor Sync needs runtime decoding; then colocate browser-safe pure decoders in `@overstory/protocol`, without adding schema generation solely to reduce repetition.
- **Provider scalar normalization** — **Deduplication · OWNED by Postgres 001 and 002.** Freeze one language-neutral representation for blobs, 64-bit integers, booleans, nullability, and other provider scalars before implementations drift.
- **Bounded-placement conformance** — **Deduplication · OWNED by Postgres 005, Native 003 and Postgres 001.** Reuse the common placement corpus when deferred providers land; do not create another placement algorithm.
- **Other ownership boundaries.** Private SQLite property receipts and direct-write bridges are removed under [Postgres 002](postgres/002-observation-and-semantic-sync.md); temporary whole-source query evaluation under [Apps 003](apps/003-development-compiler-and-editor-tooling.md); web-editor undo/history architecture under Web 005 (completed plan, deleted; see git history).

## Hardening, Efficiency, Polish, etc.

These inherited candidates are unverified or conditional. Inspect current behavior and tests
before promoting one; an old audit finding is not proof of a current implementation gap.


- **Further reliability hardening**
  - **Explicit web-editor unload drain** — **WAITING on Web 025.** App-controlled navigation already awaits the admission machine's flush; browser `beforeunload`/`pagehide` has no bounded drain and no visible pending state, which Reliability 005 left as a documented limitation. Add one or surface the limitation in the UI.
  - **Commit native control text before flush** — **REVERIFY.** Confirm that Quagmire can still hold text outside `CanopyDocumentBinding` at background, navigation, and close boundaries; if so, add commit-then-flush lifecycle behavior and visible checkpoint-pending state.
  - **Per-key frontmatter conflict semantics** — **REVERIFY.** Preserve independent external and local changes, detect same-key conflicts and deletions, and test them beside block three-way merge.
  - **Malformed and partial legacy-state recovery** — **OWNED by Cleanups 001 and 002.** Reject unsupported or ambiguous retained state without overwriting it, and retain focused failure-path tests through each cutoff.
  - **Provider-specific materialization controls** — **NEEDS DESIGN.** Add a control only when one concrete backing can report a reliable snapshot, progress, cancellation, and failure boundary; keep provider semantics in the owning Postgres or backing plan.
  - **Web-editor boundary.** Structural undo, exact reorder restoration, pointer lifecycle, keyboard access, context-menu focus, bounded history, and scroll restoration stay together in the completed Web 005 plan (deleted; see git history).
- **Security** — Alpha-stage injection, authorization, secret-handling, hostile-input, sandboxing, and trust-boundary work.
  - **Isolate canopyd application-code execution** — **OWNED by Apps 005.** Executable collection schemas are gone (Apps 007, declarative CDDL, implemented); extract application execution into the authenticated, quota-bound HTTP sidecar. Hostile-code sandboxing remains a separate trust-boundary decision.
  - **Validate directory-entry names on every Overstory client read path** — **REVERIFY.** Reject empty, dot, parent, and separator-bearing names before materialization; reuse the server graph invariant and add hostile-object fixtures.
  - **Replace prose-derived authorization status** — **REVERIFY.** canopyd/Overstory responses should classify authorization failures with typed errors rather than English-text matching; coordinate with Security 003 if both touch the response helper.
  - **Object reachability authorization** — owned by the canopyd object-reachability candidate under Speed below. Its access and invalidation tests must prove that the optimization cannot widen access.
  - **Upgrade reachable YAML parsing advisory** — **REVERIFY.** Move the direct `yaml` dependency to a release containing the nested-collection stack-overflow fix, then run frontmatter and `_store.postgres` parsing tests.
  - **Safe ordinary-file metadata and previews** — **NEEDS DESIGN.** Define bounded size/type detection and inert preview rules before exposing richer untracked-file metadata; never parse binary or placeholder bytes as authored text.
- **Testing and evidence**
  - **Developer browser smoke harness** — **WAITING on Web 025.** Preserve DOM, state, and network probes for deterministic invariants; reserve hands-on checks for hover, focus, pointer drag, and feel.
  - **canopyd authorization characterization** — **REVERIFY.** Cover revoked grants, read-link write denial, non-admin access mutation, and removal of transitive group access in a dedicated daemon suite.
  - **Cross-client group workflow coverage** — **WAITING.** Add browser and native creation/membership coverage after the first-party flow is designed; do not freeze manual YAML as the UX.
  - **Accessibility and responsive browser audits** — **WAITING on Web 025.** Establish repeatable keyboard, focus, semantic, contrast, and narrow/wide layout checks around the existing objective editor audit.
  - **`mergeBlocks` characterization** — **REVERIFY.** Add direct unit coverage for conservative conflict behavior before changing its alignment algorithm.
  - **Markdown/BlockNote round-trip fixtures** — **REVERIFY.** Add table-driven source-fidelity coverage for marks, raw fallback, nesting, and untouched bytes before expanding Web 025 B3.
  - **Historical boundary.** Exact-artifact native acceptance and completed device-management browser E2E were recorded in completed plans (deleted; see git history); they are not duplicated here.
- **Speed** — Measured removal of unnecessary rebuilding, unbounded scanning, and response costs.
  - **File-provider exact-source cache invalidation** — **REVERIFY.** Add filesystem-driven invalidation and metrics and deduplicate schema, store, and Markdown reads while retaining exact complete-key-set validation; do not extend the cache to database providers.
  - **canopyd object reachability index** — **NEEDS DESIGN; preserve Native 022’s implemented retained-root authorization** (retained-root reachability). Replace per-request graph scans only with an index whose update and invalidation rules cannot widen object access; coordinate the invariant with Security.
  - **Static response caching and render code splitting** — **REVERIFY.** Add ETag/cache policy for immutable built assets and measure a split that avoids eagerly loading KaTeX on routes that do not render it.
  - **Minimal changed-document reconciliation** — **CONDITIONAL.** Promote only if measured large external rewrites make whole-document `replaceBlocks` disruptive; preserve the first surviving block and cursor rather than optimizing speculatively.
  - **Representative cold/warm workspace benchmarks** — **REVERIFY.** Measure startup, discovery, indexing, navigation, and resynchronization against checked-in shape distributions before choosing another cache or index.
  - **Extension-aware lazy indexing** — **REVERIFY.** Keep deferred indexing from reading known binary, unavailable, or placeholder content; add metrics and hostile-extension fixtures before widening discovery.
  - **Merge sidecar replay cost** — **MEASURED 2026-09-24.** The sidecar replays every plain edit canopyd fast-forwarded before its next question, and a cold cache replays each chain from its start: about 17 ms an entry at 110 files, 30 ms at 200 and 125 ms at 1,000 (`FILES=… bun tests/performance/snapshot-acceptance-cost.ts` and the `replayed` count in the sidecar's timings). Long rebuilds now continue across retries (`ARBOR_MERGE_REPLAY_MS`), and saved sidecar states (`--cache`, implemented, not deployed) make a restart replay only from the nearest save, at most about 32 entries: on the production copy's 282-entry main tree, 37 ms instead of about 1 s. What remains is the cost per replayed entry, about 4 ms locally and an estimated 10–20 ms live on that 106-file tree; profile one step before splitting. A replayed plain edit clones the whole active state and compares every node to record its result (unchanged nodes and history records are shared); split the retained state per file so it touches only its file's state and directories. Starting replay partway along a chain is not the fix: it drops attribution (see [status](../status.md#log-entries-and-one-merge-question--2026-09-24)).
  - **Flat-directory acceptance latency** — **MEASURED 2026-09-24.** A plain traced edit on the head takes about 95 to 130 ms of server time with 1,000 files in one directory: candidate validation, the preflight store, the plain-trace check and the entry diff each decode the 1,000-entry directory. At 110 to 200 files it is well under the 100 ms target; from the client, 41 ms at 1,000 files locally. Live, no directory exceeds 63 entries and single fast-forwards take 39 ms median. Promote only if a real tree gets that flat; a snapshot beside an open choice there (about 500 ms) mostly expresses entry-choice alternatives as whole roots.
  - **Ownership boundary.** Whole-table database hashing belongs to [Postgres 002](postgres/002-observation-and-semantic-sync.md), and bounded portable-query evaluation belongs to [Apps 003](apps/003-development-compiler-and-editor-tooling.md).
