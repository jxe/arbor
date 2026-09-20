# Ancestor conflict deployment — 17 September 2026

Canopy revision `17f8393` on main was deployed to `https://arb.nxhx.org`, Railway
service `canopy-arb-nxhx-org`, deployment
`55f2c7ba-52ce-49b8-b0b5-8a476234cb55`. It adds the
[ancestor acceptance checkpoint](accepted-entry-conflicts.md#ancestor-acceptance-checkpoint).
Schema remains **11**. No migration, API change, writer pause or client restart
was required. Installed clients continue to emit ordinary snapshots.

## Backup and verification

An online SQLite `VACUUM INTO` backup plus immutable objects was retained under
`/data/backups/arbor-ancestor-deploy-20260917/` and downloaded to
`/Users/joe/arbor-ancestor-deploy-20260917/`. Both copies of `volume.tar` have SHA-256
`5cc2398518c8e5029efc55bb33e7078e93e4efa08b1d4a5a91b6f39241cac898`.

The new code opened a separate restored copy, passed full integrity verification,
and retained all 546 accepted updates with schema 11 unchanged. This is a recovery
checkpoint, not a quiescent cutover: later accepted work must be preserved if a
restore is ever needed.

Typecheck, all 779 product tests, the cross-language protocol gate and CLI build
passed. The known intermittent CLI reconnect test failed in the first full run;
the file-level rerun and subsequent full suite passed. Relative-link checks added
no unresolved links; 24 existing unresolved links remain.

Deployed hashes of all three changed production files match the tested source.
Railway reports success, and full production integrity verification passed with
schema 11. Authenticated reads of all three installed placements returned valid snapshots
and conflict inspection. No temporary content was written into the user's trees.

## Next client gates

The installed Native source-emission switch is still off. Complete interleaved
structural and stale-source admission across open documents, including pending
creation preservation, and the remaining emitted-form/recovery checks in
[008](../plans/canopy-swift/008-complete-native-move-copy-undo-capture.md). Then enable and release
clients, verify real application behavior and durable state, and remove the legacy
rejected-update recovery paths and UI. Do not infer multi-document branch coverage
from the existing linear mixed-queue test. Storage redesign remains deferred.
