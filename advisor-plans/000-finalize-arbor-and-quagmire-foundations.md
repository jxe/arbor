# Plan 000: Finalize Arbor source writes and Quagmire's first public API

> **Executor instructions**: Complete both foundation tracks before publishing
> Quagmire or scaffolding TreeHopper. Track A replaces Arbor's client-composed
> directory projection with provider-owned complete Markdown and makes exact
> Markdown source—not a client-supplied block array—the authored content
> mutation. Track B replaces Quagmire's Hunch-specific subpage row with one
> neutral document-link row, completes its Markdown-shaped block vocabulary,
> and makes block identity reliable enough for a host-owned source ledger.
> Quagmire must remain format-neutral: do not add Markdown parsing, source
> snapshots, source ranges, or opaque source handles to its API. Migrate Hunch
> while Quagmire is still local. Both tracks must pass before Plan 001. Do not
> extract, tag, publish, or remotely consume Quagmire here.
>
> **Drift checks (run first)**:
>
> ```sh
> git diff --stat 84fc705..HEAD -- \
>   README.md docs/reference-implementation.md docs/treehopper.md \
>   plan/native.md plan/roadmap.md plan/editor-todo.md plan/technical-debt.md \
>   spec/format.md spec/client.md spec/arbord-rest.md spec/wire.md spec/fixtures \
>   packages/core/src packages/editor/src packages/fs/src packages/arbord/src \
>   packages/client/src packages/render/src packages/stores/src packages/wire/src \
>   native/Packages/ArborClient tests
> git -C /Users/joe/src/hunch diff --stat 4c35f37..HEAD -- \
>   Packages/Quagmire App/Sources/WorkspaceWindow+EditorHost.swift \
>   App/Sources/Clamshell App/Tests/HunchUnitTests project.yml Hunch.xcodeproj
> ```
>
> Stop if Arbor has adopted another directory-document or content-write
> contract, Quagmire has already been extracted/published, or Hunch no longer
> consumes the local package at `Packages/Quagmire`.

## Status

- **Overall**: IN PROGRESS — Arbor track DONE; Quagmire/Hunch track TODO in `/Users/joe/src/hunch/plans/quagmire-0.1-foundation.md`
- **Arbor track**: DONE on 2026-08-18 in the exact-source/complete-directory commit containing this plan update
- **Quagmire/Hunch track**: TODO; execute and record its Hunch commit before marking Plan 000 DONE
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: none
- **Category**: architecture
- **Planned at**: Arbor `84fc705`, Hunch `4c35f37`, 2026-08-18

## Why this matters

The first public Quagmire release should already contain the neutral API and
identity guarantees needed by Hunch and TreeHopper. TreeHopper should likewise
never be founded against Arbor's obsolete synthetic-row protocol or a content
API that treats a client-produced `ArborBlock[]` as authored truth. Markdown is
the portable authority: clients submit exact source guarded by
`baseContentRevision`, and arbord parses that source internally for every
semantic service.

This absorbs the work previously described as Quagmire 0.2. There is no
separate 0.2 migration milestone: the first published 0.1 already has the
neutral row, H1-H6, raw fallback, stable block-identity lifecycle, and the
corresponding Hunch implementation.

The tracks remain independent. Arbor does not import Quagmire. Quagmire does
not import Arbor, Markdown, or storage concepts. The later TreeHopper host can
key a private source ledger by Quagmire `BlockID`, but that ledger and its
opaque source handles are not Quagmire API.

## Decided Arbor source and directory-document contract

These are requirements, not executor choices:

1. Every directory-backed logical node has one operational Markdown document,
   even when no body file exists. This includes the About/index facet of a
   directory-backed collection, but excludes collection rows, virtual tables,
   database records, mounted boundaries, and other non-physical query results.
2. `NodeSnapshot.document.source` is the exact authoritative operational
   Markdown source, including frontmatter. A returned parsed block/frontmatter
   view is derived convenience only. `ArborBlock.id`, `source`, and
   `sourceHash` are parse aids, not durable authored identity and never the
   authored write payload.
3. The first eligible standalone link resolving to each immediate physical
   child owns that child's index placement. Inline links never qualify. Later
   standalone links to the same child are ordinary duplicates; deleting the
   first promotes the next.
4. Append a normal standalone link for every otherwise-unmentioned child. Sort
   unmatched children by unsigned lexicographic UTF-8 bytes of canonical
   logical child path. Never use locale comparison or filesystem enumeration
   order. Do not annotate managed links or add special persisted syntax.
5. Reading, rendering, searching, serving, or indexing an implicit document
   creates no file. Its first authored write materializes the complete
   operational source. Reuse sibling `x.md` when present; otherwise use
   `x/_index.md`.
6. The sole ordinary authored content mutation is
   `writeMarkdown { ref, baseContentRevision, source }`. Remove client-supplied
   `blocks` and `frontmatterPatch` from that operation in REST, TypeScript,
   Swift, fixtures, browser callers, and direct provider APIs. The corresponding
   create operation accepts optional exact `source`, defaulting to empty.
7. Arbord parses submitted source internally before durable commit and uses the
   resulting server-owned parse for validation, journal/recovery effects,
   search, backlinks, rendering, hosted output, and subsequent reads. Unknown
   but legal Markdown is retained as raw source rather than rejected or
   normalized. A client cannot influence semantic services by supplying a
   forged parsed block view.
8. For an ordinary stored Markdown document, accepted source bytes persist
   exactly. For a directory-backed document, the provider may add only the
   missing immediate-child links mandated by rules 3–4; it must preserve all
   submitted syntax and return the exact accepted operational source. The
   response, not the pre-completeness request, becomes the client's new base.
9. Keep the wire names `contentRevision` and `baseContentRevision`. For a
   directory-backed node, the opaque revision covers exact stored body bytes
   plus a canonically sorted descriptor of every immediate physical child:
   durable identity when present, canonical logical path, and kind. Add,
   remove, rename, identity, or kind changes invalidate it; enumeration reorder
   does not. Do not introduce `indexRevision`.
10. Link ordering, nesting, labels, and deletion are source edits. Physical
    create/move/rename/copy/Trash/restore remain explicit structural operations.
    Link deletion never automatically trashes the target.
11. Retire `move.placement`, `move.beforePath`, and `move.beforeBlockID` from
    REST, TypeScript, Swift, fixtures, and callers. A physical move names sources
    and a destination container. Exact index placement is a subsequent source
    write; Arbor has only one index-ordering API.
12. Source editing, rendered pages, search, backlinks, local/hosted
    `Accept: text/markdown`, recovery, and future exports consume the same
    operational source or a fresh server-owned parse of it. Literal stored-body
    bytes may remain a private storage detail but are not the client contract.
13. The leading emoji of the first H1 is the portable document icon. Setting it
    is an exact-source mutation. If no H1 exists, prepend one using the node's
    display name without reordering later blocks. On an implicit directory this
    materializes the H1 and complete child-link set as one accepted source.
14. Client source preservation is block-granular in v1: an untouched document,
    document envelope, raw block, or structured block remains byte-identical; an
    edited/new block may be canonically regenerated in isolation. Reordering an
    unchanged block at a compatible nesting depth reuses its exact source. Do
    not require token-level preservation inside a block that the user edited.

## Decided Quagmire 0.1 contract

Quagmire and Hunch migrate together before extraction:

1. Quagmire has one `documentLink` row. Remove the `.subpage` model case,
   constructors, callback names, drop-target names, and public terminology. Do
   not retain a compatibility alias.
2. The row's authored/editor value is an `AttributedString` label plus an opaque
   host-defined `referenceID`. It contains no URL grammar, tree identity,
   containment, ownership, Trash policy, Arbor type, or source handle.
3. The host supplies ephemeral presentation: present/missing/unavailable state,
   optional resolved target title and icon, plus the fixed actions Quagmire
   already knows how to perform—edit authored label, open, edit target icon,
   receive moved/copied blocks, and inline-then-Trash. Availability is
   recomputed per reference and never serialized.
4. The authored label is the default visible value. Hunch may supply its current
   resolved-title display override and omit direct label editing so its behavior
   remains unchanged. A future Arbor host can display/edit the authored label.
5. Preserve the contextual mention rule. A line-leading mention creates the one
   standalone `documentLink` row; a mention inside text creates an inline link.
   The host supplies candidates and canonical URL. There is no three-way
   insertion API or `unavailable` insertion kind.
6. Extend `HeadingLevel`, containment, source representation, and rendering to
   H1-H6 without clamping. Creation/autotransform/Turn Into UI may remain H1-H3.
   Any Hunch import presentation policy belongs in Hunch, not the shared model.
7. Add one honest unsupported/raw block carrying an opaque exact string for
   constructs the host parser cannot represent structurally, including
   footnotes, LaTeX, HTML, and unknown extensions. It is read-only in ordinary
   block editing; no Turn Into, text edit, or drag transformation may silently
   normalize it. Quagmire does not decide that the string is Markdown.
8. Formalize the `BlockID` lifecycle. Host-supplied immutable IDs survive text
   and kind edits, reorder, same-document move, reparent, indent/outdent, undo,
   and redo. Splitting retains the original ID on the leading/original block and
   gives every new block a fresh ID. Merging retains the receiving block's ID.
   Duplicate, paste, and cross-document copy mint fresh IDs recursively.
   Cross-document move retains IDs only after destination admission succeeds and
   source removal completes. System replacement uses IDs supplied by the host.
9. Quagmire must not add source snapshots, byte ranges, source references,
   Markdown codecs, persisted block annotations, or a generic metadata bag.
   Stable IDs are sufficient: a host may privately map them to any opaque source
   record and compare current semantic blocks with its own baseline.
10. Preserve every Hunch subpage interaction on the new row: navigation and
    missing display, target-title/icon presentation, create/convert, deletion
    orphan prompt, inline-and-Trash, drop move/copy, move-to picker, mentions,
    link copy/paste, synchronous commit notification, and flush semantics.
11. Keep the existing safety order: create destination before replacing source;
    load before inline mutation; append destination before removing move source;
    flush inlined parent before Trash. Failures may leave a recoverable duplicate,
    never destroy the only copy.

## Starting state (Arbor portion now superseded)

- `spec/format.md:25-37` and `spec/client.md:20-30` currently make clients
  compose stored/implicit source plus managed/synthetic child rows. These
  projection rules are superseded.
- `packages/core/src/types.ts:29-44` defines `ArborBlock` with parse/source
  fields and a `MarkdownDocument` without one full authoritative source field.
  `packages/core/src/types.ts:109-113` makes writes carry parsed blocks.
- `packages/core/src/protocol.ts:163-168`, `spec/arbord-rest.md:181-188`, and
  `native/Packages/ArborClient/Sources/ArborClient/Protocol.swift` expose
  client-supplied blocks/frontmatter as content mutation input. These are
  superseded by exact `source` plus `baseContentRevision`.
- `packages/editor/src/markdown.ts:325-441` parses source and reuses
  `source`/`sourceHash` when serializing unchanged blocks. Keep this as an
  internal/server and web-host codec, not an authored wire representation.
- `packages/core/src/projection.ts`, `packages/client/src/index.ts`, and
  `native/Packages/ArborClient/Sources/ArborClient/Projection.swift`
  independently construct projected documents and managed-child manifests.
- `packages/render/src/PageEditor.tsx` filters synthetic rows before saving and
  translates row reorder into structural moves; both behaviors must disappear.
- `spec/arbord-rest.md:191-212` and `packages/core/src/protocol.ts:191-196`
  expose structural placement and Markdown anchors on `move`.
- Quagmire's `Model/BlockID.swift:3-8` already provides immutable UUID identity;
  `Model/Block.swift:46-57` accepts a host-supplied ID, and
  `Block.withFreshIDs()` recursively renews identity for copies. The lifecycle
  is not yet exhaustively specified or tested across every mutation.
- Quagmire's `Model/Block.swift:3-43` supports H1-H3 and
  `.subpage(title:pageID:)`; deeper headings clamp to H3.
- `EditorHost.swift` uses page/subpage vocabulary but correctly keeps storage
  outside the editor and makes only synchronous `persistCommit` plus async
  `flush` required. Preserve that boundary.
- Hunch's `WorkspaceWindow+EditorHost.swift` and Clamshell parser/serializer
  remain the compatibility harness for the row/API migration. Their Markdown
  responsibility must not move into Quagmire.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Arbor client | `swift test --package-path native/Packages/ArborClient` | all tests pass; live-server case may skip without a URL |
| Arbor protocol | `bun run test:protocol` | TypeScript/Swift exact-source fixtures and live conformance pass |
| Arbor checks | run `bun run typecheck`, `bun test`, `bun run test:protocol`, `bun run build`, and `bun run test:e2e` sequentially | each exits 0 |
| Quagmire package | `cd /Users/joe/src/hunch && Packages/Quagmire/scripts/verify.sh` | package tests and clean platform builds pass |
| Hunch macOS tests | `xcodebuild test -project /Users/joe/src/hunch/Hunch.xcodeproj -scheme Hunch -destination 'platform=macOS' -derivedDataPath /tmp/hunch-document-link-macos-tests CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Hunch macOS build | `xcodebuild build -project /Users/joe/src/hunch/Hunch.xcodeproj -scheme Hunch -destination 'platform=macOS' -derivedDataPath /tmp/hunch-document-link-macos-build CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Hunch iOS build | `xcodebuild build-for-testing -project /Users/joe/src/hunch/Hunch.xcodeproj -scheme Hunch -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/hunch-document-link-ios CODE_SIGNING_ALLOWED=NO` | exit 0 on the existing iOS 27 simulator |
| Stale Arbor write shape | `rg -n 'frontmatterPatch|writeMarkdown.*blocks|NodeWriteRequest.*blocks' packages native spec tests` | no active protocol/provider/client write shape uses parsed blocks or frontmatter patches; parser/internal recovery uses may be explicitly allowlisted |
| Stale row API | `rg -n '\.subpage|Subpage|pageID.*documentLink|intoSubpage' /Users/joe/src/hunch/Packages/Quagmire/Sources /Users/joe/src/hunch/App/Sources /Users/joe/src/hunch/Packages/Quagmire/Tests /Users/joe/src/hunch/App/Tests` | no stale model/API matches; migration-fixture prose may be explicitly allowlisted |
| Diff checks | run `git diff --check` in Arbor and Hunch | no output |

Run Xcode commands sequentially. Do not publish or tag Quagmire in this plan.

## Scope

**Arbor in scope**:

- The specs, docs, provider/filesystem, REST/core/client, Swift client, browser,
  indexer, recovery, wire/public host, fixtures, and tests named above.
- Exact-source reads/writes, server-owned parsing, complete-directory source,
  canonical child ordering, revisions, icon convention, semantic-reader
  cutover, and structural-move simplification.

**Quagmire/Hunch in scope**:

- `/Users/joe/src/hunch/Packages/Quagmire/` model, identity lifecycle,
  document-link host protocol, rows, interactions, tests, docs, and verifier.
- Hunch host/parser/serializer/link graph/recovery identity/search/reconciliation
  call sites and focused regressions required for the one-row migration.
- Hunch project regeneration only if public source/API changes require it.

**Out of scope**:

- Extracting Quagmire history, creating its GitHub repository, remote SwiftPM
  consumption, tags, or releases (Plan 001).
- TreeHopper app/package scaffolding (Plan 002).
- TreeHopper's Markdown parser/serializer, private source ledger, editor host,
  and native session integration (Plan 003).
- Any source snapshot/range/reference or Markdown dependency in Quagmire.
- Token-level preservation inside an edited structured block.
- Direct Swift/iCloud provider storage and journal semantics (Plan 004).
- Persisted managed-link or block-identity annotations.

## Git workflow

- Arbor branch: `codex/exact-source-directory-markdown`.
- Hunch branch: `codex/quagmire-document-link-identity`.
- Keep the complete Arbor contract/provider/client/browser cutover in one
  focused Arbor commit. Keep Quagmire row/model/identity work and the Hunch
  migration in a separate Hunch commit.
- Quagmire remains the local package during every Hunch gate. Do not create the
  remote repository or change package dependency mode here.
- Do not push, tag, or release unless separately instructed during execution.

## Steps

### Step 1: Freeze the exact-source and complete-directory specifications — DONE (Arbor)

Rewrite `spec/format.md`, `spec/client.md`, `spec/arbord-rest.md`, and
`spec/wire.md` with the fourteen Arbor rules above. Update `README.md`,
`docs/reference-implementation.md`, `docs/treehopper.md`, `plan/native.md`,
`plan/roadmap.md`, `plan/editor-todo.md`, and relevant debt/history records.

Define the public read document's authoritative `source` field and make any
parsed blocks explicitly derived/read-only. Define `writeMarkdown` as exactly
`ref`, mutation identity, `baseContentRevision`, and `source`; define
`createMarkdown` with optional source. Remove write-side blocks and
`frontmatterPatch`. Keep `directoryRevision` only for physical structure and
remove index-placement fields from `move`.

Replace projection/write fixtures with language-neutral vectors covering:

- exact source containing CRLF, comments, unusual frontmatter ordering,
  delimiter variants, unknown extensions, and hard breaks;
- rejection of stale `baseContentRevision` before any durable effect;
- rejection of obsolete block-array/frontmatter-patch request shapes;
- server parsing of submitted source for search, backlink, render, recovery,
  hosted Markdown, and validation results;
- empty/bodyless directory, stored prose, and sibling/index body choice;
- first standalone child link, earlier inline link, duplicates, and promotion;
- unmatched Unicode/case ordering and more than 100 children;
- child add/remove/rename conflicts and enumeration reorder as no-conflict;
- directory collections' physical children versus virtual rows;
- stored/implicit icon read and set; and
- absence of annotations and obsolete move placement.

**Verify**: shared TypeScript/Swift fixtures fail against the old shapes and
encode identical exact source, revisions, accepted-source responses, and errors.

### Step 2: Make the provider own complete operational source — DONE (Arbor)

Move the first-eligible-link algorithm into the filesystem/provider read path.
A directory-backed `NodeSnapshot.document` always contains authoritative
operational `source`; reads never materialize a file. Derive `contentRevision`
from stored bytes plus canonical immediate-child descriptors.

Change provider `writeMarkdown` to accept exact source and a base revision. For
ordinary Markdown, persist it byte-for-byte. For a directory document, add only
required missing-child links, materialize the resulting complete source, and
return that exact accepted source plus the new revision. A concurrent child
add/remove/rename conflicts rather than disappearing. Structural moves may heal
existing target URLs, but an ordinary source edit never infers physical intent.

**Verify**: filesystem tests prove no read materialization, exact ordinary-file
writes, bounded directory completion, deterministic ordering, first-write
materialization, and conflicts without partial files or journal effects.

### Step 3: Parse authored source only inside Arbor authorities — DONE (Arbor)

Change arbord REST validation, service/workspace layers, filesystem journal,
recovery, indexer, renderer, backlink/search extraction, hosted Markdown/HTML,
and wire publication to consume submitted or stored source through a fresh
server-owned parse. Do not accept client blocks as corroborating data.

Keep the parser total over arbitrary valid UTF-8 Markdown: unsupported syntax
becomes raw source and diagnostics rather than normalization or data loss.
Ensure the durable mutation record contains enough exact source/mutation data
to retry or replay without relying on a client parse.

**Verify**: REST/integration/E2E tests submit source whose forged equivalent
block representation would have differed; only server-parsed semantics appear
in search, backlinks, recovery, render, and hosted output. Ambiguous transport
retry with the same mutation ID remains idempotent.

### Step 4: Cut TypeScript, Swift, and web clients to source writes — DONE (Arbor)

Remove `ProjectedDocument`, `ManagedChildRow`, `managed:` IDs, hydration,
synthetic filtering, structural anchor translation, and all write-side block
payload construction. TypeScript and Swift consume complete returned source.

The web editor may continue using parsed blocks internally. Before mutation it
serializes its complete current editor state to exact/block-granular source and
sends that source. Same-directory child-link reorder sends `writeMarkdown`;
only physical create/move/rename/copy/Trash sends structural operations. A
provider response replaces the client's base source/revision without authored
undo.

**Verify**: protocol gates and browser E2E prove request JSON contains `source`
and no `blocks`/`frontmatterPatch`, unchanged source is byte-identical, an
edited block alone may canonicalize, and index-link reorder never calls move.

### Step 5: Replace Quagmire's subpage row and complete its block vocabulary — moved to Hunch plan

Introduce the one neutral document-link row and migrate every exhaustive
switch, renderer, layout/accessibility path, selection/reorder/drop flow, Turn
Into action, mention insertion, move destination, callback, preview, pasteboard
helper, test, and document.

Use neutral `documentLink`, `referenceID`, and presentation/action vocabulary.
Add H4-H6 without clamping while leaving creation menus at H1-H3. Add the raw
unsupported block as an opaque read-only string. Quagmire must not import a
Markdown parser or expose source provenance.

**Verify**: package tests cover labels, presentation, missing/unavailable state,
all action gates, mentions, drag/drop, Turn Into, H1-H6, raw fallback, and no
legacy row API or format-specific source API.

### Step 6: Specify and test Quagmire block identity lifecycle — moved to Hunch plan

Audit every Quagmire transformation against rule 8. Change only operations that
violate it. Add focused identity tests for typing, kind conversion, reorder,
reparent, indent/outdent, move, split, merge, undo/redo, duplicate, paste,
cross-document copy/move, deletion/recovery helpers, and system replacement.

Keep `BlockID` opaque and immutable. Do not add a second persistence ID or
generic metadata. Confirm public constructors accept caller-supplied IDs and
that system replacement preserves the IDs in supplied blocks while clearing
invalid undo state.

**Verify**: the identity matrix passes twice; stale-ID searches find no code
that silently remints IDs for an in-place edit or preserves them for a copy.

### Step 7: Migrate Hunch completely while Quagmire remains local — moved to Hunch plan

Update Hunch's host, parser, serializer, link graph, recovery identity, search,
reconciliation, tests, and UI state to the one row type. Map its opaque
relative-path/PageID token to `referenceID`; preserve its navigation, icon,
create, inline/Trash, drop, move-to, mention, copy/paste, and orphan behavior.

Retain Hunch's Markdown parsing/serialization responsibility and all existing
Clamshell durability semantics. Its parser supplies Quagmire IDs; its serializer
may key exact-source records by those IDs, but this plan does not require a new
general source ledger for Hunch. Preserve synchronous `persistCommit`/`flush`
and every duplicate-over-loss ordering boundary.

**Verify**: Quagmire verification plus Hunch macOS tests and sequential
macOS/iOS builds pass from local package resolution. The stale-row search has
no unallowlisted matches.

### Step 8: Run the combined release-candidate gate without publishing

Run every Arbor and Hunch/Quagmire command above from clean derived/test state.
Review both diffs for coupling: Arbor names must not enter Quagmire; Quagmire
must not enter Arbor packages; source handles/ranges must not enter Quagmire.

Record exact passing Arbor and Hunch commits in the completion note for Plan
001's extraction drift check. Leave Hunch on the local package dependency.

**Verify**: all commands pass twice where timing-sensitive; both diff checks
are clean; neither repository contains a new tag, remote package dependency, or
publication artifact.

## Test plan

- Shared TypeScript/Swift exact-source request/response and rejection fixtures.
- Filesystem/REST complete-directory and revision-conflict tests.
- Server-owned parse parity across search, backlinks, render, recovery, hosted
  output, and validation.
- Browser E2E for source payloads, arbitrary prose/link order, and source-only
  child-link reorder.
- Quagmire row, H1-H6, raw-block, and full identity-lifecycle matrices.
- Hunch regressions for every former subpage interaction and durability boundary.
- Stale API searches for block-array writes, projection types, and subpage names.

## Done criteria

- [x] Every directory-backed node exposes complete authoritative source.
- [x] `writeMarkdown` accepts exact `source` plus `baseContentRevision`; no
      public/provider/client write path accepts client-parsed blocks or
      `frontmatterPatch`.
- [x] Arbord alone parses submitted source for validation, recovery, search,
      backlinks, rendering, hosted output, and authoritative read models.
- [x] Ordinary stored source persists byte-for-byte; directory completion adds
      only mandated missing-child links and returns the accepted source.
- [x] `contentRevision` covers stored bytes plus canonical child descriptors.
- [x] Clients contain no synthetic projection or managed-child manifest.
- [x] Structural move contains no index-placement or Markdown-anchor fields.
- [ ] Quagmire has one neutral `documentLink`, H1-H6, and one raw fallback.
- [ ] Quagmire's identity matrix passes and matches rule 8.
- [ ] Quagmire contains no Arbor/Markdown source snapshot, range, handle, codec,
      annotation, or generic metadata API.
- [ ] Every existing Hunch subpage behavior passes on the new row.
- [ ] Hunch still consumes Quagmire locally; no release happened.
- [x] Arbor and Quagmire have no dependency on each other.
- [ ] `advisor-plans/README.md` marks Plan 000 DONE.

## STOP conditions

- Arbord cannot form complete source from a bounded, gap-free child snapshot.
- Exact-source writes cannot be made idempotent under mutation-ID retry.
- A semantic Arbor service would continue trusting client-parsed blocks.
- The revision fails add/remove/rename or enumeration-reorder control cases.
- A structural operation proves it must atomically control physical containment
  and source ordering; stop and specify that transaction explicitly.
- Quagmire identity lifecycle requires a source range/handle or persisted ID.
- Preserving Hunch behavior would require a second `.subpage` row.
- Any cross-document workflow can delete the only durable copy.
- Any step requires extracting, tagging, or consuming Quagmire remotely.

## Maintenance notes

Plan 001 publishes exactly this Quagmire boundary as 0.1.0. Plan 003 later
implements a TreeHopper `EditorHost` whose private Markdown source ledger is
keyed by stable Quagmire IDs; it must not add source tracking to Quagmire or
revive client-authored `ArborBlock[]`. Plan 004's direct Swift provider must
accept exact source and perform the same server/provider-owned parse and
directory-completeness semantics against the shared fixtures.
