# Reliability 007: Reify composable Canopy conflicts as algebraic tree states

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. Preserve unrelated working-tree changes. When the
> implementation is complete, move this file to `plans/_done/reliability/`
> with its identifier unchanged, record the verification evidence there, and
> update both plan indexes.
>
> **Drift check (run first)**:
> `git diff --stat 231d16a..HEAD -- packages/core/src/protocol.ts packages/wire/src packages/canopy/src packages/canopy-client/src packages/arborsync/src packages/arborsync-client/src native/Packages/ArborWire native/Packages/ArborWorkingTree native/Packages/ArborSyncClient native/ArborApp tests/fixtures/canopy tests/unit/canopy tests/unit/wire tests/integration/canopy tests/integration/self-sync.test.ts spec/01-tree-operations.md spec/03-locators.md spec/09-client-synchronization.md docs/client.md docs/client-state-machines.md docs/arborsync-api.md migrations plans/reliability/004-contextual-canopy-conflict-resolution.md plans/README.md`
> If the accepted-update schema, update digest, merge rules, client conflict
> state, or descriptor shape changed, refresh the current-state excerpts and
> phase boundaries before writing code. A changed line is not automatically a
> stop, but a changed invariant is.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: none
- **Category**: reliability, protocol, migration, and client behavior
- **Planned at**: commit `231d16a`, 2026-09-10
- **Supersedes**: the earlier Reliability 007 Markdown-anchor spike
- **Relationship to Reliability 004**: Reliability 004 remains valid for
  client-local, policy, exact-match, and pre-upgrade `409` conflicts. Its
  server-update review path is retired only after the reified path and both
  client implementations pass the rollout gate in Step 8.

## Why this matters

Canopy currently computes a useful draft for a stale update, then rejects the
entire candidate when any one node remains conflicted. The client retains the
`409` evidence and stops that tree. As a result, one ambiguous paragraph or
binary replacement prevents later independent files, collection rows, and
Markdown edits from synchronizing.

The replacement is a Jujutsu-style first-class merge state. Jujutsu records an
odd ordered list of tree terms such as `A + (C - B) + (E - D)`, flattens nested
expressions, cancels exact terms, and derives conflicts by descending from
trees to subtrees, files, and hunks. This is the useful idea for Arbor. Pijul's
stronger commutation comes from a graph of change-identified content vertices;
adopting that would replace Arbor's exact snapshot object model and is outside
this plan.

The design below keeps Arbor's serialized accepted-update log and immutable
Wire objects. It does not require stable Markdown edit identities. Exact root
terms are durable; paths and local regions are derived anew from the current
state. A conflict can therefore move, combine, split, or widen as later updates
arrive without rewriting predecessor-region metadata or blocking the tree.

Primary design references:

- [Jujutsu first-class conflict data model](https://www.jj-vcs.dev/latest/technical/conflicts/)
- [Jujutsu user-facing conflict behavior](https://www.jj-vcs.dev/latest/conflicts/)
- [Pijul conflicts](https://pijul.org/manual/conflicts.html) and
  [graph/change identity](https://pijul.org/manual/theory)

## The representation to implement

### 1. An accepted state has two addresses

Keep `root` as the ordinary, filesystem-projectable tree. Add `state`, the hash
of a small canonical merge-state record:

```ts
interface TreeMergeStateV1 {
  version: "tree-merge-state-v1";
  /** Ordinary valid Wire root shown by readers; also terms[0]. */
  projection: ObjectHash;
  /** Frozen registry used to derive this projection and its conflict view. */
  materializer: "canopy-tree-merge-v1";
  /** Odd ordered sequence: +terms[0] -terms[1] +terms[2] ... */
  terms: [ObjectHash, ...ObjectHash[]];
}

interface RemoteTreeDescriptor {
  // existing fields
  root: ObjectHash;   // equals stateRecord.projection
  state: ObjectHash;  // hash of canonical stateRecord bytes
  update: string;
}
```

The expression represented by `terms` is:

```text
terms[0] + (terms[2] - terms[1]) + (terms[4] - terms[3]) + ...
```

Every term is the root of a complete ordinary Wire tree. The state record is
not a `WireObject`, directory entry, hidden path, or filesystem node. In
particular, do not add `system:conflicts`, conflict-marker files, reserved
filenames, or a top-level conflicts subtree.

The canonical record has these invariants:

1. `terms.length` is nonzero and odd.
2. `projection === terms[0]`; it is the selected start value for current-wins
   evaluation. Every term names a valid, hash-verified directory root.
3. Every object reachable from every term is retained for the state.
4. `hash(canonicalCBOR(record))` equals the advertised `state`.
5. Re-running the named materializer on `terms` produces `projection` and at
   least one unresolved region when `terms.length > 1`.
6. A clean state is canonicalized to
   `{ projection: R, terms: [R], materializer: ... }`.
7. Term order is accepted-history order. Canonical encoding means one byte
   representation for that ordered state, not equality across different
   arrival orders.

No request ID, author, observation ordinal, path, line offset, JSON pointer,
AST location, predecessor ID, or display label appears in these bytes.
Provenance remains in accepted-update history. Current paths and labels belong
to derived read responses.

### 2. The projected tree is selected content, not the conflict store

`projection` is always an ordinary valid Arbor tree. Existing snapshot,
filesystem, web, and nested-tree traversal continues to read it. The default
selection rule is **current wins at an unresolved region**: when a new diff
cannot be placed safely, retain the already accepted projected content there.
Safe portions of the same update still change the projection.

This differs from choosing a winner by term hash. It is deliberately
order-sensitive and explainable because Canopy already serializes accepted
updates. The selected projection changes only through:

- a proven-clean part of an ordinary update;
- a later ordinary edit to selected content;
- an explicit conflict resolution; or
- an explicit materializer-version upgrade that passes the same state fixtures.

The projection is checked when the state is created, but ordinary readers do
not need to recompute it. They can continue to fetch `root` snapshots.

### 3. Conflict regions are derived, state-bound views

The full-state endpoint returns the record and the union of objects reachable
from all its terms. A separate JSON conflict view recursively evaluates the
same terms and presents only unresolved areas:

```ts
interface TreeConflictViewV1 {
  version: "tree-conflict-view-v1";
  tree: string;
  state: ObjectHash;
  projection: ObjectHash;
  regions: Array<{
    /** Hash of state, rule, exact local term values, and deterministic index. */
    token: ObjectHash;
    rule: { name: string; version: number };
    target: {
      /** Current presentation locator; never canonical conflict identity. */
      path: string;
      stableKey?: string;
    };
    reason: UpdateConflict["reason"];
    selected: ConflictValueView;
    /** Ordered +/- local values, retaining exact bytes or object references. */
    terms: ConflictTermView[];
  }>;
}
```

Tokens are intentionally ephemeral. They are valid only for the exact `state`
hash in the response. A region that moves because lines were inserted gets a
new path and token. Two overlapping regions become one newly derived region.
A later resolution or rule result can split one region into two. If alignment
is ambiguous, the rule returns a larger block, whole property, whole file, or
whole node. There is no operation that guesses which prior region a new range
"really" was.

This avoids the unsolved durable Markdown-anchor problem. A Markdown rule
receives the complete current N-way file expression and derives fresh hunks
using exact source. A JSON rule can instead derive properties or array spans.
A source rule can use a language-qualified concrete syntax tree. Generic state
storage understands none of those locator types.

### 4. Normalization keeps states finite without losing open alternatives

After evaluating an expression, normalize it before committing:

1. Flatten nested expressions into the ordered root sequence.
2. Cancel exact positive and negative roots using a deterministic
   left-to-right algorithm; never compare model hashes for cancellation.
3. Recursively evaluate directories. At a resolved node, write the projected
   entry into every surviving term slot. At an unresolved node, retain the
   rule's exact signed local values in their original term slots.
4. Rebuild complete roots, repeat exact whole-root cancellation, then put the
   result in **selected normal form**: the new projection is term zero and each
   surviving alternative is expressed by a following remove/add pair. If
   cancellation consumed the old start term, re-anchoring restores the already
   computed projection; it does not choose a new visible side.
5. If no unresolved region remains, replace the record with singleton
   `[projection]`.

Steps 3 and 4 factor proven-common context into all sides. Thus an unrelated edit
does not add two permanent terms merely because another path remains
conflicted. It may synthesize new directory roots, but it must preserve exact
unresolved leaf bytes. The original submitted roots remain in accepted-update
history according to the existing retention policy.

Selected normalization preserves the projection and exact unresolved local
values; it does not promise that a later inverse reconstructs discarded common
history. Canopy does not rebase its accepted log backward. This normalization
is intentionally less ambitious than a CRDT. It must obey
the observable laws below, not make arbitrary update arrival orders
byte-identical. Jujutsu's optional lossy "same-change" rule is not included in
version 1; add it only through a later materializer version and explicit
fixtures.

## What happens when updates arrive

Let the current accepted state be `M`, with projection `P`. Let a candidate
ordinary root `C` have been authored from projection `B`, where `B` is found by
looking up the request's accepted base update. Canopy forms:

```text
M' = normalize(M + (C - B))
```

The request does not upload or calculate conflict metadata. Canopy already has
`M`; the client supplies the same candidate graph and accepted base ID it does
today.

### Exact retry

Check the authenticated request digest before modifying the expression. An
exact retry returns its recorded `UpdateResult`, including the same `state`,
and adds neither terms nor an observation.

### Candidate based on the current clean state

If `M = [P]` and `B = P`, then `P + (C - P) = C`. Exact cancellation produces
the usual clean accepted state `[C]`.

If the request's accepted base update is the exact current update but the
current state is already conflicted, still append the edit to that state. A
current-base `bytesHash` or `onConflict: "reject"` request is a continuation of
the selected projection, not permission to replace the merge state with `C`.
Only a stale exact/reject request takes the hard-failure path.

### Stale but cleanly mergeable candidate

For a current clean root `P` and stale basis `B`, evaluate
`P + (C - B)`. If all changes are independent, the materializer produces a
new projection `R` and the state collapses to `[R]`. The result remains
`outcome: "merged"` for existing clients.

### Candidate that introduces a conflict

Evaluate the same expression. Safe parts enter the new projection; ambiguous
parts retain the prior projection and remain as exact terms. Commit the state
instead of returning a server-update `409`. The accepted update may have
`previousRoot === root` when only alternatives changed, but its `state` and
observation ID must change.

### Update elsewhere while a conflict is open

Append `(C - B)` to the existing expression. At an unchanged conflicted path,
the candidate and basis values cancel locally. At independently changed paths,
the edit is applied and factored into every side during normalization. The
projected root advances, the old conflict remains, and syncing continues.

### Update touching an open conflict

Treat an ordinary update as an edit to the selected projection, not as a
resolution. Re-evaluate all exact terms plus `(C - B)`:

- a proven-independent edit moves the displayed region and is factored into
  every applicable side;
- an overlapping edit becomes another term in the local N-way merge;
- formerly separate overlaps derive one combined region;
- ambiguous alignment widens to the rule's containing unit;
- no unselected alternative is discarded merely because `C` was authored
  from selected content.

### More writers and plural updates

Each accepted conflicting candidate appends another remove/add pair before
normalization. Views support arbitrarily many signed terms; they must not
collapse the state to Base/Current/Mine. Identical positive and negative roots
cancel exactly. Provenance stays in accepted-update receipts.

Preserve today's candidate-to-candidate basis rule. For element zero, `B` is
the projection of the accepted `base` update. For element `n > 0`, `B` is the
ordinary candidate root submitted in element `n - 1`. Fold each element into
the preceding result. Each successful element gets its own accepted update.
A later hard rejection reports the completed prefix and untouched suffix.

### Explicit partial or complete resolution

An ordinary candidate never means "discard the alternatives." A
conflict-aware client submits a resolution-bearing `updates-v2` element:

```ts
interface ConflictResolutionV1 {
  state: ObjectHash;       // exact reviewed state
  region: ObjectHash;      // token from its derived view
  replacement: "candidate";
}

interface ResolutionCandidateUpdate extends CandidateUpdate {
  resolutions: ConflictResolutionV1[];
}
```

The candidate is the user's edited projected tree. Under the tree write lock,
Canopy must:

1. require `resolution.state` to equal the current state;
2. re-derive the region tokens with that state's frozen materializer;
3. reject missing, duplicate, overlapping, or stale tokens before mutation;
4. extract the replacement from the candidate at the region;
5. ask the owning rule to apply that replacement to all local signed terms;
6. leave every unlisted region and exact alternative untouched;
7. normalize and commit through the ordinary accepted-update transaction.

Whole-file resolution replaces that file value in every term. A Markdown-hunk
resolution rewrites only the reviewed derived hunk in each file term. A JSON
property resolution rewrites only that property. If the state advanced first,
return a typed `409 stale-conflict-view` carrying the current update/state;
this rejects only the resolution request and does not block later syncing.
When the last region resolves, normalization collapses to `[projection]`.

### Operations that still reject

Do not reify conditions whose safety policy cannot produce a valid projection:

- stale `bytesHash` updates or stale updates with `onConflict: "reject"`;
- account-configuration or authorization conflicts;
- invalid, incomplete, hash-mismatched, or policy-invalid candidate graphs;
- nested-tree boundary changes that cannot preserve access and identity;
- stale or malformed explicit resolution tokens;
- resource-limit failures.

A server-update content conflict under `modelHash` plus
`onConflict: "merge"` is the case that becomes an accepted reified state.

## Algebra and behavior to freeze first

Implement these pure laws as language-neutral fixtures before persistence. The
accepted log is ordered, so do not add an arbitrary permutation-equality law.

```text
identity:             normalize(M + (X - X)) ~= normalize(M)
exact continuation:   normalize([A] + (B - A)) = [B]
flattening:            flatten(D + ((C + (B - A)) - C)) = D + (B - A)
determinism:           identical ordered bytes produce identical state bytes
request idempotence:   one authenticated digest creates at most one receipt
prefix consistency:   fold(fold(S, P), Q) = fold(S, P ++ Q)
clean collapse:        no derived regions implies terms = [projection]
retention:             unrelated edits preserve every unresolved local value
local non-interference: disjoint A then B and B then A have the same projected
                       domain value and equivalent derived regions, although
                       state bytes and accepted ordinals may differ
resolution safety:     resolving reviewed R changes only R in that exact state
conservative locality: ambiguity widens and never attaches to the wrong value
```

Here `~=` means equal projection plus equal exact derived unresolved values,
not necessarily byte-identical synthetic directory roots. Define that
equivalence in one test helper.

## Current repository state

Confirm these facts during the drift check:

- `packages/core/src/protocol.ts` gives `RemoteTreeDescriptor` only `root` and
  `update`; local descriptors persist the same accepted base.
- `packages/wire/src/updates/types.ts` gives `AcceptedUpdate` only `root` and
  `previousRoot`, and models conflicts as a rejected prefix plus one draft.
- `packages/wire/src/updates/intent.ts` commits an ordered `updates-v1` string
  to a stable per-element authenticated request digest.
- `packages/canopy/src/updates/reconcile.ts` returns a projected merge plus a
  list of `UpdateConflict` values.
- `packages/canopy/src/canopy.ts:1070-1120` turns any nonempty merge conflict
  list into `409`, before storing generated objects or advancing the tree.
- `packages/canopy/src/updates/merge.ts` recursively performs a three-way
  Base/Candidate/Current merge and records conflicts while keeping one draft.
- `packages/canopy/src/updates/merge-rules.ts` implements line-LCS Markdown and
  stable-key collection-file rules. Markdown overlapping inserts are currently
  concatenated and counted as approximate placements.
- `packages/canopy/src/updates/store.ts` atomically compare-and-swaps only
  `trees.ref`, writes root-only reflog/history, and deduplicates requests.
- `packages/canopy/src/objects.ts` assumes each graph root is a `WireObject`;
  merge-state records need a dedicated store rather than masquerading as one.
- `packages/canopy/src/host.ts` exposes projection snapshots and root-only
  descriptors/watches.
- `packages/canopy-client/src/sync-state.ts` and
  `native/Packages/ArborWorkingTree` retain rejected material and stop for review.
- `packages/arborsync/src/service.ts`, `native/ArborApp/ArborAppModel.swift`,
  and the native conflict sheet expose today's stopped workflow.
- `packages/canopy/src/schema.ts` is schema version 6 and requires an offline
  migration for incompatible database changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused merge suite | `bun run test:sync-merge` | all listed Wire/Canopy/sync tests pass |
| Canopy merge unit | `bun test tests/unit/canopy/update-merge.test.ts` | exit 0 |
| Canopy host integration | `bun test tests/integration/canopy/update-host.test.ts` | exit 0 |
| Migration rehearsal | `bun run test:migration migrations/005-reified-tree-states` | exit 0 |
| TypeScript typecheck | `bun run typecheck` | exit 0, no errors |
| Product tests | `bun run test` | exit 0 |
| Protocol conformance | `bun run test:protocol` | TypeScript/live/Swift fixtures pass |
| Swift Wire | `swift test --package-path native/Packages/ArborWire` | exit 0 |
| Swift working tree | `swift test --package-path native/Packages/ArborWorkingTree` | exit 0 |
| Swift sync client | `swift test --package-path native/Packages/ArborSyncClient` | exit 0 |
| Build | `bun run build` | exit 0 |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Use the next migration number instead of `005` if another migration lands
before execution, and update every command/path consistently.

## Scope

### In scope

- `packages/wire/src/merged-trees.ts` (new), `packages/wire/src/index.ts`, and
  `packages/wire/src/updates/{types,json,intent}.ts`
- `packages/core/src/protocol.ts`
- `packages/canopy/src/{model,schema,objects,canopy,host}.ts`
- `packages/canopy/src/updates/{merge-expression,merge,merge-rules,reconcile,store}.ts`
- `packages/canopy-client/src/{sync-state,tree-sync,update-machine}.ts`
- `packages/arborsync/src/{tree-manager,service}.ts` and the minimum protocol
  surface needed to report accepted conflicts without `sync: "conflict"`
- `packages/arborsync-client/src/index.ts`
- `native/Packages/ArborWire/Sources/ArborWire/{WireModels,WireObjects,ArborWireClient}.swift`
- `native/Packages/ArborWire/Tests/ArborWireTests/ArborWireTests.swift`
- `native/Packages/ArborWorkingTree/Sources/ArborWorkingTree/{UpdateModels,UpdateDurability,UpdateMachine,UpdateCoordinator,ConflictWorkspace,WorkingTreeModels,WorkingTreeStateStore}.swift`
- focused `ArborWorkingTree` tests
- `native/Packages/ArborSyncClient/Sources/ArborSyncClient/Protocol.swift` and tests
- `native/ArborApp/{ArborAppModel,ArborDailyDriverViews,ArborRootView}.swift`
- `tests/fixtures/canopy/`, `tests/unit/{wire,canopy}/`,
  `tests/integration/canopy/`, and `tests/integration/self-sync.test.ts`
- `conformance/`, affected portable specs, `docs/client.md`,
  `docs/client-state-machines.md`, `docs/arborsync-api.md`, `status.md`, and
  directly affected package READMEs
- the next `migrations/NNN-reified-tree-states/` procedure and rehearsal
- Reliability 004 and plan indexes only for the explicit staged handoff

### Out of scope

- Conflict markers or alternative files in any filesystem projection.
- Replacing Wire trees with Pijul-style line/change graphs.
- Arrival-order-independent history or state.
- Reifying account, authorization, nested-boundary, or invalid-graph failures.
- A production parser for a new language or JSON. This plan proves the seam
  with existing rules and one synthetic structured test rule.
- Exposing private accepted-update history as a public revision API.
- Removing hard/local client conflict recovery.
- Changing Quagmire or its dependency pins.
- Canopy packing or general retention redesign. Current state terms simply
  become reachability roots under the existing policy.

## Git workflow

- Use branch `codex/reliability-007-reified-tree-states` if needed.
- Commit by coherent phase: algebra/Wire, persistence/migration,
  admission/read protocol, clients, then UI/spec/cleanup.
- Do not push, deploy, run a production migration, or change Quagmire pins
  unless separately instructed.

## Steps

### Step 1: Freeze the algebra and neutral bytes

Add `TreeMergeStateV1`, canonical CBOR encode/decode, validation, hashing, and
full-state bundle codecs in `packages/wire/src/merged-trees.ts`. A bundle
contains one state record plus a hash-sorted union of objects reachable from
`projection` and every term. Decoding verifies hashes, directory roots,
reachability, no extra objects, odd arity, and the requested state hash.

Add neutral fixtures for singleton, three-term, and five-term expressions;
exact cancellation; nested flattening; invalid even/empty terms; bad hashes;
file roots; missing/extra objects; and byte-identical TS/Swift encoding.
Implement the same codecs in ArborWire without adding state to `WireObject`.

Add `packages/canopy/src/updates/merge-expression.ts`. It owns signed-term
access, append-diff, flatten, deterministic exact cancellation, and test
equivalence. It must not import Markdown, paths, JSON, or collection concepts.

**Verify**:

```sh
bun test tests/unit/wire tests/unit/canopy/update-merge-expression.test.ts
swift test --package-path native/Packages/ArborWire
```

Expected: all vectors pass in both languages and malformed bundles reject
before any schema change exists.

### Step 2: Replace the three-way draft engine with an N-way materializer

Refactor `packages/canopy/src/updates/merge.ts` so its core input is an ordered
signed root expression and its output contains projection, normalized terms,
generated objects, derived conflicts, and rule summaries. Keep a thin
three-root adapter while callers migrate. Resolve exact algebra first, recurse
only where needed, and delegate unresolved leaves to a rule registry. Rebuild
normalized root terms as described above.

Define a representation-neutral rule seam in `merge-rules.ts`:

```ts
interface NWayMergeRule {
  readonly name: string;
  readonly version: number;
  matches(context: RuleMatchContext): boolean;
  materialize(input: SignedValueExpression, context: RuleContext): Promise<{
    selected: ObjectHash | undefined;
    normalizedValues: Array<ObjectHash | undefined>;
    regions: RuleConflictRegion[];
    summary?: MergeSummary;
  }>;
  resolve(input: ExactRegionResolution, context: RuleContext): Promise<SignedValueExpression>;
}
```

Generic code owns signs, hashes, directory recursion, current selection,
normalization, and state-bound tokens. Rules own parsing, N-way alignment,
overlap, exact reconstruction, validation, widening, and reviewed replacement.

Adapt current rules:

- Markdown preserves exact untouched source; frontmatter/body may be
  independent; invalid or ambiguous input widens instead of concatenating.
- Collection files keep stable-row identity and widen schema/constraint cases.
- Binary/unknown files produce one whole-value region.
- Page moves use PageID only when valid across relevant terms; nested-tree
  reference conflicts remain hard failures.

Also add one test-only nested-map rule with stable property keys and an
unkeyed array that widens. It must plug into the registry without adding a
JSON/property conditional to expression or directory code; this is the gate
for later JSON and source-code rules.

Test insertion before/after, repeated paragraphs, deleted apparent anchors,
disjoint and spanning hunks, partial resolution/splitting, heading/list/fence,
CRLF/final newline, Unicode, frontmatter/body, page move/edit, duplicate PageID,
simultaneous whole-document insertion, collection rows, and binary replacement.
Every localized case asserts exact bytes and terms; false attachment is never
an expected result.

**Verify**:

```sh
bun test tests/unit/canopy/update-merge-expression.test.ts tests/unit/canopy/update-merge.test.ts
```

Expected: algebra, normalization, N-way movement/combination/splitting/widening,
and source-fidelity fixtures pass; old approximate concatenation reifies.

### Step 3: Add atomic state persistence and the offline migration

Add `tree_states(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)`. Add non-null
current state references to `trees`, state/previous-state to
`accepted_updates`, and matching reflog fields. Bump the schema and update
`AUTHORITY_SCHEMA`; do not use startup `ALTER TABLE`.

Add a narrow state store that validates bytes, verifies every root graph,
supplies all terms to retention/reachability, inserts immutable bytes before
commit, compare-and-swaps `(trees.ref, trees.state_ref)`, and atomically writes
accepted update/reflog/transition/observation. Projection-unchanged but
state-changed commits must succeed.

Create the next `migrations/NNN-reified-tree-states/`. Give every historical
accepted root a singleton state, backfill current trees from their current
accepted update, and backfill reflog consistently. Follow the backup, authored
manifest, verification, foreign-key, and rehearsal conventions in
`migrations/README.md`. Do not deploy.

**Verify**:

```sh
bun test tests/unit/canopy/update-store.test.ts
bun run test:migration migrations/005-reified-tree-states
```

Expected: schema-6 fixtures migrate and reopen; state-only commits create one
observation; failed CAS creates no accepted row.

### Step 4: Admit reified conflicts through ordinary updates

Update `reconcile.ts` and `submitCandidateLocked()` to load the current state
and the projection of the accepted base update. For each ordinary element:

1. deduplicate by digest;
2. validate/reconstruct the candidate;
3. enforce exact/reject policy only for a stale base, and always enforce
   account/boundary policy;
4. append `(candidate - baseProjection)`;
5. materialize and normalize;
6. validate the projection;
7. store candidate/generated objects and state;
8. CAS both addresses and record the receipt;
9. return candidate-to-projection reconciliation as today.

Extend accepted updates and descriptors with `state`/`previousState`. Preserve
root fields, update kinds, and ordinary transitions. Use `kind: "merged"` for
reified acceptance. Add optional fields first for rolling decoding, make the
upgraded server always emit them, then require them when its capability is
advertised. Preserve hard-409 completed-prefix behavior.

**Verify**:

```sh
bun run test:sync-merge
bun test tests/integration/canopy/update-host.test.ts
```

Expected: a content conflict returns 201 with a new state; unrelated updates
advance; hard reject cases still return typed 409 with the correct prefix.

### Step 5: Add full-state and derived-conflict reads

Add immutable routes:

```text
GET /.arbor/trees/:tree/states/:state
GET /.arbor/trees/:tree/states/:state/conflicts
```

The first returns the CBOR full-state bundle; the second returns the JSON view.
The state must belong to a retained accepted update. Apply normal tree read
authorization: alternatives are accepted tree content readable by authorized
readers, while the public/filesystem projection still serves only `root`.
Do not expose request subjects or history.

Make objects reachable from any retained state term readable only in that tree.
Add state to descriptors, locators, watches, and accepted transitions. A
state-only transition has an empty ordinary payload but advances update/state.
Add TypeScript and Swift clients for both routes.

**Verify**:

```sh
bun test tests/integration/canopy/update-host.test.ts tests/integration/server.test.ts
swift test --package-path native/Packages/ArborWire
bun run test:protocol
```

Expected: shared bundles agree, state-only watches advance, authorized readers
see alternatives, cross-tree reads fail, and snapshots remain projection-only.

### Step 6: Add exact state-bound partial resolution

Extend codecs and intent identity with `updates-v2` only for elements carrying
`resolutions`. The digest commits to prefix, state, sorted non-overlapping
tokens, and candidate. Ordinary elements retain existing `updates-v1` bytes.

Implement validation and `rule.resolve()` under the same lock/transaction.
Unlisted regions cannot resolve implicitly. Return `stale-conflict-view` with
current update/state when stale; never partially apply.

Test whole-file choice, edited Markdown hunk, one of two hunks, combined
region, collection row, exact retry, duplicate/overlapping tokens, stale state,
racing update, and plural accepted-prefix plus stale resolution.

**Verify**:

```sh
bun test tests/unit/wire/update-intent.test.ts tests/unit/canopy/update-merge.test.ts tests/integration/canopy/update-host.test.ts
swift test --package-path native/Packages/ArborWire
```

Expected: cross-language digests agree; only reviewed regions close; last
resolution collapses the state; stale review changes nothing.

### Step 7: Let both clients advance through accepted conflicts

Persist accepted `{update, root, state}` together in TypeScript and Swift.
Continue to materialize only root, apply ordinary transitions, retire exact
pending elements, preserve suffixes, and advance state-only observations.

Add informational accepted-conflict status with state and derived count. It
must not set sync to `conflict`. Keep stopped records for hard 409s and unknown
filesystem divergence. Arbor Sync should be able to report:

```text
sync: idle, acceptedConflict: true, reviewableConflict: true
```

Cache full state for offline review only after verifying it. Never project
alternatives or markers to disk. Test accepted conflict plus pending suffix,
state-only advance, unrelated remote update, offline restart, retry recovery,
hard 409, and an old descriptor during compatibility.

**Verify**:

```sh
bun test tests/integration/self-sync.test.ts tests/unit/client-state-machines.test.ts
swift test --package-path native/Packages/ArborWorkingTree
swift test --package-path native/Packages/ArborSyncClient
```

Expected: reified conflicts never stop either state machine; projection,
update, state, pending inventory, and cursor converge after restart.

### Step 8: Replace ordinary server-conflict review with a live Canopy view

Adapt native presentation to read the conflict view/full-state bundle. Show
selected content and every relevant signed term, not just hashes. Keep current
path/stable key as locators and make many-sided conflicts legible.

Submit edits through state-bound resolution. Do not replace editor/disk content
until Canopy accepts. On stale state, refresh and preserve the user's edited
replacement as a review draft. Distinguish **accepted conflict; syncing
continues** from **sync blocked; action required**.

Only after TS/native soak fixtures pass should ordinary modelHash server
conflicts stop using Reliability 004's rejected workspace. Preserve hard/local
conflict review.

**Verify**:

```sh
swift test --package-path native/Packages/ArborWorkingTree
swift test --package-path native/Packages/ArborSyncClient
bun run test:protocol
```

Manual macOS/iOS acceptance: create a conflict, sync another page, restart,
resolve one region, then the last. Confirm no alternatives appear on disk. If
Joe offers to test/rebuild, stop app automation and hand this gate over.

### Step 9: Specify the contract and retire only obsolete behavior

Update portable tree/Wire specs with both addresses, canonical state grammar,
ordered algebra, normalization, projection/current-wins, updates/resolution,
plural retry/prefix, read routes/auth, derived regions, hard failures, and the
migration boundary. Update API docs, package READMEs, and `status.md`. Revise
Reliability 004 to own only remaining stopped conflicts.

Add a design note: Arbor adopted Jujutsu-like algebraic root terms and
recursive materialization, not Pijul's change-identified graph or a CRDT.

**Verify**:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:performance
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborWorkingTree
swift test --package-path native/Packages/ArborSyncClient
bun run test:migration migrations/005-reified-tree-states
git diff --check
```

Expected: all exit 0. Record exact commands/counts, baseline failures, and
manual evidence before moving this plan to `_done`.

## Test plan

Use `tests/fixtures/canopy/wire-merge.json` and current merge tests as patterns.
Neutral TS/Swift fixtures must cover:

1. canonical singleton/three/five-term bytes;
2. flatten, cancellation, clean collapse, deterministic normalization;
3. ordered repeatability and disjoint local non-interference;
4. one/two/many alternatives and unchanged-projection state changes;
5. Markdown region movement, combination, splitting, and widening;
6. exact source, collection, move, binary, delete/edit, and boundary cases;
7. unrelated updates through an open conflict;
8. partial/full/stale/racing resolution;
9. plural prefixes and exact retry;
10. full-state reachability and tree-scoped authorization;
11. state-only watches and transition application;
12. migration, CAS race, restart, and retention verification;
13. TS/Swift codec, digest, and state-machine agreement;
14. at least 1,000 unrelated edits while one conflict stays open;
15. explicit resource limits without corrupting later valid updates.

Do not assert stable region tokens across states. Assert exact selected content
and current alternatives.

## Done criteria

- [ ] Accepted state has ordinary `root` and content-addressed `state`.
- [ ] State contains only version/materializer, projection, and odd ordered
  exact roots; no conflict subtree or presentation history exists.
- [ ] TS and Swift agree on state, bundle, and resolution digests.
- [ ] Clean sequential updates collapse to one term.
- [ ] Model-hash merge conflicts are accepted and later sync continues.
- [ ] Current wins unresolved regions; safe parts appear immediately.
- [ ] Derived regions move, combine, split, and widen without durable anchors.
- [ ] Markdown, collection, binary, and a synthetic structured rule use one
  generic N-way interface.
- [ ] Partial resolution cannot remove unreviewed/racing alternatives.
- [ ] Plural updates, idempotence, prefixes, and reconciliation remain correct.
- [ ] State-only acceptance advances watches and both clients.
- [ ] Full state is easy to read but never appears in filesystem projection.
- [ ] Hard policy/exact/local conflicts remain typed failures.
- [ ] Migration backfills and verifies all accepted/reflog state.
- [ ] The 1,000-edit fixture shows bounded unrelated-update term growth.
- [ ] Native UI distinguishes accepted conflict from blocked sync.
- [ ] All Step 9 commands pass and evidence is recorded.

## STOP conditions

Stop and report instead of weakening a fixture if:

- expression identity, continuation, flattening, cancellation, prefix
  consistency, or deterministic ordered bytes fails;
- normalization loses an unresolved leaf's exact bytes;
- unrelated updates grow terms without bound or remove an alternative;
- Markdown attaches an edit to wrong repeated/moved content instead of widening;
- current-wins cannot produce a valid projection;
- syntax/path/region identity leaks into canonical state or generic storage;
- partial resolution needs durable predecessor-region metadata;
- state-only observations cannot advance safely;
- full-state reads cross the tree's existing authority;
- migration cannot make singleton states without changing roots;
- ordinary content requires reifying account or nested-boundary conflicts;
- completion requires Quagmire changes, deployment, or unrelated rewrites.

If one representation cannot localize safely, keep the algebra and use its
whole-value rule. Stop only if whole-value retention or unrelated-tree progress
also fails.

## Maintenance notes

- Review state/root atomicity, state-only observations, reachability authority,
  retries, and resolution races before UI polish.
- Materializer versions are immutable. Future JSON/source rules use a new
  registry version and shared old-state upgrade fixtures.
- Do not add Jujutsu's lossy same-change rule without a new version and explicit
  information-loss tests.
- Provenance may later join receipts to displayed terms; it stays observation
  metadata, not state identity.
- Packing/pruning must treat every root of every retained state as live.
- Pijul is evidence for a possible future graph model, not a hidden requirement.
