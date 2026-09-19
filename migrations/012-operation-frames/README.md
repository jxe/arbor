# Migration 012: operations become a frame chain (13 → 14)

Carries [Canopy 010](../../plans/canopy/010-operation-frames-and-lazy-history.md)
Phase 2. The wire field `operations` is replaced by `trace`, a chain of
`{before, after, operations}` frames, and the request digest domain becomes
`arbor-update/2`. Retained authored intent follows: `authored_changes.operations_json`
becomes `trace_json`.

A schema-13 row carried a flat operation list from its `basis_root` to its
`candidate_root`, which is exactly one frame. The conversion is that wrapping
and nothing else. A row with no operations keeps an empty chain rather than
inventing a frame. No accepted root, object, receipt, conflict or evidence row
is rewritten, and no request is resubmitted.

## Offline schema step

After a full checksummed database/object backup and with writers quiesced:

```sh
bun migrations/012-operation-frames/run.ts --offline-database /offline/canopy.sqlite3
```

The tool checks the schema-13 stamp and SQLite integrity, renames the column,
rewrites each retained row's intent inside one transaction, and advances the
stamp. A schema-14 rerun diagnoses the completed state. Startup performs no
automatic migration.

## Deploy together

This is a clean wire break, so the server and both Native apps ship in one go
(see the plan's Phase 2 risks). A client built before the cutover sends
`operations` and is rejected at decode by the new server — never reinterpreted —
and a new client's `trace` is rejected by an old server the same way.

An update that was in flight across the cutover and is retried afterwards
carries the same change identity with a different signature, because the
signature now covers the frame chain. The authority answers "Change identity
reused with different intent"; the client derives a fresh change and resubmits.

## Verification

```sh
bun run test:migration migrations/012-operation-frames
```

Then, on the isolated copy with the matched server/client artifacts, take one
live edit from Mac and one from iPhone and confirm the update log records
`trace-frames: 1` and the same accepted roots as before.
