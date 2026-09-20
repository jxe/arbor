# Native accepted-choice review

This checkpoint describes the implementation of
[Reliability 010](../plans/canopy-swift/010-client-conflict-review.md), developed on
`codex/native-conflict-review` and integrated with main's causal undo and source
admission changes at `3a3d694`. It has not been installed or interactively verified.

## Interaction

The current tree's sidebar has a **Review choices** entry below search, with a
count from a complete, pinned Canopy inspection. It switches the sidebar to a
list grouped by affected path. The ordinary page list remains mounted so its
search and position survive returning through **All pages**. Page rows and the
open page expose choice markers. Selecting a choice opens its existing page when
available; deleted entries remain reviewable without inventing a live page.

On macOS, an expandable document accessory lives inside the editor scroll surface.
Non-document and missing-page scopes use a separate review panel. On iPhone,
review opens in a large sheet. Previous/next buttons and Command-Option-Up/Down
navigate the complete current list. Resolving stays on the result; it does not
automatically move to the next choice. An empty active list shows **All choices
reviewed**. The sidebar entry disappears once there are no choices or retained
drafts, without closing an already open review list.

The panel supports any number of alternatives and marks the projected one.
It exposes exact raw source, a comparison toggle with changed-line highlighting,
copying source, and an explicit composition draft. Comparison preserves line
endings and scalar spelling; large sources bypass expensive line diffing after
4,000 combined lines and remain readable as raw source. Directory alternatives
show their immediate entries; binaries show byte counts. Alternatives are read
through their authorized historical decision/material route, with hash checks.

Choosing an alternative changes only the proposal. Each connected dependency group
has one draft, including reverse dependencies. Members are authored step by step:
choose a version, optionally compose exact file bytes, choose an absolute destination,
or explicitly remove the entry. Missing choices remain visible obligations; incomplete
drafts can be saved. A missing destination parent or a collision blocks compilation.
Moving a child out of a removed parent requires an explicit destination; choosing a
parent version cannot silently restore a child marked for removal.

**Preview combined result** compiles a separate immutable tree. It shows every changed
path recursively, with expandable exact entry hashes and collection metadata.
Any proposal edit invalidates the preview. **Apply and resolve** rechecks the pinned
state and compiles again, then submits one candidate with every group declaration.
Directory/root, file/directory, binary, tree-link and placement choices use the same
compiler. Swaps remove old placements before installing the chosen destinations.
Tree boundaries cannot be traversed; unrelated existing entries cannot be overwritten
implicitly, and other unresolved decisions cannot be changed.

Source-range choices validate the exact pinned file hash and UTF-8 boundaries,
then replace only the declared bytes. Choosing a retained version emits explicit
`copySource` plus `editSource` operations; composition emits `editSource`. Independent
choices elsewhere in the same file remain unresolved, with their positions updated
by Canopy. Removing a source choice removes its range, not the page. A source-only
review cannot relocate its whole file. Coupled structural drafts may move or remove
the containing file, but must agree on one disposition and preserve the pinned
surroundings of every source choice.

Unknown or unlocatable scopes fail closed. Canopy ranges remain document-anchored
in the editor until the host has a validated source-to-block mapping; byte ranges
must not be presented as guessed paragraph locations. Binary rendering/export and format-specific
collection reconstruction remain outside this surface; all candidates must pass
Wire graph and collection descriptor validation.

## Persistence and publication

`CanopyWorkingTree` owns pinned inspection, scope eligibility, drafts, request
construction and guarded submission. The app owns navigation and presentation.
The coordinated Quagmire branch `codex/editor-accessories` provides generic
`EditorAccessory`, `EditorAccessoryAnchor` (document/block), and tokenized
`EditorAccessoryReveal` APIs. Hosts own IDs, marker/detail views and expansion.
Missing block IDs and duplicate accessory IDs fail closed. Revealing a block
expands its hidden ancestors without selecting or editing it. Accessory geometry
shifts following rows but remains outside document hit targets, drag lifts, source,
selection and undo history. Native text controls retain their own keyboard/undo
routing. Arbor uses document anchors until authoritative finer source mapping exists.

Coordinated validation used the ignored local workspace with the Quagmire
worktree at `/Users/joe/src/arbor-review-deps/quagmire`; the final directory name
must be `quagmire` for Xcode's package-identity override. Arbor's published pins
and standalone package lock adopt Quagmire 0.8.0 in a separate dependency commit.
Ordinary local development can use the sibling Quagmire main checkout.

A private schema-2 `sync/conflict-review.json` (also reading schema 1) retains exact drafts, pinned decision and
alternative evidence, and an immutable prepared request. Drafts are serialized
through the app's save tail; the UI does not acknowledge draft retention before
the durable write completes. Discarding composed source or a draft is explicit.
Drafts whose decisions disappear remain in the list and can be copied or discarded.
Tree switches and normal lifecycle flushes wait for draft persistence. Failed
saves retain the in-memory draft through inspection refresh and block switching
to a different review draft until retention succeeds.

Applying re-inspects the current accepted identity and validates the complete
pinned decision. The current server requires exact accepted-state guards, so
**any accepted-state change requires explicit review of the latest evidence**,
even when projected bytes are equal or the update is unrelated. Draft source is
retained. This conservative limitation avoids silently retargeting guards; it
can be relaxed only with a compatible server/client policy.

Ordinary pending admissions must settle before a resolution request is frozen.
The resolution is a snapshot candidate plus complete resolution declaration,
prepared with the existing Wire digest/identity implementation. It runs inside
`UpdateCoordinator`'s existing single-flight publication loop. Its separate
journal slot prevents a review proposal from becoming a local editor/navigation
head. Normal editor admissions may continue while its response is in flight.

An uncertain response retains the exact request for existing Wire replay. A
validated conflict rejection retires only the request and preserves the draft.
Accepted results use the coordinator's normal current-snapshot installation;
pending submission evidence is removed after that durable transition. A newer
local draft is not removed by an older accepted submission: retirement compares
a hash of the complete, byte-preserving draft, including secondary compositions. Review may finish
with additional unresolved decisions from concurrent work.

Alternative material is read through the ordinary `object(tree, hash)` read on
both Wire clients; the object route serves any retained object to a tree reader. A TypeScript
review controller is not implemented in this Native slice.

## Verification

The current coordinated worktrees have compiler and automated coverage; neither
application has been installed or launched for this change.

- The protocol harness uses nine disposable review trees: hidden-version choice,
  exact composition, lost response/restart, concurrent editor/draft work, grouped
  ancestor deletion, child rescue, grouped composition, grouped lost response, and
  independent source-range resolution with another range preserved and relocated.
- Compiler tests cover incomplete groups, reverse dependency discovery, child
  removal under a selected/moved directory, swaps, collisions, boundaries,
  protection of unreviewed choices, exact secondary composition fingerprints and
  durable grouped recovery. Source-range cases cover Unicode/CRLF surroundings,
  invalid boundaries, mismatched file identity and preservation of another choice.
  Existing tests cover opaque state identity and CRLF.
- Quagmire tests cover accessory hit geometry, missing/duplicate anchors, collapse
  while offscreen, source/selection separation and external undo routing.
- Both app destinations build through the local workspace. Quagmire's complete
  `scripts/verify.sh` covers package tests and clean macOS/iOS Simulator builds for
  both libraries. Wire client authorization/hash tests and TypeScript checks remain
  part of the coordinated verification.

Automated results (2026-09-18): `bun run test:protocol` passed, including 97
working-tree tests and all nine live review scenarios; the focused Wire/pin/Canopy
suite passed 52 tests. TypeScript typecheck and build passed. Quagmire verification
passed 413 tests and all four clean builds. Both final Arbor app builds passed
without signing, installation or launch. Both worktrees pass `git diff --check`.
The repository Markdown scan checked 929 relative links: 34 unresolved references
already existed in HEAD and none were introduced by this change.

Interactive focus, selection, scroll, VoiceOver, large text, IME and visual layout
remain a manual gate on both platforms. Finer source mapping, richer binary/export
UI, format-specific reconstruction, additional crash fault injection and complete
offline inspection remain in Plan 010.
