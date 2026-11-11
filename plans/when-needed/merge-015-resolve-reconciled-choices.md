# overstoryd 015: Explain automatic resolutions and clear reconciled choices

**Why and when:** Joe encountered a whole-tree conflict after moving blocks into a
new page. Later accepted edits already produced the intended contents, but the
conflict remained and its cards showed only older alternatives. overstoryd should
clear choices it can prove reconciled, and Story should explain the current result
and make explicit resolution easy. When needed: when a conflict that later work has already reconciled shows up again. Its first step is the
foundation every automatic outcome needs, moved here from overstoryd 014 on
2026-10-11 and on to [Editor 003](../features/editor-003-suggestions.md#part-3-merge-notes)
on 2026-11-01.

Formerly "Resolve choices that later work has reconciled".

## What exists

The merge engine tracks ordinary edits through retained alternatives, but does not
have a rule that clears an existing whole-tree choice when later work reconciles
it. The normal removal paths require guarded `resolves`. The portable
[source-intent contract](../../docs/overstory-spec/1.3-updates-and-merging.md#35-format-aware-merge-rules)
already permits automatic authority resolutions with recorded justification;
ordinary saves and equal bytes cannot implicitly resolve choices.

The observed shape was a copy into a new page followed by a separate source
deletion. One retained alternative had the text in both pages, another had it in
neither. Later accepted contents combined the destination from the first with the
source from the second. This is evidence for a useful resolution, but comparing
file hashes alone does not establish which source identities or hidden edits a
resolution would preserve. Use synthetic fixtures, not the private captured text.

Story's explicit action keeps the pinned current root for any conflict group whose
linked choices are all loaded (whole-tree, file, range and coupled groups, since
2026-11-01). It uses the existing guarded review publication path.

## Remaining work

The explanation steps 2 and 3 record and show is a merge note, whose shape is
[Editor 003 part 3](../features/editor-003-suggestions.md#part-3-merge-notes)'s (Joe,
2026-11-01); step 2 needs it settled there. Rule revisions are
[overstoryd 017](merge-017-more-formats-and-open-cases.md#before-taking-a-case)'s.

### 1. Establish the automatic rule with a regression matrix

Start with a retained choice where later causal operations preserve all distinct
contributions and remove the original ambiguity. Trace each source identity,
copy origin, deletion, and placement through the later accepted operations.
Trace them from what history records, not from the merge engine's retained
detail ([Performance 004](https://github.com/jxe/arbor/blob/4844b1c/plans/soon/performance-004-provenance-index.md) decision 6): a
choice's placement is its range as each log entry records it, and source
identity is that entry's provenance index.
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
change. The explanation is a note in Editor 003 part 3's shape.

### 3. Explain and resolve current contents in clients

Show which current paths match each captured alternative and where further edits
exist. Distinguish a proven automatic reconciliation from a plausible combined
result requiring a person's choice. Allow inspection of current text alongside
captured text, with explicit additions, removals, moves, and hidden material.

“Keep current contents” exists for every conflict group
([status](../../status.md#merge-as-blocks-and-elements--2026-11-01)). Never substitute an
old selected alternative for current contents. Pin previews
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
