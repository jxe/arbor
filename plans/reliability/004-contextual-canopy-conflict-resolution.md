# Reliability 004: Resolve Canopy conflicts at their authored locations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report rather than inventing a second merge model. When done, move this file
> to `plans/_done/reliability/004-contextual-canopy-conflict-resolution.md`,
> add its verification evidence to the historical index, and remove its active
> entry from `plans/README.md`.
>
> **Drift check (run first)**: inspect `git status --short`, then compare the
> current conflict models, coordinator, Markdown ledger, editor surface, and
> Quagmire row layout with the files named under "Current foundations". This
> plan was written while the native conflict-safety work was still uncommitted;
> verify behavior from source and tests rather than assuming a commit contains
> every foundation listed here.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: the native conflict-safety and editor-admission fixes in the
  working tree at planning time
- **Category**: correctness and recovery UX
- **Planned at**: commit `05c814b`, 2026-09-07, with uncommitted conflict work

## Outcome

When Canopy cannot merge a tree update automatically, Arbor shows every
conflicting authored location in context. A person can choose the current
version, their version, both when structurally safe, or an edited result for
each conflict. Arbor assembles all reviewed choices into one candidate tree and
submits that candidate as new intent based on the still-current accepted root.

No choice discards the live editor or clears durable conflict evidence before
the replacement intent is itself durable. Ordinary non-overlapping edits from
independent editors continue to merge in Canopy without invoking this UI.

## Why this matters

Canopy already returns useful structured conflict evidence: the accepted base,
candidate, current root, a server-generated draft, and one or more path/reason
records. The current native UI preserves that evidence but presents either a
tree-level “keep local” choice or a whole-document source editor. That is safe,
but it makes a conflict in one paragraph feel like a conflict in an entire
document, and it does not scale when one update conflicts at several paths or
at several places within one Markdown file.

The resolution UI must use Canopy's conflict result as the authority. It must
not run a competing client merge and silently claim success where Canopy found
an unsafe overlap.

## Current foundations

Inspect these before changing anything:

- `native/Packages/ArborWire/Sources/ArborWire/WireModels.swift` —
  `WireUpdateConflict`, `WireConflictDetails`, and `WireConflictDraft` retain
  the complete structured Canopy response, including draft transition objects.
- `native/Packages/ArborSync/Sources/ArborSync/SyncModels.swift` —
  `DurableSyncConflict` persists the response and local root, while
  `ReplicaConflictPresentation` currently exposes only root hashes and reasons.
- `native/Packages/ArborSync/Sources/ArborSync/ReplicaSyncCoordinator.swift` —
  conflict capture is durable; `resolveConflictKeepingLocal()` rebases the
  complete local candidate as new intent but is the only implemented choice.
- `native/Packages/ArborQuagmire/Sources/ArborQuagmire/MarkdownCodec.swift` —
  `ArborSourceLedger` relates exact Markdown source to stable Quagmire block
  identities and is the appropriate owner for mapping source ranges to blocks.
- `native/Packages/ArborQuagmire/Sources/ArborQuagmire/ArborDocumentBinding.swift`
  — single-document conflict resolution is transactional and retains the live
  editor plus conflict evidence when replacement admission fails.
- `native/Packages/ArborQuagmire/Sources/ArborQuagmire/ArborDocumentConflictAnalysis.swift`
  — provides a conservative whole-document suggestion for one disjoint edit
  per side; it is an interim presentation helper, not the tree conflict engine.
- `native/ArborApp/ArborDailyDriverViews.swift` and
  `native/ArborApp/ArborRootView.swift` — the native document conflict is shown
  within its page, while the tree conflict sheet only explains reasons and can
  keep the local tree.
- `/Users/joe/src/quagmire/Sources/Quagmire/EditorView.swift` — Quagmire owns
  row and gap placement but currently exposes only a page footer to host UI; it
  has no generic host-supplied row/gap accessory seam.

## Ownership boundary

The multi-location UI requires a deliberately small Quagmire change.

- **Quagmire owns placement only**: add a host-neutral, public API that can
  place stable, host-supplied accessories before/after a block or in a visible
  gap. It must not import Arbor concepts, parse Markdown, understand “mine” or
  “current,” or perform merging.
- **ArborQuagmire owns Markdown context**: derive conflict hunks from exact
  base/current/local/draft sources and map their source ranges through
  `ArborSourceLedger` to a `BlockID` or a document gap.
- **ArborSync owns tree resolution**: retain and materialize conflict snapshots,
  combine all per-path decisions into one reviewed candidate tree, and submit
  it against the verified current accepted root.
- **ArborApp owns product interaction**: labels, unresolved counts, navigation,
  confirmation, and the inline resolution cards.

Do not make `BlockRow` public or thread Arbor-specific closures through its
model. Prefer one value-typed placement descriptor and one view-builder seam at
the `EditorView` level so ordinary rows retain their existing equatable render
gate when no accessory is present.

## Resolution model

For each durable conflict, materialize and integrity-check four views:

1. **Base** — the immutable root identified by `details.base`.
2. **Mine** — the complete local candidate root captured at conflict time.
3. **Current** — the accepted root in `details.current`, revalidated before
   committing a resolution.
4. **Draft** — reconstruct `details.draft.root` by validating and applying its
   supplied objects/deltas to the candidate object set.

Build a typed conflict workspace keyed by logical path. Each Markdown path may
contain several hunks. Each hunk records exact source ranges in base, current,
mine, and draft, plus its Canopy reason. A selection produces a provisional
resolved source without altering the live document or any durable root.

The choices are:

- **Current** — take the exact current range.
- **Mine** — take the exact local range.
- **Both** — offered only when ordering and surrounding structure are
  unambiguous; use the already-validated server draft when it represents that
  combination.
- **Edit** — edit a copy of the selected hunk result, preserving all untouched
  bytes outside the replacement range.

Frontmatter conflicts appear at the document header. Fence-boundary conflicts
appear at the nearest containing block or gap. Binary, collection-schema, and
path-kind conflicts use typed path-level cards rather than pretending their
content is editable Markdown.

## Steps

### Step 1: Expose complete durable conflict material safely

Add an ArborSync conflict-workspace API that reconstructs the base, mine,
current, and draft snapshots from retained immutable objects and the
`WireConflictDraft` transition payload. Validate every object hash, graph, root,
tree identity, and reported conflict path before returning UI data.

Do not widen the Canopy protocol or expose private server history. If a required
base object is no longer retained locally and cannot be fetched through the
existing authorized immutable-object/snapshot surface, stop and establish the
smallest protocol change across TypeScript, Swift, fixtures, docs, and tests.

Add tests for corrupted draft objects, missing bases, mismatched trees, and
multiple conflict paths. None may clear `DurableSyncConflict`.

### Step 2: Produce deterministic Markdown hunks

In ArborQuagmire, implement a pure analyzer for one conflicted Markdown path.
It receives the four exact source strings and Canopy reasons and returns ordered
hunks with non-overlapping ranges and stable IDs. It must:

- preserve line endings, frontmatter envelope, indentation, blank lines, raw
  fallback blocks, and every untouched byte;
- represent multiple overlaps independently when their ranges do not intersect;
- coalesce intersecting ranges rather than offering contradictory choices;
- distinguish a source range that belongs to a block from one that lies in a
  gap or document envelope;
- never turn Canopy's unsafe result into an implicit automatic resolution.

Add table-driven tests for two conflicts in one file, nested lists, headings,
frontmatter, fenced code, CRLF, raw fallback blocks, and edits adjacent to EOF.

### Step 3: Add Quagmire's contextual-accessory seam

In `/Users/joe/src/quagmire`, add the smallest public, source-compatible API
that lets a host place stable SwiftUI content at a block or gap. The API must:

- use `BlockID` and an explicit before/after/gap placement value;
- preserve row identity, lazy layout, selection, focus, reorder geometry,
  pinch insertion, and `.equatable()` behavior for unaffected rows;
- give accessories normal accessibility order and keyboard reachability;
- avoid storing Arbor state or merge callbacks in `Document`, `Block`,
  `EditorState`, `EditorHost`, or `BlockRowModel`;
- render zero extra layout when no accessories are supplied.

Add focused Quagmire tests for ordering, collapsed headings, reordering,
selection/focus stability, and no-accessory behavior. Run Quagmire's complete
verification gate before treating this public API as releasable.

### Step 4: Map hunks into the editor and build the interaction

Map each hunk through the ledger to its authored block/gap and supply an inline
resolution card through the Quagmire seam. Each card shows enough surrounding
context to understand the collision and offers Current, Mine, Both when safe,
and Edit. Add:

- unresolved and resolved counts;
- Previous/Next Conflict navigation across all paths and hunks;
- a page-level summary for conflicts in documents not currently open;
- an explicit way to reopen the tree-level evidence view;
- clear separation between a provisional choice and a durably submitted
  resolution.

The editor remains usable for ordinary inspection, but resolution choices edit
the provisional conflict workspace, not the live binding. Do not silently
serialize unrelated incidental editor changes into the reviewed candidate.

### Step 5: Assemble and submit one atomic tree candidate

After every conflict location is resolved, apply the reviewed per-path results
to the complete local candidate snapshot and build one new tree candidate.
Immediately before submission, fetch or read the accepted descriptor and verify
that both the durable conflict identity and current accepted root still match.

Submit the reviewed candidate as new intent based on that current root. Keep the
original durable conflict and provisional decisions until the new attempt is
durably journaled. Clear them only through the ordinary acknowledged-success
path. If the replacement conflicts again, retain both the new Canopy evidence
and the person's provisional work.

Implement explicit whole-tree actions alongside reviewed resolution:

- **Keep local as new edit** — existing behavior, with identity recheck.
- **Use current and discard local candidate** — destructive; require explicit
  confirmation and only install the verified current snapshot after the choice
  is durable.
- **Use server draft as new edit** — validate the draft snapshot and submit it
  against current; do not label it an automatic merge.

### Step 6: Make provisional resolution restart-safe

Persist the conflict identity and per-hunk decisions atomically beside the
durable sync control. On restart, reconstruct the workspace, reject stale or
malformed decisions without overwriting them, and reopen at the first unresolved
location. A newer Canopy conflict must not inherit choices merely because paths
or line ranges happen to match.

Add crash-boundary tests before and after saving a choice, assembling the
candidate, journaling the replacement attempt, server acceptance, and local
application of the accepted result.

### Step 7: Update documentation and status after implementation

Document the user-visible flow and the Arbor/ArborQuagmire/Quagmire ownership
boundary in `docs/client.md`. If any Wire or ArborSync endpoint/model changes,
update both language clients, conformance fixtures, and
`docs/arborsync-api.md`. Update `status.md` only after the complete focused and
manual gates pass.

## STOP conditions

Stop and report if:

- any required base/current/local/draft object cannot be obtained and verified
  through current retained or authorized surfaces;
- the accepted current root or durable conflict identity changes across an
  `await` while a resolution is being committed;
- the proposed implementation duplicates Canopy's representation merge rules
  in the client or needs to call an unsafe overlap “merged”;
- the Quagmire API needs Arbor-specific concepts or makes ordinary row rendering
  depend on type-erased conflict closures;
- one requested choice cannot preserve exact untouched Markdown bytes;
- atomic application of decisions across multiple paths would require applying
  some paths before others;
- a binary, collection, path-kind, or frontmatter behavior is ambiguous rather
  than explicitly modeled and tested.

## Verification

Run the narrow tests while implementing, then all relevant gates:

```sh
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborSync
swift test --package-path native/Packages/ArborQuagmire
bun run test:protocol
bun test tests/integration/self-sync.test.ts
bun run typecheck
bun run test
```

In `/Users/joe/src/quagmire` run:

```sh
swift test
scripts/verify.sh
```

Regenerate the Arbor Xcode project only if published dependency metadata
changes, then build both native destinations supported by the workspace. For
local coordinated development, use `native/Arbor.local.xcworkspace`; do not
replace committed remote pins with local paths.

Manual acceptance on macOS and iOS must cover:

1. two independent editor candidates with disjoint edits merge without UI;
2. two conflicts in different Markdown paths;
3. two conflict hunks in one Markdown path;
4. Current, Mine, Both, and Edit, including reopening after restart;
5. navigation, collapsed headings, focus, selection, reorder, and pinch behavior
   around inline cards;
6. a second conflict arriving while the first is open;
7. failed submission retaining every source and choice;
8. explicit destructive “Use current” confirmation;
9. binary, collection-schema, path-kind, frontmatter, and fenced-code fallbacks;
10. VoiceOver order, keyboard traversal, compact iPhone layout, and native macOS
    page layout.

Finally run the repository-wide relative-link check and `git diff --check`.

## Git workflow

Keep Quagmire and Arbor changes in separate focused commits. Do not publish or
change Arbor's pinned dependency during local development. If Joe requests a
release, first pass Quagmire's release gate and publish/tag it, then update both
exact Arbor pins, regenerate `native/Arbor.xcodeproj`, and commit the dependency
bump separately. Do not push or open a PR unless requested.
