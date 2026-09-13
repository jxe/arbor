# Migration 005 verification

2026-09-12/13: disposable migration tests pass, including exact binary bytes,
nested-tree identity, a single restored accepted update, idempotent retry, and
refusal to switch schema or roots on corrupt legacy bytes.

## Production-copy rehearsal: passed

The schema-6 archive contains five trees. Two independently restored copies
produce identical migration reports: 119 retained objects and 3,967 pruned
historical objects. All three Mac placement roots, hashed from their filesystem
bytes without the index, equal the migrated roots. The local backup copies yield
the same roots. The new server serves every migrated tree through authenticated
Wire descriptor and complete snapshot reads. `CanopyDaemon.verifyIntegrity()`
passes on the second migrated copy.

Verified archive SHA-256:
`1b38081856385976cd19336e7565678910dcbdf70c90ffe18dc052d5453208b5`.
Compressed archive SHA-256:
`20617a9851e1fb7c3783ff8f45df378b239782268f3192b04549a1ae96578b35`.
The compressed archive was transferred over SSH as base64 and checksum-verified;
the slower volume downloads were cancelled after the verified transfer.

Before cutover, all Mac placements were idle with no pending or blocked
bootstrap and their accepted roots/updates matched live Canopy. The paired
phone's persisted accepted and materialized roots matched the same todos tree
at update 1581, with no pending head, attempt, conflict, or hold. Joe reported
that both devices looked the same and was asked to leave the editors idle.

Private backups, reports, restored copies, and authored manifests are under
`/Users/joe/arbor-migration-005-20260912/`. Mac Application Support/Arbor is a
symlink to `~/.arbor`; `dot-arbor.before` is the actual backup. `phone.before`
contains the phone's Arbor application-support data. The server archive is under
`/data/backups/migration-005-20260912/` on `canopy-arb-nxhx-org`.

## Code verification

Typecheck, Wire protocol gate, build, performance gate, focused merge suite,
Swift object-store/working-tree/account tests, and the local Quagmire test
wrapper pass. Both signed native builds and the iOS Simulator build pass.
Conformance regeneration is a fixed point. The product suite has 381 passing
tests and one pre-existing expanded-child title failure, reproduced on unchanged
HEAD. Relative-link results match the baseline; `git diff --check` passes.

## Live cutover: passed

The live migration report exactly equals both rehearsals. Deployment
`645253b7-cd23-4917-aaa1-084a0845dc3a` serves schema 7 and passes live
`CanopyDaemon.verifyIntegrity()`. The previous application deployment for
coordinated rollback was `5611a949-4f0d-4456-bd16-8c79a568e770`.

The Mac daemon and both signed native clients are upgraded. Every Mac placement
became idle at the rehearsed root. The phone rebootstrapped to the same raw todos
root at update 1584, with its old state retained for recovery. Immediately after
cutover the authored manifest had 107 files and zero changed files.

Joe added content on iOS and confirmed it synchronized; the Mac and Canopy retain
that edit. A temporary Mac Markdown file was accepted at update 1588, returned
byte-for-byte through the raw object endpoint, and reached the phone. Removing
that file restored the pre-check content, including Joe's new edit, at update
1589. Final uncached filesystem hashing agrees with live Canopy for all three
placements. After foreground catch-up, the phone's accepted and materialized
roots also agree at update 1589. The only authored-file change after the initial
migration verification is Joe's new `_index.md` edit; no temporary file remains.

Final todos root:
`sha256:10a23db8da42b74bc311a0c8dc654cb700348761dd63f2631d27342ab46abdbb`.

The several-day soak has started; it is not yet complete. Keep the verified
archives and old client state during that period. Any rollback now must preserve
new post-cutover edits rather than restoring an old backup over them.
