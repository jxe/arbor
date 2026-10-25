# overstoryd 015: Explain automatic resolutions and clear reconciled choices

**Why and when:** Joe encountered a whole-tree conflict after moving blocks into a
new page. Later accepted edits already produced the intended contents, but the
conflict remained and its cards showed only older alternatives. overstoryd should
clear choices it can prove reconciled, and Story should explain the current result
and make explicit resolution easy. Joe moved it to when-needed on 2026-10-25: take it when a
stale whole-tree conflict like that one shows up again. Its first step is the
foundation every automatic outcome needs, moved here from
[overstoryd 014](../when-needed/merge-014-merge-handles-many-cases.md) on 2026-10-11.

Formerly "Resolve choices that later work has reconciled".

## What exists

The merge engine tracks ordinary edits through retained alternatives, but does not
have a rule that clears an existing whole-tree choice when later work reconciles
it. The normal removal paths require guarded `resolves`. The portable
[source-intent contract](../../docs/overstory-spec/10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution)
already permits automatic authority resolutions with recorded justification;
ordinary saves and equal bytes cannot implicitly resolve choices.

The observed shape was a copy into a new page followed by a separate source
deletion. One retained alternative had the text in both pages, another had it in
neither. Later accepted contents combined the destination from the first with the
source from the second. This is evidence for a useful resolution, but comparing
file hashes alone does not establish which source identities or hidden edits a
resolution would preserve. Use synthetic fixtures, not the private captured text.

Story's initial explicit action keeps the pinned current root for an independent
whole-tree choice. It uses the existing guarded review publication path. Extend
this to smaller scopes and coupled groups only after their obligations are checked.

## Remaining work

### 0. Give automatic outcomes a portable explanation

Steps 2 and 3 record why the host resolved something and show it in clients. That
needs three things first, which [overstoryd 014](../when-needed/merge-014-merge-handles-many-cases.md)'s
candidates reuse:

- **The three outcomes in the spec.** Add 014's three constraints (lose nothing,
  keep the syntax, keep the meaning as far as possible) and three outcomes (merge,
  merge with a note, review) to
  [source intent §7](../../docs/overstory-spec/10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution)
  as what any merge tool may do. The spec permits all three and requires only the
  first two constraints for an automatic outcome. How eagerly a tool merges is its
  own choice.
- **A portable note.** §7 already requires an automatic resolution to record its
  justification, and lets each rule define extra evidence fields. A note needs a
  shape clients can show without knowing the rule: a short message, the affected
  range or path, and whether someone has seen it. Specify it in §7, carry it in the
  log entry's decision evidence, and show it in the editor's margin beside choices
  from the portable
  [accepted-state review contract](../../docs/overstory-spec/09-client-synchronization.md#accepted-state-review).
  An authority resolution of a reconciled choice (step 2) is the first thing that
  writes one.
- **Rule revisions.** §7 requires evidence to name a rule's identity and revision,
  so a change to what a rule decides bumps its revision. **Open:** the first round
  of 014 changed the Markdown, JSON, YAML and TS/JS rules' decisions without bumping
  them from `revision: 1`, and it is deployed. Replay aligns to recorded decisions,
  so history is not reinterpreted either way; decide whether to bump them now, and
  add a test that fails when a rule's decisions change without a bump.

Update the protocol models, Swift and TypeScript decoding, fixtures and
conformance vectors together.

### 1. Establish the automatic rule with a regression matrix

Start with a retained choice where later causal operations preserve all distinct
contributions and remove the original ambiguity. Trace each source identity,
copy origin, deletion, and placement through the later accepted operations.
Define precisely when they discharge every alternative's outstanding obligation.

Cover the observed copy/delete sequence and a true atomic move; independent peer
edits before and after both; edits of the copied source; duplicate equal text with
different identities; intentional copies; later undo; deleted ancestors; nested
choices; and genuinely competing destinations. A later timestamp, a matching
hash, or a no-op save must not suffice. If evidence is incomplete, retain review.

### 2. Record and accept an explicit authority resolution

Implement the rule in overstoryd's merge engine, with a stable rule identity and
revision. Record the accepted state, complete guarded alternatives, resulting
root, provenance mapping, and a concise justification. Preserve independent
choices and validate dependencies atomically. Recheck after concurrency; reject
or recompute stale evidence. Exact retries, restart, cached and cold replay must
reproduce the same accepted history without reinterpreting older resolutions.

Keep the resolution separate from the fact that a new edit was accepted. Decide
and document how the host represents its authority authorship in the accepted log
and how a client discovers the explanation. Update protocol models, Swift and
TypeScript decoding, fixtures and conformance tests together if exposed shapes
change. The explanation is step 0's note.

### 3. Explain and resolve current contents in clients

Show which current paths match each captured alternative and where further edits
exist. Distinguish a proven automatic reconciliation from a plausible combined
result requiring a person's choice. Allow inspection of current text alongside
captured text, with explicit additions, removals, moves, and hidden material.

Extend “Keep current contents” to file/range choices and dependency groups. Compile
one guarded resolution that preserves all current bytes and independent choices.
Never substitute an old selected alternative for current contents. Pin previews
to the accepted state and reject stale submission; retain drafts across restart
and uncertain acknowledgement. Include Swift and TypeScript client APIs and the
web reviewer when rebuilt. Show automatic resolutions with their reason and
history access without leaving a blocking conflict card behind.

## Verification and delivery

- Synthetic engine tests demonstrate both automatic discharge and near misses
  that remain reviewable; byte equality without causal coverage remains unresolved.
- Disposable overstoryd integration tests include batching, concurrency, retry,
  restart and cold replay; authority resolutions leave a reproducible explanation.
- Client tests preserve current CRLF/Unicode bytes, later edits, unrelated choices,
  dependency obligations, stale guards and durable drafts.
- Check the UI against a conflict whose current result differs from both old
  alternatives. A person can understand and keep that result without losing it.
- Run `bun run test:affected` on the changed paths, and `bun run test:protocol`
  when an exposed shape changes. Record implemented and installed evidence
  separately in status; the host change is deployed when it reaches main. Resolving
  a live conflict requires Joe's go-ahead.
