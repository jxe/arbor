# overstoryd 015: Resolve choices that later work has reconciled

**Why and when:** Joe encountered a whole-tree conflict after moving blocks into a
new page. Later accepted edits already produced the intended contents, but the
conflict remained and its cards showed only older alternatives. Address this after
the page-transfer fixes: overstoryd should clear choices it can prove reconciled,
and Canopy should explain the current result and make explicit resolution easy.

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

Canopy's initial explicit action keeps the pinned current root for an independent
whole-tree choice. It uses the existing guarded review publication path. Extend
this to smaller scopes and coupled groups only after their obligations are checked.

## Remaining work

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
change. This builds on [overstoryd 014](014-merge-handles-many-cases.md), especially
its work on merge notes and rule revisions.

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
- Run the full repository gate before closing this plan; record implemented,
  installed and deployed evidence separately in status. Live resolutions and
  deployment require Joe's go-ahead.
