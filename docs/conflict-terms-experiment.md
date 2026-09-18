# Composable conflict terms experiment

This is an executable, isolated Canopy backend experiment, developed from
`683bb57`. It is not connected to the production host, exported from
`@arbor/canopy`, or advertised as a Wire capability. It uses a separate SQLite
database and real Wire directory/file objects. The existing server still rejects
unsafe merges. No native client, public schema, or production database changed.

The experiment supports keeping conflicts accepted while ordinary editing
continues, and resolving individual regions explicitly. Start with the
[behavior tests](../tests/unit/canopy/conflict-terms.test.ts), then the
[backend](../packages/canopy/src/experimental/conflict-terms/backend.ts),
[projection](../packages/canopy/src/experimental/conflict-terms/projection.ts), and
[algebra](../packages/canopy/src/experimental/conflict-terms/algebra.ts).

## Result

Jujutsu-style terms fit Arbor's snapshot input and ordinary-object projection.
They support continued edits, separate hunk choices, exact byte preservation,
root-unchanged accepted transitions, and durable retention of hidden alternatives.
These results establish the snapshot-only baseline. They do not select the
backend: the next evaluation must combine Canopy's source understanding with
editor-supplied operations before comparing terms with a content graph.

**Algebra alone does not satisfy Arbor's preservation contract.** Consider
`Wednesday + Tuesday - Monday`, with Wednesday selected for display. An ordinary
edit changing Wednesday to Monday produces:

```text
Monday + (Wednesday + Tuesday - Monday) - Wednesday = Tuesday
```

Cancellation makes the state look resolved and hides the newly authored Monday.
The experiment initially reproduced this failure. Its admission guard now
rejects the update atomically and requires explicit review. The old accepted
state and all its alternatives remain retained. A caller owns its rejected
candidate; rejection does not mean that candidate is stored by this backend.

The guard permits replacing a region's selected positive term only when every
other signed piece remains in a distinct review region at the same path with
the same unique surrounding anchors. Identical alternative bytes in a new
conflict elsewhere are not proof that the old region survived; a regression
test reproduces that case too. The guard rejects ambiguous movement or
coalescing of those regions. This is a conservative
implementation of the existing permission to reject changes that cannot safely
preserve unresolved state, not a change to the
[portable contract](../spec/01-tree-operations.md#accepted-unresolved-state).

## Intent preservation is the next acceptance criterion

The [thought experiment and source-intent model](conflict-intent-comparison.md)
now exercise the next stage: paragraph targets, authored revision identity,
selective deletion undo, and alternative edits. They establish that the cases
below need retained provenance but do not yet select a full content-graph backend.

Joe's direction after the initial experiment is to use both source-level
intelligence at Canopy and updates that retain the editor's knowledge of the
authored operation. Conflict representation must serve those capabilities.
The conservative snapshot-only guard above is a fallback, not the desired
ceiling for ordinary editing.

### What exists, and where information is lost

Canopy already has representation-specific rules for Markdown, frontmatter,
page-ID moves, and collection rows in
[merge.ts](../packages/canopy/src/updates/merge.ts) and
[merge-rules.ts](../packages/canopy/src/updates/merge-rules.ts). Extend that shared
authority-side understanding rather than teaching every client a competing
merge policy. Preserve unchanged source bytes while interpreting document
structure, key/row identity, containment, and ordering.

The [Markdown codec](../native/Packages/ArborQuagmire/Sources/ArborQuagmire/MarkdownCodec.swift)
has a ledger connecting editor blocks with original source. Its `admission`
currently serializes the result and reduces the change to a single
`minimalEdit`. The
[working-tree coordinator](../native/Packages/ArborWorkingTree/Sources/ArborWorkingTree/UpdateCoordinator.swift)
can translate a validated patch into a copy/insert object delta, falling back
to complete objects when smaller or necessary. This is covered by the
[editor patch test](../native/Packages/ArborWorkingTree/Tests/ArborWorkingTreeTests/UpdateCoordinatorTests.swift).

Those deltas save transfer bytes. They do not currently carry semantic move,
copy, field-change, or conflict-target intent. The
[request digest](../packages/wire/src/updates/intent.ts) intentionally excludes
object envelopes. Thus richer transport diffs alone cannot change how a request
merges: supplying a delta or the full object must mean the same thing.

### Two complementary inputs

Canopy should derive what source evidence supports: distinguish frontmatter
fields, paragraphs, list subtrees, links, page identity, and collection rows;
identify independent changes; follow identities across moves; and preserve
unresolved meaning where source correspondence is ambiguous. A parser can
establish structure and some correspondence. It cannot prove whether identical
resulting bytes came from a move, a copy, or an intentional replacement.

Editors should retain the operations they actually observe before serialization
erases them. Initial candidates are insert/delete/replace of a guarded source
range, move versus copy of a page or block subtree, setting/removing a property,
and editing a specific unresolved alternative versus explicitly resolving it.
Group the effects of one authored action, including multi-path changes within
one TreeID. Do not substitute guessed operations from a final diff for observed
editor actions. Snapshot-only filesystem writers remain supported.

An experimental intent-bearing update should bind:

- The exact accepted base and TreeID, and any ordered local predecessor.
- The operation, target, and guarded base source/structure. A Quagmire BlockID
  is not automatically a durable identity shared by devices: validate its
  correspondence to base source or define a scoped identity with explicit
  lifetime and restart semantics.
- The candidate projection and the exact effects represented by the operation.
  Replaying the operations against the stated base must reproduce the candidate
  bytes for their declared scope; any residual snapshot changes remain explicit.
- The operation/request identity and, for conflict-aware edits, the accepted
  conflict state and alternative being edited. Editing an alternative back to
  old base bytes must not be mistaken for resolving the disagreement.

Canopy remains the merge authority. Client operations express requested effects;
they do not choose how unrelated concurrent edits are merged. Validate target
scope, authorization, source guards, candidate consistency, ordering, and
identity. Replay consistency verifies effects, not a person's psychological
intent. Preserve attribution to the submitting operation rather than presenting
server inference as an editor-observed fact.

If intent changes reconciliation semantics, it belongs in a versioned semantic
operation and its retry digest, not in the optional transport envelope. An
unsupported or contradictory semantic operation must fail explicitly. Purely
advisory information may be omitted only when doing so preserves meaning;
silent fallback must never turn a move into a copy, or an alternative edit into
a resolution. Keep ordinary Wire projections stable while proving this optional
extension, then update TypeScript, Swift, normative text, API documentation, and
conformance fixtures together.

### Durability and coalescing

Retain operations with their objects and candidate state before acknowledging
local admission. Preserve them through offline queues, restart, retries, and
the one-in-flight/one-successor path. Coalescing can combine consecutive typing
edits with compatible targets and guards; it must not erase move-versus-copy,
targeted deletion, transaction grouping, or conflict-alternative identity.
Do not require an unbounded keystroke log. Prove a compact composed operation
still expresses the original effects before replacing its durable predecessors.

Canopy must retain the accepted operation/provenance needed to interpret later
edits against unresolved alternatives, not only accept the evidence transiently
and then retain snapshots. Define when accepted history can be compacted without
losing those identities, and include that retained evidence in authorization
and storage measurements.

### Paired intent scenarios

For each case, test snapshot-only input, source-aware inference, and a validated
editor operation. Evaluate intended effects and exact retained source, not just
whether the conflict count decreases:

| Case | Evidence to preserve | Expected behavior |
| --- | --- | --- |
| Move a paragraph while another writer edits it | Recorded source/destination and base correspondence | Carry the edit with the moved paragraph when identity is verified. |
| Copy the same paragraph while another writer edits the original | Copy operation and distinct destination identity | Preserve the original's identity; do not infer a relocation. |
| Edit one of two identical paragraphs | Guarded occurrence/target identity | Apply to the intended occurrence; identical text elsewhere is not a match. |
| Delete a paragraph while another writer edits it | Explicit deletion and the concurrent edit | Preserve the disagreement and edited alternative; do not restore the paragraph as an unexplained addition. |
| Change different frontmatter fields or collection cells | Field/row identity and guarded effects | Merge independent effects while preserving untouched source. |
| Edit the selected conflict alternative back to its old base bytes | Alternative identity and edit operation | Keep that authored value and the other alternative unresolved, avoiding algebraic cancellation. |
| Rename a page while another writer edits it | Tree-scoped page identity and relocation | Preserve one page and its edit, or surface ambiguous identity. |
| Restart or coalesce a move followed by typing | Durable ordered/composed effects | Retain both the relocation and subsequent edit exactly once. |

This corpus is the backend selection gate. Terms may remain a good retention
representation when operations and source analysis supply correspondence. If
preserving that intent requires pervasive persistent content-graph identity,
evaluate Pijul against these same cases. Neither algebraic elegance nor fewer
conflict flags is sufficient evidence of intent preservation.

## Representation and operations

Accepted state stores an ordered signed expression of immutable root hashes
alongside its ordinary projected root and a separate update number. Terms have
total weight one. Opposite identical occurrences cancel; identical positive
terms are never deduplicated. This deliberately omits Jujutsu's algebraically
lossy same-change rule. Two distinct operations making the same change can
therefore require explicit review even when the projected root is unchanged.
Exact request retries are separately identified and replay the original result.

An ordinary update contributes `candidate - base.root` to the current expression.
The base is looked up by its exact tree-scoped accepted update number. The
candidate term is ordered first so an unresolved region prefers the latest
authored projection. A candidate identical to its base projection is a no-op
and cannot clear conflicts. A fully clean materialization checkpoints to one
root; this experiment does not promise reversible arbitrary history rebases.

Projection descends ordinary directory entries. Markdown localization uses
unique lines shared in the same order by every term, retaining byte ranges in
each source object. Repeated or crossed context yields a larger conflict rather
than an invented correspondence. CRLF, BOMs, and missing terminal newlines are
preserved. Invalid UTF-8 and binary files remain whole-entry alternatives;
divergent collection directories also remain atomic. Nested TreeIDs stay opaque.

Explicit resolution replaces the selected region in every term, then simplifies
and projects again. Other regions retain their alternatives. A resolution can
choose a positive alternative, including structural absence, or supply edited
UTF-8 bytes for a text region. Both the accepted update and region identity are
checked. Concurrent or stale reviews fail without modifying authority state.

## Durability, scope, and limits

- All object retention, accepted state, head advancement, and request replay
  records commit in one immediate SQLite transaction with full synchronous WAL.
  Killing a process after a successful resolution, without closing its database,
  leaves the resolution readable after reopening.
- Authorization in this private API is deliberately one owner string per
  TreeID. It is an assertion supplied by a trusted caller, not authentication.
  This does not implement Canopy credentials, grants, or revocation. Reads and
  candidate references are confined to that tree's retained objects. Knowing
  a hash reachable only from another tree does not grant access.
- Request IDs are explicit and tree-scoped. Reusing one with different semantic
  intent fails. Replay records persist while their result update is retained;
  expired bases fail rather than being guessed.
- Pruning retains projected roots and every live term root, including alternatives
  absent from the projection. Resolving and then pruning releases unreachable
  objects. Other trees' retained objects survive collection.
- The experiment caps unresolved root terms at 65 by default, graph traversals
  at 20,000 objects / 64 MiB of distinct bytes / 128 directory levels, and retained
  request records at 10,000 per tree. Exceeding a limit rejects work; it never
  truncates alternatives. Reachability traversals include retained history, so
  explicit pruning may be necessary before another update or object read.

## Running it

From the repository root:

```sh
bun install --frozen-lockfile
bun test tests/unit/canopy/conflict-terms.test.ts
bun run typecheck
```

The backend accepts `TreeSnapshot` values built with the existing Wire object
functions. Its private API is:

```ts
const backend = new ConflictTermsBackend("/tmp/disposable-conflict-experiment.sqlite");
const first = backend.create(treeID, owner, initialSnapshot);
const next = backend.update(treeID, owner, first.update, candidateSnapshot, "edit-1");
const review = backend.review(treeID, owner);
const resolved = backend.resolve(treeID, owner, review.update,
  [{ conflict: review.conflicts[0]!.id, take: 0 }], "resolution-1");
backend.close();
```

Only resolve when `review.conflicts` is nonempty. Generate a stable ID for each
logical operation and reuse it for an uncertain retry. The tests create and
remove their own temporary databases; no application state is needed.

## Remaining decisions

The paired intent scenarios above precede production backend selection. The
items below are integration requirements, not reasons to limit the experiment
to snapshots.

1. Preserve page identity through moves. The experiment deliberately reports
   rename-versus-edit as delete/edit plus the moved file, retaining the edited
   source. It does not replace the existing merge engine's frontmatter-ID move
   recognition. Moving an already-conflicted region may be rejected by the
   preservation guard. Prove ambiguous and duplicate IDs before relaxing it.
2. Decide how often the conservative region guard rejects realistic editing,
   especially deleting separators, repeated paragraphs, and structural edits.
   If accepting those edits requires a second persistent passage-identity graph,
   compare Pijul before adding that machinery to the term implementation.
3. Reconcile production Markdown/frontmatter/collection merge rules with term
   projection. A rule's additive or approximate draft must not silently retire
   an alternative. The experiment does not replace those rules or guarantee
   semantic Markdown validity of a user's explicit resolution.
4. Integrate retained alternatives into Canopy's existing object store, accepted
   update transaction, observations, authorization, and integrity checks. Do not
   ship this experiment's independent object table or invent another production
   ownership/credential layer. Measure term growth and retained bytes under
   multi-device workloads; current limits are experimental refusal bounds.
5. Define the optional inspection/resolution extension only after these behaviors
   are settled, updating TypeScript, Swift, normative text, reference API, and
   language-neutral fixtures together. Then connect working-tree continuation
   and the inline review work in
   [Reliability 004](../plans/_done/reliability/004-contextual-canopy-conflict-resolution.md).

The comparison is informed by Jujutsu's
[conflict algebra](https://docs.jj-vcs.dev/latest/technical/conflicts/) and Pijul's
[content graph design](https://pijul.org/posts/2020-11-07-towards-1.0/).
Neither implementation is imported as a dependency.

## Verification evidence

Verified on 2026-09-13 in the isolated worktree:

- Focused experiment suite: 26 passing tests, including both preservation
  counterexamples reproduced before their fixes, partial hunk resolution,
  request replay, retention, and a writer killed with SIGKILL after commit.
- `bun run typecheck`, `bun run test:protocol`, `bun run build`,
  `bun run test:performance`, and standalone
  `swift test --package-path native/Packages/ArborSyncClient` passed.
  The performance gate measures the existing object index, not term-backend
  throughput; a realistic backend workload measurement remains open.
- `bun run test`: 407 passed, one existing failure in
  `tests/integration/child-provider.test.ts:84` (`One` expected, `one` returned).
  Running that file in the original checkout at `683bb57` reproduced the same
  failure (9 passing, 1 failing); the original checkout's changes were plans only.
- Repository-wide relative-link scan: 655 links in 157 Markdown files, no newly
  broken links. The 11 unresolved targets also occur in the original checkout,
  including historical and intentionally non-resolving fixture links.
  Whitespace checks passed.

The local Bun runtime reported `1.4.0-canary.1`; dependencies were installed from
the unchanged lockfile with `--frozen-lockfile`. The repository specifies Bun
1.3.14. No signed application build or live-service migration was needed for an
unmounted TypeScript experiment.
