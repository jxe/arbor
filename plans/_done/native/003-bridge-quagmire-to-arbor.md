# Plan 003: Connect Quagmire to exact Arbor source through a thin host

> **Final status: REJECTED — superseded by Plans 012 and 016.** The useful thin-host decisions were carried forward under the Arbor identity. Preserve this file as historical evidence; do not execute it.

> **Executor instructions**: Integrate the exact published Quagmire 0.1 into
> the TreeHopper foundation from Plan 002. The implemented foundation already
> makes Arbor's authored mutation exact Markdown source plus
> `baseContentRevision` and specifies Quagmire's stable `BlockID` lifecycle.
> Implement a TreeHopper `EditorHost`, a private block-granular Markdown
> codec/source ledger, session admission, references, mentions, and
> document-link actions. Do not create `ArborDocumentAdapter`, put source snapshots/ranges/handles in
> Quagmire, send `ArborBlock[]` as authored data, or modify Quagmire 0.1.
>
> **Drift checks (run first)**:
>
> ```sh
> # Substitute exact completion commits recorded by Plans 001-002.
> git diff --stat <PLAN002_ARBOR_SHA>..HEAD -- \
>   native packages/core/src packages/editor/src packages/client/src \
>   spec/02-directory-format.md docs/client.md docs/arbord-api.md conformance tests \
>   plans/native/README.md docs/client.md
> git -C /Users/joe/src/hunch diff --stat <PLAN001_HUNCH_SHA>..HEAD -- \
>   project.yml Hunch.xcodeproj App/Sources App/Tests
> ```
>
> Confirm the resolved remote dependency is exactly Quagmire 0.1.0 from Plan
> 001. Stop on source-write, identity-lifecycle, provider, or session-topology
> drift; do not repair those earlier contracts inside this integration plan.

## Status

- **Priority**: P1
- **Effort**: L–XL
- **Risk**: HIGH
- **Depends on**: Plans 001 and 002 plus the implemented foundation in `plans/records/history.md`
- **Category**: architecture
- **Planned at**: Arbor `84fc705`, Hunch `4c35f37`, 2026-08-18
- **Reconciled**: 2026-08-19 after foundation completion

## Why this matters

Arbor and Quagmire now meet at a deliberately small seam. Arbor supplies exact
operational Markdown, a derived parse, and optimistic revisions; it accepts
exact source back. Quagmire supplies a mutable block tree with stable editor
identity, undo/selection, one document-link row, H1-H6, a raw fallback, and a
synchronous commit notification. TreeHopper needs only a host-owned translation
and source-reuse ledger, not a second canonical document model.

The source ledger is simple because Quagmire IDs are reliable. It maps each
`BlockID` to a private opaque source record and original semantic block. If the
current block still equals that baseline and remains at a compatible nesting
depth, the host reuses the referenced source exactly. Otherwise it serializes
that block canonically. Quagmire never sees the record, and Arbor never sees the
Quagmire ID.

## Required preconditions

Verify these live before creating integration code:

- Every directory-backed `NodeSnapshot.document` contains authoritative exact
  operational `source`, including implicit child links, with no client
  projection manifest.
- `writeMarkdown` accepts `source` plus `baseContentRevision`; it accepts no
  client `blocks` or `frontmatterPatch`. The confirming node response contains
  exact accepted authoritative source and the new revision.
- Arbord parses source internally for recovery, search, backlinks, render,
  validation, and hosted output. Parsed blocks in a read response are derived
  convenience and never authored identity.
- Same-directory link reorder is a source write; physical move has no source
  placement/anchor fields.
- Quagmire 0.1 exposes one neutral `documentLink`, H1-H6, raw fallback,
  synchronous `persistCommit`, asynchronous `flush`, and the complete
  implemented block-identity matrix. No `.subpage` or source-provenance API
  remains.
- Hunch passes all former subpage behavior through exact remote Quagmire 0.1.
- TreeHopper has `WorkspaceProvider`, `WorkspaceDocumentSession`, one
  coordinator stream per scope-qualified PageID, tab leases, browser surfaces,
  an in-memory provider, and supervised read-only arbord access.

If any precondition is false, stop and return to the owning earlier plan.

## Integration contract

These rules are binding:

1. `TreeHopperQuagmire` may depend on Quagmire and TreeHopperKit. Quagmire never
   imports Arbor/TreeHopper, and provider/session code never imports Quagmire.
2. The TreeHopper host constructs Quagmire blocks with host-supplied `BlockID`s.
   The IDs are editor identity only; do not derive storage identity from them or
   transmit them to arbord.
3. A private `MarkdownSourceLedger` is keyed by `BlockID`. Each record contains
   the original semantic atomic block, original structural depth/context, and
   an opaque handle understood only by the host codec. The handle may be a
   parser token, source-fragment key, range, or derived Arbor parse ID. Do not
   expose or standardize its representation.
4. The ledger does not track moving byte offsets. Reorder changes output order,
   not the original record. Rebase replaces records after an accepted write or
   authoritative external snapshot.
5. Serialization is block-granular. Reuse exact source for an unchanged block at
   a compatible depth; canonically serialize edited/new blocks and blocks whose
   nesting syntax must change. Preserve the document envelope/frontmatter and
   raw blocks exactly unless directly edited. Do not promise token-level
   delimiter preservation inside an edited structured block.
6. The codec returns both complete source and the records/handles corresponding
   to that emitted source. Only after the provider accepts the generation may
   the session rebase the ledger. Failed/conflicted writes keep the prior base
   and submitted generation available for retry/compare.
7. A provider response that adds mandatory directory-child links or an external
   snapshot is authoritative. Reparse it and reconcile existing `BlockID`s only
   where semantic/source matching is unique. Ambiguous/new blocks receive fresh
   IDs. Apply through Quagmire system replacement without authored undo; losing
   selection is safer than assigning an old ID to the wrong block.
8. The host resolves a document-link `referenceID` with full current document
   scope. Prefer the exact authored link destination as the opaque reference
   when safe; otherwise use a session token backed by an ephemeral resolution
   cache. Do not persist a parallel reference table or containment metadata.
9. A `persistCommit` callback must synchronously serialize/admit the complete
   post-commit source generation before returning. `flush` awaits every
   admitted generation; asynchronous task creation may happen only after
   admission.
10. Links remain references, never ownership. Link deletion is a source edit;
    physical create/move/Trash remains an explicit provider operation with the
    failure boundaries below.

## Current state and evidence

- Arbor now returns authoritative complete source while parsed block fragments
  and parse IDs remain read-only conveniences. Verify that live contract before
  integration rather than reopening the protocol here.
- `packages/editor/src/markdown.ts:325-441` demonstrates the intended
  block-granular idea: unchanged fingerprints reuse original source while
  changed blocks serialize canonically. The Swift host matches the semantic
  contract, not TypeScript implementation details.
- Quagmire `Model/BlockID.swift:3-8` is an opaque immutable UUID.
  `Model/Block.swift:49-57` accepts a supplied ID, and `withFreshIDs()` renews
  copies recursively. The foundation lifecycle tests must still pass.
- Quagmire `Document.transaction` emits pre/post semantic changes through one
  commit point. `EditorHost.persistCommit(changes:in:)` is synchronous and
  `flush(_:)` awaits host-owned durability.
- Quagmire system replacement accepts caller-built blocks, clears invalid undo,
  and revalidates editor state. It is the external/canonical response boundary.
- Hunch's parser/serializer proves the editor can remain storage-neutral, but
  TreeHopper must follow Arbor's block-granular source contract rather than copy
  Clamshell formats or recovery stamps.
- Hunch's cross-document flows preserve destination before source: create
  before replacement, append before move-source removal, and parent flush before
  Trash. Reimplement those invariants through workspace sessions.

## Target package boundary

```text
TreeHopperApp
  editor surface, banners, pickers, commands, browser UI
        │
        ▼
TreeHopperQuagmire
  TreeHopperEditorHost
  MarkdownBlockCodec + private MarkdownSourceLedger
  DocumentReferenceResolver / ephemeral cache
        │
        ├── Quagmire 0.1 (blocks, identity, UI, undo; no source knowledge)
        │
        ▼
TreeHopperKit
  WorkspaceDocumentSession / WorkspaceCoordinator / providers
        │
        └── ArborClient ── arbord (exact source + revision)
```

There is no `ArborDocumentAdapter` and no second canonical document. The codec
and ledger are private implementation details of the TreeHopper host target.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Exact dependency | inspect `native/project.yml` and resolved packages | Quagmire resolves exactly 0.1.0; no override/revision pin |
| Arbor client | `swift test --package-path native/Packages/ArborClient` | all exact-source protocol tests pass |
| TreeHopperKit | `swift test --package-path native/Packages/TreeHopperKit` | provider/session tests pass |
| Host bridge | `swift test --package-path native/Packages/TreeHopperQuagmire` | codec/ledger/reference/host tests pass |
| Protocol | `bun run test:protocol` | TypeScript/Swift exact-source conformance passes |
| Root checks | run `bun run typecheck`, `bun test`, `bun run test:protocol`, `bun run build`, and `bun run test:e2e` sequentially | each exits 0 |
| macOS tests | `xcodebuild test -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=macOS' -derivedDataPath /tmp/treehopper-bridge-macos CODE_SIGNING_ALLOWED=NO` | exit 0 |
| iOS build | `xcodebuild build-for-testing -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/treehopper-bridge-ios CODE_SIGNING_ALLOWED=NO` | exit 0 on the existing iOS 27 simulator |
| Hunch compatibility | run the Plan 001 remote-package gates | all pass against unchanged 0.1.0 |
| Forbidden architecture | `rg -n 'ArborDocumentAdapter|SourceSnapshot|BlockSourceRange|BlockSourceReference|MarkdownSourceHandle' native/Packages/TreeHopperQuagmire /Users/joe/src/hunch/Packages/Quagmire/Sources` | no public source-provenance architecture type in either package; the host's private ledger types may be explicitly allowlisted only inside `TreeHopperQuagmire` internals |
| Diff check | `git diff --check` | no output |

Run Xcode commands sequentially.

## Scope

**In scope**:

- `native/Packages/TreeHopperQuagmire/` and focused tests/fixtures.
- `native/Packages/TreeHopperKit/` session/provider additions required for
  source editing, authoritative response, and reference actions.
- `native/App/` editor surface, `EditorHost`, pickers, errors/conflicts, and
  focused tests.
- Focused `ArborClient` consumption fixes only when it fails to expose the
  implemented exact-source contract already present on the wire.
- `plans/native/README.md`, `docs/client.md`, and debt/history updates describing
  behavior actually verified here.

**Out of scope**:

- Arbor protocol/server/provider/web redesign; the implemented foundation owns that contract.
- Any Quagmire or Hunch source/API change; exact Quagmire 0.1 is an input.
- `ArborDocumentAdapter`, a second canonical document model, a moving-range
  tracker, token-level inline preservation, or persisted source/reference map.
- Source snapshots, source ranges, opaque source handles, Arbor types, or
  Markdown codecs in Quagmire.
- Client-supplied `ArborBlock[]`, managed projection, structural index order,
  persisted managed annotations, or a second document-link row.
- Direct Swift/iCloud journal behavior (Plan 004).
- Voice, complete product parity, or real Hunch import (Plan 005).

## Git workflow

- Arbor branch: `codex/treehopper-exact-source-host`.
- Keep codec/ledger, session admission, references/mentions, document-link
  actions, and UI integration as separate reviewable commits.
- Do not modify or retag Quagmire 0.1.0. A package defect is a STOP condition
  requiring an explicit release decision.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Characterize host mapping and block-granular fidelity

Create a shared fixture corpus for:

- every Quagmire block/mark and H1-H6 nesting;
- raw footnotes, inline/display LaTeX, HTML, unknown extensions, and mixed
  raw/structured blocks;
- frontmatter order/comments/quoting, CRLF, whitespace, delimiter variants,
  hard breaks, and unknown fields;
- stored and implicit complete directory source;
- standalone child, duplicate, inline, non-child, cross-tree, stale-path,
  PageID-healed, broken, read-only, and historical links;
- reorder at the same depth, reparent/indent requiring canonical regeneration,
  split, merge, paste, duplicate, and undo/redo; and
- provider responses that add a mandatory child link.

For each fixture define exact no-op output, exact unchanged-block output after
reorder, and canonical expected source for edited/new/depth-changed blocks. Do
not assert preservation of Markdown delimiters inside a block that was edited.

**Verify**: characterization tests fail before implementation and demonstrate
that exact Quagmire 0.1 IDs survive every required editor operation. If the
model cannot express a fixture, stop rather than modifying the package here.

### Step 2: Implement the private Markdown codec and source ledger

Inside `TreeHopperQuagmire`, map authoritative Arbor source/derived parse to
Quagmire blocks with fresh host-supplied IDs. Build an internal ledger keyed by
those IDs. Keep exact envelope/trivia ownership explicit so no-op assembly is
byte-identical and no source bytes are accidentally dropped or duplicated.

The ledger's handle type is private. Store the original atomic semantic block
and depth/context beside it. Serialization walks current Quagmire order:

- reuse the source record when semantic value and compatible context match;
- canonically emit edited/new/depth-changed blocks;
- always reuse unchanged raw blocks;
- emit exact frontmatter/envelope unless an explicit source action changed it;
- return complete source and a rebased record set for that output.

Do not attach the records to Quagmire `Block`, teach Quagmire about source, or
write Quagmire IDs into Markdown. Editing a document-link label regenerates
that block using its unchanged authored destination; resolved target title and
metadata never enter source.

**Verify**: parse/map/assemble no-op is byte-identical; same-depth move reuses
exact fragments; one edited block alone canonicalizes; raw/envelope source is
exact; split/merge/indent cases match declared output; no forbidden type exists.

### Step 3: Admit exact-source generations synchronously

Connect `persistCommit` to codec serialization and
`WorkspaceDocumentSession.enqueue` synchronously. Before returning, capture the
complete source, `baseContentRevision`, ledger candidate, and incrementing
generation. Spawn asynchronous work only after admission.

On success, install the returned authoritative source/revision and rebase the
ledger. If mandatory directory completion changes source, reparse and reconcile
IDs conservatively before system replacement. On conflict/failure, retain local
source, prior base, submitted generation, and candidate ledger for visible
compare/retry. `flush` awaits every admitted generation.

Use one stream per `(tree, PageID)` with canonical path fallback only for nodes
without durable identity. Duplicate tabs share canonical content/write order
but keep independent selection, scroll, and history.

**Verify**: deterministic tests cover commit-then-immediate-flush, coalescing,
duplicate tabs, accepted rebase, mandatory-link response, external update,
conflict, retry, provider failure, and terminal drain.

### Step 4: Implement mentions and scoped reference resolution

Provider search supplies title, parent path, kind, tree/provenance, access, and
materialization. Omit only candidates for which no safe canonical link can be
built; read-only targets remain linkable.

Keep Quagmire's contextual rule:

- inline `@` inserts an ordinary canonical Markdown link;
- line-leading `@` inserts the one `documentLink` row;
- neither form creates, adopts, moves, or owns the target; and
- arbord independently recognizes the first standalone immediate-child link as
  index placement.

Resolve `referenceID` relative to the current full workspace reference. Use the
authored destination itself where safe; otherwise use a session token and an
ephemeral cache. Never persist an auxiliary reference table. A stale readable
path plus valid PageID resolves by ID; healing requires an explicit source edit.

**Verify**: tests cover same/cross-tree, duplicate title, inline/line-leading,
read-only, broken, unavailable, stale path/PageID, copy/paste, non-child, and
cache rebuild after authoritative replacement.

### Step 5: Reimplement the complete Hunch document-link interaction set

Full capability requires a resolved `WorkspaceDocumentSession`, whether its
Markdown is stored or implicit. Authority/materialization/protected-boundary
state may narrow mutation actions. Revalidate before invocation and after awaits.

| Existing Hunch action | TreeHopper implementation | Failure boundary |
|---|---|---|
| Open/missing display | Navigate with full tree scope; show missing/unavailable honestly. | Failed resolution does not alter history. |
| Edit row label | Edit only the authored label; codec retains destination. | Read-only source omits editing; target is untouched. |
| Set icon | Edit leading emoji of target first H1 through its session. | Refuse before target write; implicit success materializes complete source. |
| Turn block into document | Durably create/initialize target, then replace source block with its link. | Failed create leaves source unchanged; later failure may leave a recoverable extra target. |
| Delete row/orphan prompt | Flush link deletion, query fresh backlinks, then separately offer writable target Trash. A sole child link reappears by directory completeness; explain that Trash removes the child. | Never automatic Trash. |
| Drop/copy onto row | Append/flush destination first; move removes source only after success. | Failed destination leaves source exact. |
| Move-to picker | Offer writable document sessions and legal in-document targets; revalidate choice. | Stale destination stops before source removal. |
| Inline then Trash | Validate, load complete target, replace, flush parent, then Trash target. | Preflight leaves parent exact; Trash failure leaves both copies. |
| Copy/append link | Serialize a canonical ordinary Markdown link. | Failed resolve/build changes neither document. |

Do not infer physical containment from a row action except the separately
confirmed provider create/move/Trash operations above.

**Verify**: run every action against stored, implicit, read-only, historical,
placeholder, missing, non-document, cross-tree, protected, and authority-revoked
targets. Failure injection proves destination-before-source ordering.

### Step 6: Install the editor surface and run exact-package parity

Install `TreeHopperEditorHost` in the document surface. Keep browser chrome,
tabs, sidebar, and non-document surfaces outside Quagmire. Disable editor
commands when the current surface lacks a document session. Surface pending
save, conflict, retry, materialization, missing reference, and interrupted
action states through native UI.

Run TreeHopper builds/tests and rerun Quagmire/Hunch remote-package gates
without changing the tag. Update docs/history only for verified behavior.

**Verify**: all command-table gates pass; Quagmire 0.1 remains unchanged;
Hunch retains its behavior; TreeHopper edits stored and implicit documents with
exact-source writes and the declared block-granular fidelity.

## Test plan

- Fixture-driven host codec and private-ledger tests.
- No-op, same-depth reorder, edited-block, depth-change, split/merge, raw, and
  envelope fidelity tests.
- `BlockID` ledger/rebase and conservative external-replacement tests.
- Source-generation admission/flush/conflict/duplicate-tab tests.
- Scoped reference and mention tests.
- Complete action-matrix failure injection for stored/implicit documents.
- App smoke/UI tests for command routing and persistence banners.
- Unchanged Quagmire/Hunch 0.1 compatibility matrix.

## Done criteria

- [ ] Exact published Quagmire 0.1 is consumed without source changes.
- [ ] TreeHopper writes exact Markdown source plus `baseContentRevision`; it
      never authors `ArborBlock[]`.
- [ ] No-op source, envelope, raw blocks, and unchanged structured blocks are
      byte-identical; edited/new/depth-changed blocks alone may canonicalize.
- [ ] The private ledger is keyed by stable `BlockID` and uses an unexposed
      host-only source handle.
- [ ] No `ArborDocumentAdapter`, moving-range tracker, persisted reference table,
      or source-provenance API in Quagmire exists.
- [ ] Accepted responses rebase the ledger; failed/conflicted generations do not.
- [ ] Provider external/completeness responses use conservative ID reconciliation
      and system replacement without authored undo.
- [ ] A generation is admitted before `persistCommit` returns; immediate `flush`
      awaits it.
- [ ] Duplicate tabs share a write stream and retain independent UI state.
- [ ] Mentions use contextual two-form insertion without implying containment.
- [ ] Stored and implicit documents receive the same actions when authority allows.
- [ ] Link deletion never automatically trashes a target.
- [ ] Cross-document failures always leave a complete source or destination.
- [ ] TreeHopper and unchanged Hunch pass against exact Quagmire 0.1.
- [ ] `plans/native/execution.md` marks Plan 003 DONE.

## STOP conditions

- Any implemented-foundation, Plan 001, or Plan 002 precondition is false.
- Exact no-op/block-granular fidelity requires changing Quagmire or persisting IDs.
- The host needs moving source ranges rather than an immutable opaque record.
- The integration needs Arbor protocol/storage types inside Quagmire.
- A client-side synthetic projection or structural index-order API reappears.
- `persistCommit` cannot synchronously admit complete source.
- Stored and implicit Markdown require different row behavior.
- A document-link workflow has a failure point with no complete durable copy.
- Integration appears to require retagging 0.1 or another Quagmire release.

## Maintenance notes

Arbor owns accepted source and revisions. Quagmire owns editor behavior and
stable IDs. `TreeHopperQuagmire` owns only the private Markdown codec/ledger and
host actions. Keep those authorities separate. Plan 004 adds the direct Swift
provider using the same exact-source and session fixtures; it must not fork the
host codec or send parsed blocks. Plan 005 adds broader parity and migration
only after this bridge and cloud durability are independently proven.
