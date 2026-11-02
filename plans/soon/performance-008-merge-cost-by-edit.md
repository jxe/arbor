# Performance 008: merge cost by edit, not by size

**Why and when:** split out of [Performance 004](https://github.com/jxe/arbor/blob/4844b1c/plans/soon/performance-004-provenance-index.md)
when Joe closed it on 2026-11-02. 004 made merges start from a provenance index instead of
replaying history (steps 1 to 5, deployed; see [status](../../status.md#performance-004-merges-start-from-the-provenance-index--2026-11-02)).
These two pieces were left. Soon.

## Status

**PLANNED · not started.** Read status.md's Performance 004 entry,
`docs/architecture/overstoryd/merge-tool.md` and
`docs/architecture/overstoryd/provenance-index.md` first.

## 1. Canonical contribution order

Inside a choice, the engine lists contributions in its history map's bucket order, an
implementation detail. In 004's step 1 rehearsal on the Oct 28 todos copy, 7 of 604
questions answered from the index differed from full history only by that order. Sort
contributions canonically (acceptance order) wherever the engine emits them, so an answer
from the index and one from full history are byte-equal. Check: rerun
`tests/performance/provenance/rehearse.ts` on that copy and expect those 7 to match.

## 2. Collections: cost by edit, not by size

Moved from Schema language 005 milestone 4 (Joe, 2026-10-24: the merge sidecar is already
too slow; combine this with the other merge improvements). A logical collection is a
`table` object per model listing content-defined `rows` chunks (spec 06 §2.1), but
`collection-fields-v1` (`packages/tree-merge/src/merge-rules.ts`) and row replay load and
re-encode whole tables, and the engine holds a collection as one opaque value, so the
provenance index doesn't help. Measured 2026-10-28: a one-row edit in a 10,000-row
collection is about 35% slower than before logical collections, because a changed
collection is re-encoded whole. Instead:

- Merge compares table hashes, then chunk hashes. Chunks all three sides share appear in
  the same order on each, so the rows between two shared chunks are the only ones to decode
  and merge.
- Replay decodes only the chunks holding the keys an operation names.
- Re-encoding reuses every unchanged chunk, re-chunking from the first changed one until a
  boundary lines up again; a reused chunk is emitted as is only where the chunker would
  start a fresh chunk.
- Benchmark first (new, in `tests/performance/`): a 50,000-row collection with one
  concurrent edit on each side, and a one-row fast-forward on it, against the same edits on
  a one-chunk collection.

[Performance 007](../later/performance-007-sqlite-collection-storage.md) (collections kept in
SQLite on the host) would change where this work happens; if it moves to soon first, redo
this section against it.
