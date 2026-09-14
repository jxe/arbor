# Conflict intent: thought experiment and executable model

The initial [snapshot experiment](conflict-terms-experiment.md) demonstrated
durable alternatives but could not select a backend. These examples ask what
information the backend must retain when editors supply observed operations and
Canopy understands source structure. Desired behavior below is an Arbor design
choice; it is not a claim that unmodified Jujutsu or Pijul implements Arbor's UX.

Jujutsu records unresolved merges as signed expressions of trees and simplifies
them by cancellation. Pijul identifies content by introducing change and range,
with change-labelled relationships; equal content introduced independently need
not have equal identity. Pijul's theory explicitly uses independent deletions and
concurrent delete/edit as examples motivating causal labels.
Sources: [Jujutsu conflict model](https://docs.jj-vcs.dev/latest/technical/conflicts/),
[Pijul theory](https://pijul.org/manual/theory).

## 1. Independent fields: source intelligence does most of the work

Base frontmatter is `title: Draft` and `status: open`. Alice changes the title;
Bob changes status to `closed`. Desired result has both changes and preserves
the untouched source. A text overlap in the same frontmatter envelope should
not imply a field-level disagreement.

Canopy can identify keys; editor `set-field` operations make targets explicit.
Terms can merge the independent components. A graph can retain independent
changes, but needs the same field semantics to explain the result. This case
does not select a backend. Existing Canopy frontmatter/collection rules already
provide relevant source intelligence; the new model does not implement a second
frontmatter parser.

## 2. Move versus copy while another writer edits

Base is paragraphs `P: Alpha` followed by `Q: Beta`.

Alice moves P after Q; Bob changes P to `Edited`. The desired result is
`Beta; Edited`, with one P. With a verified target, a term model can merge
placement and content independently. A graph can express content identity
separately from placement, provided the move is actually encoded that way.
Neither representation recovers an unrecorded move intention by magic.

Now Alice **copies** P after Q. Desired result is `Edited; Beta; Alpha`:
the original receives Bob's edit, while the copy gets a new identity and the
source Alice copied. This assumes a copy freezes the source visible to its
author, rather than creating a live reference. A move must preserve identity;
a copy must not. Both backends need that distinction from the operation or
reliable correspondence. Equal bytes cannot decide it.

## 3. Repeated text, then a move

Base contains two different paragraphs with identical text: `P: Same`,
`Q: Same`. Alice edits Q to `Second`; Bob moves Q into another file.
The result must leave P alone and put `Second` in the new file.

A source range bound to the exact base identifies Q at admission. Later work
also needs a retained mapping from that occurrence to its moved identity.
Terms can use a persistent paragraph target; a content graph offers finer
identity. The graph has an advantage in built-in granularity, but whole-paragraph
moves do not alone justify a graph for all bytes. Crucially, an editor-local
BlockID is not proof of shared identity across devices.

## 4. Delete/edit: what the deleter had observed matters

Alice deletes P while offline; Bob edits P. Desired result preserves a
delete/edit disagreement. Do not silently discard Bob's text or restore P as
an unexplained addition. The selected ordinary projection may show absence,
provided review retains the edit and honestly signals the conflict.

Contrast Alice reading Bob's edit and then deleting P. The same final candidate
omits P, but now the deletion causally includes Bob's revision. That can be a
clean deletion. Both representations need the observed revision, not merely
the deleted bytes. Pijul's causal relationships naturally address this issue;
terms require retained operation/basis identity as well.

## 5. Two deletions, then undo only one

Alice and Bob independently delete P. Both candidates have identical bytes.
Alice later invokes undo on **her deletion**, without seeing Bob's.

Desired result: Bob's deletion remains effective. Alice's undo is not an
unconditional request to restore P over everyone else's actions. A separate
explicit restore operation could have different semantics.

If storage collapses both deletions to “P is absent”, the distinction is gone.
A term backend must retain both contributions and target the inverse at Alice's
operation. A graph with change-labelled deletions has a natural place for this
evidence. This is a strong argument for persistent causal identity; it does not
by itself require a graph of every source range.

## 6. Edit an unresolved alternative back to old bytes

Base says Monday. Accepted alternatives say Tuesday and Wednesday, and the
projection shows Wednesday. Alice edits the Wednesday alternative to Monday.

Desired result: unresolved alternatives Monday and Tuesday, with Monday visible.
The original root-term experiment instead computes
`Monday + (Wednesday + Tuesday - Monday) - Wednesday = Tuesday`, and therefore
has to reject the edit to avoid silently resolving it.

With explicit targeting, the new Monday is an authored revision of the Wednesday
alternative, not the ancestral Monday. Replace that positive alternative with
the new revision; do not cancel by byte equality. A later explicit resolution
can retire the alternatives. The richer term model below accepts this case.

Now move the document and let another offline writer edit the hidden Tuesday
alternative. The accepted projection can remain byte-identical while the
unresolved state changes. The operation and retry identity must survive the
move, independent of the ordinary root hash. Both backends need that capability.

## 7. Split and combine paragraphs: the more discriminating case

P contains sentences S1 and S2. Alice splits P, moves S2 into Q, and later
combines Q with another paragraph. Bob edits S2 against the old P. Another
writer edits a visually identical S2 elsewhere.

Desired result: Bob's edit follows the specific original S2 through the split
and combination, without touching the duplicate. A single paragraph ID is
insufficient. We need correspondence between source ranges, their successors,
and operations that split, copy, delete, or relocate them.

A Pijul-style content graph is a more direct representation for that retained
range identity, although its adapter still has to encode the intended operation.
A term backend can add range lineage, but it may then be building much of the
same machinery. This is the next discriminating case. The model below explicitly
rejects split operations; it does not claim to solve them or use that rejection
as evidence against Jujutsu itself.

## Executable follow-up

The thought experiment was inconclusive about a full backend choice, so a small
[source-intent model](../packages/canopy/src/experimental/conflict-terms/intent-model.ts)
and [20 tests](../tests/unit/canopy/conflict-intent-model.test.ts) were added in
the same isolated worktree. This is not an implementation or benchmark of Pijul,
nor unmodified Jujutsu. It tests whether a smaller enriched term model can
represent the required behavior before committing to a content graph.

The model introduces:

- Source targets bound to initial chunks of exact source, with independent body
  and placement terms. Initial correspondence is supplied as an explicit input,
  not inferred by a new parser.
- Revision identities derived from operation ID and effect ordinal. Terms refer
  to those revisions, not content hashes. Equal text can have different identity.
- Delete contributions recording which body/placement revisions were observed,
  and an inverse operation addressing one particular deletion.
- Explicit alternative edits and state-fenced resolution.
- Ordered effect groups checked against the exact base and candidate projection;
  guards reject contradictory source, wrong TreeID, and invalid copy identities.
- A serialized semantic log that replays the same accepted states and request
  receipts after reconstruction. Transport bytes alone do not identify intent.

The tested outcomes match cases 2–6: both arrival orders for move/edit,
copy/edit, and concurrent delete/edit; repeated text; observed-versus-concurrent
deletion; selective undo; editing an alternative back to its old bytes; an
offline edit to a hidden alternative after a move; resolution fencing; and
exact source plus grouped operations across serialization and retry.
One paired test submits the same Monday/Tuesday/Wednesday/Monday source sequence
to the existing snapshot backend and the new model: the former rejects the last
ordinary edit, while explicit alternative identity lets the latter accept it
and retain both alternatives.

These passes depend on more than bare terms. The source-target registry,
authored revision identities, and deletion contribution records are essential.
The conclusion is that these cases do not yet require a **content-order graph**,
not that provenance can be thrown away. The retained operation log itself
encodes causal relationships.

Limits are explicit: whole-source-chunk replacement, no range lineage or
automatic sub-paragraph merge, fixed collision-checked placement slots rather
than general list ordering, one TreeID without production authorization, and
unbounded retained operation history. Reconstruction tests are not crash-durable
storage or a compaction proof. Candidate validation proves the declared effects
match the source; it does not independently prove human intention or solve
cross-device target discovery. Two independent identical edits remain separate
alternatives; user-facing treatment of equivalent effects remains a policy choice.

No production routes, schemas, Swift models, or client behavior changed. The
next backend comparison should concentrate on case 7 and safe history compaction,
using the same source bindings and intent evidence for both implementations.

## Verification

```sh
bun test tests/unit/canopy/conflict-intent-model.test.ts tests/unit/canopy/conflict-terms.test.ts
bun run typecheck
bun run test
```

The focused suites passed 46 tests (20 new, 26 existing), including namespace
collision and unsupported-operation refusal. Typecheck and the CLI build passed.
The product suite passed 427 tests with the one existing child-title mismatch
(`One` expected, `one` returned), already reproduced in the original checkout
during the snapshot experiment. Repository-wide link checks found no newly
broken targets; whitespace checks passed. Public protocol and Swift packages
are unchanged by this model and were not rerun in this follow-up.
