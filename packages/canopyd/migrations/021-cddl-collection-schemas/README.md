# Migration 021: declarative collection schemas (authored trees)

One cutover for authored working trees, not for the host database. The build
that needs it retires the executable `schema.ts` collection schema: collection
files and Markdown collections are governed by a declarative `schema.cddl`
([child backings §2.4](../../../../docs/overstory-spec/06-child-backings.md#24-collection-schema-profile)),
directory descriptors move from version 1 to version 2, and nothing in canopyd,
the merge worker or Arbor Sync evaluates JavaScript to read a collection. The
canopyd SQLite schema stamp does not change.

**Status: written and tested on disposable copies only. No operator inventory
has been taken, nothing has been converted on real data, and there is no live
cutover.** Each of those waits for Joe's go-ahead.

## What changes

- **Authored files.** In each directory whose `schema.ts` converts, `run.ts`
  writes a `schema.cddl` translated from the Zod schema's own JSON Schema, then
  removes `schema.ts`. Rows, `_store.*` bytes, Markdown bodies and every other
  file are untouched.
- **Accepted trees.** Nothing is rewritten in place. Retained roots, their
  version-1 descriptors and their `schema.ts` bytes stay exactly as they are.
  After the new host is deployed, the converted working tree submits an ordinary
  update that replaces each version-1 directory with a version-2 one; the host
  accepts it because an unconverted collection in the current state is left
  unproven rather than reinterpreted ([§2.5](../../../../docs/overstory-spec/06-child-backings.md#25-retired-version-1-schemats-collections)).

Unchanged: TreeIDs, stable keys, logical names and row values of every
converted collection, which `run.ts` proves before it writes (below).

**Behaviour the build changes with it.** Validation no longer normalizes: it
never inserts defaults, strips undeclared members, coerces, or transforms. CSV
cells convert by their declared column type instead of `z.coerce`. A collection
still governed by `schema.ts` is an explicit error everywhere: Arbor Sync shows
`legacy-collection-schema` and refuses to snapshot a tree that holds a
`schema.ts` collection file; the host answers `422 unsupported-operation` for a
candidate containing a version-1 descriptor and for reads of one still in a
current state; a merge touching one is a `collection-file-schema-conflict`.

## Preconditions and proof

`run.ts` evaluates each `schema.ts` once, in its own offline process, with the
checkout's Zod (a root development dependency that no runtime package or the
production image contains). For every collection it then compares, row by row,
the retired interpretation (`schema.safeParse` of the exact source values) with
the declarative one (the translated schema through the shared codec): the same
row count, validity, stable key, logical name, and canonical properties. It
converts a collection only when every row matches and the translation is exact.
Otherwise the collection is reported `blocked` with its reasons and left alone:

- `.transform`, `.refine`, `.superRefine`, `.preprocess`, `.pipe`, `.catch`,
  `.default` and similar value-changing or refining calls;
- JSON Schema keywords with no profile equivalent (string lengths and patterns,
  one-sided or exclusive number bounds, `default`);
- rows that `schema.ts` normalized, stripped or defaulted, such as an undeclared
  member Zod silently dropped, a CSV cell `z.coerce` accepted that the typed
  conversion rejects, or an empty optional CSV cell (Zod kept `""`; the profile
  reads it as absence).

A blocked collection needs an authored `schema.cddl` (and possibly a data edit)
before the cutover; `run.ts` never claims generic Zod-to-CDDL equivalence.

## Commands

```sh
bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --dry-run <tree…>
bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --backup <new-dir> <tree…>
bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --rollback <backup-dir>
```

The report is one JSON line on stdout: each collection's directory, backing,
status (`would-convert`, `converted`, `resumed`, `already-converted`,
`blocked`), row count and blockers, and the new schema hash. It never contains
schema or row content. Exit status is 1 when any collection is blocked.

- **Order.** Back up the exact `schema.ts` into `--backup`, write `schema.cddl`
  atomically, then remove `schema.ts`.
- **Repeated runs** report `already-converted` and change nothing.
- **Interruption** between the write and the removal leaves both files; the
  next run resumes only when the existing `schema.cddl` is byte-identical to the
  translation, and otherwise blocks on the ambiguity.
- **Rollback** restores each backed-up `schema.ts` byte for byte and removes its
  `schema.cddl`, but only while that `schema.cddl` is unchanged since
  conversion. It is a matched-version rollback: it pairs with the previous
  host and client builds, which cannot read version-2 descriptors.

## Runbook (not yet authorized)

1. **Inventory.** With the current build, Joe lists every placement path, and
   `run.ts --dry-run` runs over them (and over any tree only the host holds,
   materialized to a disposable working tree). Every `blocked` collection gets
   a hand-written `schema.cddl` or is left unconverted by decision.
2. **Back up and reconcile.** Wait until every placement is idle in
   `GET /v1/trees`, so no old-client write is queued; take the host backup
   archive and the authored manifest and `~/.arbor` copy as in the
   [migration procedure](../README.md#the-procedure); stop the daemon and Canopy
   on the iPhone.
3. **Deploy** the new host build. Its current states still hold version-1
   collections, which it serves as `422 unsupported-operation` until step 5.
4. **Convert** each placement with `run.ts --backup`.
5. **Bring the Mac back** on the new build. Each converted tree submits its
   version-2 collections as one ordinary update; confirm each tree's `update`
   advances and a collection page lists its rows.
6. **iPhone last.** Only a build that decodes version-2 descriptors can read
   converted trees.

Rollback before step 5 is the host archive restore plus `run.ts --rollback`.
After step 5, accepted history holds version-2 roots, so rollback also means
restoring the host archive.

## Rehearsal log

- 2026-09-24: `bun run test:migration packages/canopyd/migrations/021-cddl-collection-schemas`
  passes on generated disposable trees: dry run changes nothing and reports the
  three blocker kinds; conversion preserves keys, names and values through the
  new local provider; a repeated run is a no-op; an interruption resumes; a
  conflicting `schema.cddl` blocks; rollback restores the original bytes.
- 2026-09-24: a disposable copy of `tests/fixtures/workspace` with its former
  `books/schema.ts` converted (`would-convert`, then `converted`, then
  `already-converted`) and rolled back to the original bytes.
