# Plan 004: Specify and implement Hunch-grade Arbor iCloud durability

> **Executor instructions**: Treat this as a data-preservation protocol, not a
> file-watcher feature. Freeze the format and cross-language fixtures before
> allowing Swift and TypeScript to coauthor a real folder. Never use wall-clock
> time as the causal order. Never run arbord and direct Swift persistence as
> simultaneous first-party writers on macOS.
>
> **Drift checks (run first)**:
>
> ```sh
> git diff --stat 84fc705..HEAD -- \
>   spec/format.md spec/client.md spec/system.md spec/fixtures \
>   packages/fs packages/arbord native package.json plan/native.md
> git -C /Users/joe/src/hunch diff --stat 4c35f37..HEAD -- \
>   App/Sources/Clamshell App/Tests/HunchUnitTests
> ```
>
> Stop if Arbor has since adopted another native/cloud durability format or if
> Hunch's cited recovery semantics changed.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 002; app/session integration depends on Plan 003
- **Category**: architecture
- **Planned at**: Arbor `84fc705`, Hunch `4c35f37`, 2026-08-18

## Why this matters

Hunch's iCloud reliability does not come from saving Markdown frequently. It
comes from synchronous generation admission, per-writer recovery logs, causal
ordering, log-before-file durability, deferred peer state, external-change
classification, conflict salvage, and terminal drains. TreeHopper may use a new
sidecar format, but omitting any of those semantics recreates the data-loss
races Hunch has already solved. This is also the highest-risk part of the native
project because TypeScript arbord and Swift direct storage will independently
implement the same protocol.

## Current state and corrected invariants

- `spec/format.md:65-73` reserves `.arbor` and excludes journals/recovery from
  portable authored content unless another specification explicitly opts in.
- `plan/native.md:324-368` currently requires exact Clamshell `.history`
  compatibility. Replace that representation requirement with a versioned Arbor
  iCloud profile while keeping semantic equivalence and dual-language fixtures.
- Hunch's `PageCoordinator.swift:274-333` synchronously installs a generation
  and ordered write entry before returning; `flush` awaits the current tail.
- `Clamshell.swift:1024-1047` makes recovery intent durable before writing the
  Markdown file.
- `RecoveryLog.swift:12-20,830-866` gives each installation its own durable
  writer ID/log and folds all writers with per-page Lamport counters.
- `Clamshell+Presenter.swift:207-229` generation-guards external reload: a local
  edit that lands during the read cancels/retries the external replacement.
- `Clamshell+Reconcile.swift:45-57,93-123` defers a foreign log beyond the
  Markdown body's trusted frontier until the peer body arrives, preserving the
  peer's exact order. Same-writer log-ahead state still replays after a crash.
- **Correct mtime rule**: `PatchEngine.swift:381-388,404-445` restores a missing
  authoritative add even if the Markdown mtime is newer. Modification time only
  suppresses applying an older purge/removal to a newer externally edited body.
  `plan/native.md:362` currently states this incorrectly and must be fixed.
- Hunch watches both the open Markdown file and per-page history directory via
  two `NSFilePresenter`s (`Clamshell+Presenter.swift:79-135,265-309`).
- Hunch's move/trash/restore can separate path-mirrored history from the page on
  partial failure. Arbor must key history by PageID so path moves do not move the
  journal.
- Hunch tests use temporary local directories; they do not exercise real File
  Provider placeholder download, presenter delivery, background suspension, or
  multi-file iCloud reordering. TreeHopper needs both deterministic fixtures and
  a real-provider qualification matrix.

## Proposed Arbor iCloud v1 profile

Add an optional implementation profile, e.g. `spec/icloud.md`, which explicitly
authorizes the following private synced namespace while excluding it from normal
browsing, indexing, Arbor wire objects, publication, static export, and shared
tree snapshots:

```text
<tree root>/.arbor/icloud/v1/
  pages/<sha256(PageID)>/<writerID>.events
  tree/<writerID>.events
```

The exact extension may be `.jsonl`, a CBOR sequence, or another append-safe
encoding selected during Step 1. The semantic schema is fixed regardless of
encoding:

```text
Page event
  version, writerID, sequence, operationID
  PageID, pathHint
  kind: add | observe | purge | materialization
  blockFingerprint, parentFingerprint, sourceSnapshot (private recovery payload)
  bodyHash / throughSequence (materialization)
  recordedAt (display and conservative external-edit gate only)

Tree event
  version, writerID, sequence, operationID
  kind: ensureIdentity | move | trash | restore
  PageID, oldPathHint, newPathHint, precondition, phase
```

Rules:

- Writer IDs are app-local and never synced as shared identity. Each installation
  writes only its own files; all devices read the union.
- Page directories are derived from a traversal-safe hash of opaque PageID, not
  the path. Every record repeats/validates PageID so a hash collision or corrupt
  placement cannot address another document.
- Counters are monotonic per `(writer, PageID)` and raised above observed causal
  state before append. Records compare by causal counter then writer ID; wall
  clock is never the tie-breaker for intent.
- `add` and `purge` are authoritative. `observe` stores recoverable external or
  merged content without claiming authorship. Only authoritative records decide
  alive/tombstoned state.
- Recovery `sourceSnapshot` values are provider-owned exact source fragments or
  complete materializations derived from accepted Markdown. They are not a
  Quagmire API and are never accepted as a client-supplied parsed block model.
- A commit appends its block intent plus a `materialization` record containing
  the expected Markdown body hash and frontier, durably flushes that append, and
  only then atomically writes Markdown.
- A foreign frontier whose expected body hash is not present is pending. Do not
  reconstruct peer sibling order from parent fingerprints. When matching
  Markdown arrives, load it exactly, then reconcile.
- A same-writer log-ahead crash is replayable. A file-ahead/external change is
  absorbed as `observe`, not `add`.
- Fold/reconcile is idempotent. Local watermarks, offsets, indexes, and caches
  live outside the synced tree and can be discarded/rebuilt.
- PageID-keyed journals do not move during rename/trash/restore. Tree operations
  are logged before multi-file mutation and repaired idempotently after a crash.
- Assets are monitored/materialized explicitly and use immutable unique names;
  traversal is rejected. Their availability is part of page readiness.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Swift cloud tests | `swift test --package-path native/Packages/ArborCloud` | pure fold/store/provider tests pass |
| TS cloud fixtures | `bun test tests/protocol/icloud*.test.ts` | all fixtures pass |
| Unified cloud gate | `bun run test:icloud-protocol` | TypeScript and Swift read the same fixtures and agree |
| REST protocol | `bun run test:protocol` | existing protocol tests remain green |
| TreeHopper kit | `swift test --package-path native/Packages/TreeHopperKit` | provider/session tests pass |
| macOS app tests | `xcodebuild test -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=macOS' -derivedDataPath /tmp/treehopper-cloud-macos CODE_SIGNING_ALLOWED=NO` | exit 0 |
| iOS app tests | `xcodebuild test -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/treehopper-cloud-ios CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Root gates | `bun run typecheck && bun test && bun run build` | each exits 0 |
| Diff check | `git diff --check` | no output |

Add `test:icloud-protocol` in this plan; it must be executable, not prose-only.
Run Xcode gates sequentially.

## Scope

**In scope**:

- New optional iCloud profile spec and fixtures under `spec/`.
- `native/Packages/ArborCloud/` pure recovery engine, coordinated file store,
  presenters/materialization state, and direct provider.
- TypeScript arbord/filesystem implementation of the same profile.
- TreeHopper provider/session integration and sync/recovery presentation.
- Local and real File Provider/iCloud qualification harnesses.
- Corrections to `plan/native.md` and `spec/format.md` sidecar wording.

**Out of scope**:

- CloudKit as canonical content storage.
- Hunch `.history` write compatibility; legacy read/import belongs to Plan 005.
- Arbor wire replication over the same iCloud-authored subtree.
- Shared SQLite journals or any other multi-device shared-write database.
- Production multi-user cloud hosting or account sync.
- Opportunistic edits to Hunch's storage engine.

## Git workflow

- Branch: `codex/arbor-icloud-v1`.
- Commit spec/fixtures before either implementation.
- Commit pure Swift and TypeScript engines separately, then provider/app wiring.
- Do not enable a real dual-writer folder until the shared gate passes in both
  languages.

## Steps

### Step 1: Freeze the semantic spec and encoding

Write `spec/icloud.md` with the namespace, schema, canonical encoding, append and
fsync/coordinated-write requirements, causal fold, materialization frontier,
external-change classification, move/trash repair, retention/compaction, and
exclusion rules. Update `spec/format.md` to make this the one explicit exception
that allows `.arbor/icloud/v1` to travel through an iCloud/File Provider while
remaining outside authored Arbor content and wire publication.

Choose the encoding by testing actual append/decoding behavior in Swift and
TypeScript. Prefer a streaming, tail-readable, forward-compatible representation
with bounded record sizes. Unknown record kinds may be skipped only when the
version rules say doing so is safe; malformed required fields must not become an
empty record.

Include compaction policy: a writer may compact only its own log; compaction must
retain every snapshot/tombstone needed by Recover and produce a generation that
old readers either understand or safely ignore.

**Verify**: schema examples decode identically in both languages; invalid/truncated
records produce the specified result; no path is derived directly from raw
PageID/writer input.

### Step 2: Build shared conformance fixtures first

Fixtures contain initial page logs, tree logs, Markdown variants, file mtimes,
operations, delivery order, and expected logs/body/classification/recovery rows.
At minimum cover:

- local add and purge;
- observe-only external content;
- concurrent disjoint adds from two writers;
- equal counters resolved by writer ID;
- writer clock skew;
- same-writer log ahead of file after crash;
- foreign log/materialization before matching Markdown;
- matching Markdown before foreign log;
- missing authoritative add with a newer Markdown mtime (must restore);
- older purge against a newer external body (must not remove);
- peer purge arriving after its Markdown;
- merge of `NSFileVersion` alternatives;
- log tail growth, truncation, and corrupt final record;
- rename while open, move across directories, trash, restore, collision;
- implicit directory gaining identity before its first edit;
- more than 100 immediate children, complete virtual directory Markdown, first
  write materialization, and body-plus-child-set revision conflicts;
- placeholder/unavailable Markdown, journal, and asset artifacts;
- interrupted structural operation repaired on next mount;
- fold run twice reaches the same fixed point.

Create one root command that runs the TypeScript and Swift fixture consumers and
compares canonical results.

**Verify**: `bun run test:icloud-protocol` exits 0 before any app integration.

### Step 3: Implement the pure Swift journal/fold

Create `ArborCloud` without SwiftUI. Implement:

- writer identity and monotonic causal counter store;
- canonical encoding/decoding and safe path derivation;
- page intent fold with alive/observed/tombstoned state;
- parent-chain recovery forest and explicit unrestorable quarantine;
- materialization-frontier classification;
- tree-operation state machine and crash repair plan;
- watermark/tail/full-fold decisions as a disposable optimization;
- recovery queries and compaction of the current writer only.

Do not reuse Hunch's literal hashes unless the legacy importer requires them.
Fingerprint Arbor atomic source snapshots in a documented, fixture-locked way.

**Verify**: all shared fixtures and Swift-only property/idempotence tests pass;
running the fold twice produces no new operations.

### Step 4: Implement the TypeScript arbord profile

Implement the same state machine under the filesystem/arbord boundary. Keep
private workspace journal behavior for ordinary non-iCloud roots. Select the
iCloud profile only for an explicitly configured root; do not infer it from a
path substring.

Arbord remains the only first-party macOS writer. Its watcher classifies foreign
iCloud delivery as observed input. Mutation receipts remain REST v1 receipts;
the sidecar profile does not leak new lifecycle endpoints or private fields into
the client protocol. Its content path continues Plan 000's contract: accept
exact source guarded by `baseContentRevision`, parse it internally, and journal
the accepted semantic/source effects rather than trusting client-supplied
blocks.

**Verify**: unified fixtures pass byte-for-byte/canonically in both languages;
existing filesystem, REST, wire, and browser tests remain green.

### Step 5: Build coordinated Swift storage and the direct provider

Implement `ArborCloudWorkspaceProvider` for iOS and deliberate direct mode:

- acquire/persist user-selected security scope;
- accept exact `source` plus `baseContentRevision` as the direct provider's
  authored content mutation, parse it internally for validation, indexing,
  backlinks, rendering, and recovery, and expose the exact accepted source in
  the response; never accept a client-authored parsed block array;
- implement Plan 000's complete directory Markdown contract over coordinated
  files: first eligible standalone link per immediate child, unmatched children
  appended by canonical logical-path UTF-8 byte order, no file creation on read,
  complete materialization on first write, and no managed-link annotation
  syntax; apply the same directory-backed collection/virtual-child boundary;
- guard directory-document writes with a revision covering both stored body and
  immediate-child membership using Plan 000's exact
  `contentRevision`/`baseContentRevision` semantics, so a delivered, removed, or
  renamed child cannot be lost by a stale whole-document save;
- use `NSFileCoordinator` for reads, atomic replacement, moves, and Trash;
- install presenters for the body, PageID journal directory, tree-operation log,
  and referenced assets/containing directory as needed;
- coalesce bursts but retain a sticky sync generation that reruns after local
  save/reconcile;
- flush every admitted local generation before classifying disk state;
- generation-guard every external reload;
- expose unavailable/downloading/downloaded/error materialization states and a
  user-triggered retry/download path where File Provider supports it;
- merge `NSFileVersion` conflicts before marking alternatives resolved;
- update the same canonical document in place or surface conflict;
- terminally drain sessions before releasing bookmarks/provider ownership.

Key coordinators by `(tree, PageID)`, not URL. A move changes locator metadata
without remounting the editor or moving recovery history.

**Verify**: local provider tests run Plan 000's shared exact-source,
server-owned-parse, complete-directory, and UTF-8-order fixtures and simulate
presenter ordering, local edits during reload, a child delivered/removed/renamed
between read/write, enumeration reorder, unavailable artifacts, conflict
variants, app backgrounding, and process restart. No deterministic test uses a
fixed sleep as its correctness oracle.

### Step 6: Add recovery and sync state to TreeHopper

Expose compact state derived from provider truth:

- pending/durable/error local generation;
- body, journal, tree-operation, and asset materialization;
- pending peer frontier;
- externally changed/conflicted/restored state;
- Recover results scoped to current document or tree.

Manual restore writes ordinary authored intent through the same coordinator;
purge is explicit and remains recoverable according to retention policy. Never
surface `.arbor` paths or raw protocol records as ordinary browser nodes.

**Verify**: UI tests prove a restored block, pending peer state, conflict,
unavailable file, and failed flush are visible and actionable without exposing
private sidecars.

### Step 7: Qualify with real File Provider/iCloud delivery

Keep deterministic tests as the primary regression suite, then use two signed
installations/devices against an isolated test folder. Exercise:

- macOS arbord ↔ iOS 27 Swift provider;
- foreground/background and force-quit after the last keystroke;
- offline edits on both devices, then reconnect;
- disjoint simultaneous edits;
- delete/purge versus a stale open editor;
- rename/move/trash/restore while the other device is offline;
- body, log, or asset delivered as an iCloud placeholder;
- journal before body and body before journal;
- conflict versions and large/slow folder materialization.

Capture expected/actual file deliveries and final hashes without copying user
content into logs. A manual green run is required for release but does not
replace shared fixtures.

## Test plan

- Pure deterministic fixtures in both languages are the protocol authority.
- Swift coordinator tests model Hunch's immediate enqueue/flush, ordered
  coalescing, canonical document, terminal drain, and peer-before-body cases.
- File-store tests cover traversal, extension sanitization, placeholders,
  coordinated replacement, and asset readiness.
- Failure injection occurs after journal append, materialization record, body
  write, tree-operation prepare, filesystem move, and operation completion.
- Real iCloud qualification runs on an isolated non-user folder with macOS and
  the installed iOS 27 device/simulator environment available to the operator.

## Done criteria

- [ ] `spec/icloud.md` and `spec/format.md` define a versioned private profile
      and explicit exclusion from Arbor content/wire/publication.
- [ ] One root command runs identical Swift/TypeScript conformance fixtures.
- [ ] Each writer writes only its own append-only files.
- [ ] Log/materialization intent is durable before Markdown.
- [ ] Missing authoritative adds restore regardless of newer Markdown mtime;
      only older purge removal is gated.
- [ ] Foreign log-before-body state waits for matching materialization.
- [ ] Same-writer log-ahead crashes replay.
- [ ] External and merged content produces observe, not authored add.
- [ ] Page moves do not move PageID-keyed recovery history.
- [ ] Swift coordinators are PageID-keyed and generation-guard external reloads.
- [ ] The direct provider matches arbord on complete directory Markdown, first
      write materialization, duplicate promotion, and child-set conflicts.
- [ ] Arbord and the direct provider accept the same exact-source request,
      reject stale `baseContentRevision` before durable effects, derive semantic
      services from their own parse, and return the exact accepted source.
- [ ] Assets and placeholders participate in readiness/status.
- [ ] Arbord and Swift agree on every fixture and do not coauthor macOS state.
- [ ] Real macOS/iOS iCloud qualification passes the documented matrix.
- [ ] `advisor-plans/README.md` marks Plan 004 DONE.

## STOP conditions

- The chosen encoding cannot be appended/tail-read safely by both languages.
- Any synced file has more than one first-party writer.
- A design uses wall clock to decide authored intent.
- A receiver applies foreign journal placement before matching body materializes.
- A move requires relocating recovery history by path.
- A placeholder is parsed as empty content or treated as deletion.
- Hunch and TreeHopper would share a writer ID.
- Arbord wire and iCloud would symmetrically replicate the same subtree.
- The real-provider matrix cannot distinguish delivery delay from permanent
  failure; add observability before proceeding.

## Maintenance notes

The format may evolve, but its semantic fixtures are the compatibility promise.
Local watermarks and indexes are not part of that promise. If a later platform
can run arbord directly, it may replace the Swift provider, but migration must
preserve writer separation and journal fold results rather than silently
starting a second authority.
