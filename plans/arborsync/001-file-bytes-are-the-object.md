# Arbor Sync 001: File bytes are the object

## Status and scope

- **Status:** SOAKING, 2026-09-13. Implementation, production-copy rehearsal,
  synchronized-client cutover, and both client upgrades are complete.
- **Priority:** first, alongside the minimal Wire contract in
  [Reliability 007](../_done/reliability/007-reify-composable-canopy-conflicts.md).
- Joe authorized implementation and resetting accepted history, conditional on
  every participating client being synchronized. Do not reset unverified data.

External clients need a durable Canopy Wire API now. Raw file hashes and typed
entries land before object-store extraction or a particular conflict backend.
Conflict exploration and resolution remain optional, versioned extensions.

## Implemented contract under verification

The portable source of truth is [tree operations](../../spec/01-tree-operations.md).
A file object is exactly its payload bytes; its SHA-256 is the file hash.
Directories are canonical CBOR. Each entry has `name` and exactly one of `file`,
`directory`, or `tree`. A root is a directory. Kind comes from the reference,
never from sniffing the payload.

Complete and sparse graph validation require every directory, reject mixed-kind
references to one hash, reject unreachable members, and check exact hashes.
Sparse mode alone permits absent file payloads. Bootstrap additionally includes
Markdown. The bootstrap `files` map and Swift prefix sniffing are removed; file
sizes can remain unknown until payload read. Object responses use
`application/octet-stream`; snapshot bundles remain canonical CBOR version 1.

TypeScript exposes directory-specific codecs. Swift retains `WireObject` as a
typed in-memory value and `WireObjectCodec.decode(_:kind:)` with an explicit
kind. This is not a compatibility decoder: file encoding is raw and legacy
`hash` entries are rejected. There is no old-format decoder outside the frozen
migration code.

Canopy schema 7 refuses unmigrated storage. Daemon private-state format 5 archives
old refs and sync journals before rebuilding indexes. Native working-tree format
5 archives the old working tree and sync state before rebootstrap. These recovery
copies never replay automatically against reset history. Exact authored files,
TreeIDs, placement paths, account identities, and credentials survive.

The internal service decomposition is implemented separately from the public
Wire change. The earlier hardlink-directory proposal is retired. Snapshot and integrity operations
still read file payloads when they must return or verify those bytes; typed graph
traversal no longer decodes files to classify them.

## Verification completed

Completed the relevant gates in [DEVELOPMENT.md](../../DEVELOPMENT.md), including:

- TypeScript typecheck, product tests, protocol tests, build, performance gate.
- Swift ArborWire, ArborWorkingTree, ArborObjectStore, ArborSyncClient and
  CanopyClient tests; local-workspace native build.
- Regenerate with `bun tools/canonical-cbor-vectors.ts` and verify a fixed point.
  Both languages must execute `wire-graphs.json` and the same-root accepted
  conflict scenario in `client-state-machines.json`.
- `bun run test:migration migrations/005-file-bytes-are-the-object`.
- Repository-wide relative-link check and `git diff --check`.

The expanded-child title expectation in `tests/integration/child-provider.test.ts`
also fails on the unchanged HEAD revision ("One" versus "one"); retain that
baseline distinction rather than changing unrelated behavior in this migration.

## Cutover completed; soak remains

Follow [Migration 005](../../migrations/005-file-bytes-are-the-object/README.md).

1. Verify every client, including the phone, has flushed durable admissions,
   has no pending requests or conflict evidence, and agrees with Canopy on exact
   materialized bytes and tree boundaries. An idle label alone is insufficient.
2. Pause writers. Make a consistent Canopy database/object archive and copies of
   local authored content and state. Verify checksums and restore the archive.
3. Rehearse on restored copies. Migration rewrites every current tree bottom-up,
   compares content manifests, durably stores new objects, and only then commits
   new roots and one restored accepted update per tree. It removes historical
   observations/reflog, prunes unused objects, and stamps 7. A schema-7 retry
   verifies current graphs without resetting history again.
4. Deploy and migrate Canopy, then rebootstrap Mac and phone using format 5.
   Match roots to the rehearsal report, verify exact bytes again, and exercise an
   edit round trip. An absent client cannot publish until rebootstrap.
5. Soak for several days on both platforms. Record dates and evidence before
   marking this soak complete.

Stop cutover on any unsynchronized client, corrupt/missing object, content or
boundary mismatch, failed verification, or unexplained root difference.
Backups remain available for coordinated rollback.

When implementation, cutover, and soak finish, move this plan to
`plans/_done/arborsync/` with identifier 001 and verification evidence, and update
both indexes. Preserve unrelated work and completed historical plans.

The production migration matched both rehearsals exactly. The phone and Mac
rebootstrapped successfully; all authored bytes were unchanged immediately after
cutover. A temporary Mac file reached Canopy and the phone through the raw-byte
protocol and was removed. Joe also added content on iOS and confirmed it synced;
that new content is retained. See migration 005's rehearsal record for the full
evidence. Only the several-day soak remains before this plan can be archived.
