# Merged predecessor continuation deployment — 17 September 2026

Revision `0e9fe3e` was pushed to GitHub main and automatically deployed by Railway
to `canopy-arb-nxhx-org`, serving `https://arb.nxhx.org`. Deployment
`33616e29-1908-4ff4-afe7-ae34068766b7` reports success; the deployed Canopy source
hash matches the tested revision. No API or schema change was needed: schema
remains **11**. Installed clients continued using snapshots throughout.

The server now uses a validated or exactly replayed update prefix to relate an
authored predecessor candidate to its accepted projection. Source continuations
preserve independent accepted entries. Same-file differences conservatively retain
alternatives; automatic range translation across a merged predecessor remains
future work. Original source bases and operation identities remain retained.

## Recovery and validation

An online SQLite backup and immutable objects are retained in
`/data/backups/arbor-successor-deploy-20260917/` and off-volume at
`/Users/joe/arbor-successor-deploy-20260917/`. The archive SHA-256 is
`32f2070f1807549face67ce322af438d9e245d80ad55e40396c2cef826e2b62e`.
A separate restored copy passed full integrity checks under the new code, retaining
557 accepted updates and schema 11. Later writes must be preserved if recovery is
needed; this is an online checkpoint, not a quiet-writer rollback boundary.

Typecheck, all 782 product tests, CLI build and the cross-language protocol gate
passed. The stronger Swift branch scenario covers create-A, stale-edit-B,
edit-B-again, continue-A, restart, uncertain acceptance, exact replay and resumed
structural actions. Production passed full integrity verification and authenticated
snapshot/conflict-inspection reads of all three installed placements. No temporary
content was written to the user's trees.

## Client transition

The checked Mac coordinator records and the iPhone's active coordinator record
contain no legacy conflict, hold, head, uncertain attempt or next base. This is a
point-in-time inventory, not a substitute for flushing and backing up before an
app upgrade. Historical format-recovery copies are preserved.

Native selects source admission for settled coordinators. Retained legacy work
continues through the compatibility path until settled; source-mode journals
cannot downgrade. The subsequent [installed-client cutover](native-source-cutover.md)
passed source publication and restart checks on both devices. Remove legacy
recovery code and UI after that gate, as recorded in
[008](../plans/native/008-complete-native-move-copy-undo-capture.md).
