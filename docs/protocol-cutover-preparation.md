# Protocol cutover preparation — 2026-09-13

The implementation is prepared in `/Users/joe/src/arbor-protocol-ready`, branch `codex/protocol-ready-integration`, based on current `main` at `7b217621e1a57717f6e1043eb6ed844b38ae5dd4`. The original conflict-terms worktree remains intact. The integration applied cleanly and retains main's daemon/editor refactoring and baseline test fixes. Nothing was merged into main, pushed, deployed, or installed.

## Verified preparation

- Typecheck and the full product suite passed: **467 tests, zero failures**. The earlier title-casing baseline failure is fixed by the newer main commits.
- The cross-language/live protocol gate passed, including the 56-test native working-tree suite. CLI build and the 50,000-file performance gate passed.
- Full macOS and generic iOS app builds passed from the integration worktree. These are unsigned candidates, not installable release artifacts. They used the prescribed local Quagmire workspace at clean commit `f5ac69b161580dd0f7963c5f6046536f9c2c63d6`; published dependency pins were not changed. This local commit has no exact release tag, so retain its identity when reproducing the builds.
- The [cutover rehearsal](../tools/protocol-cutover-rehearsal.ts) ran against an isolated old checkout at `683bb57`. It seeded disposable schema-7 history, backed it up with the existing backup tool, and independently restored it twice. Both passes retained all five original accepted rows exactly, preserved file bytes and accepted identities, rejected old requests without changing history, appended one new snapshot update, replayed it exactly, and reopened it successfully with the old binary. Integrity checks passed. No database migration or history reset is involved.
- The [read-only state inventory](../tools/protocol-cutover-preflight.ts) inspected two native Mac coordinator records. Neither held an attempt, head, conflict, hold, or next base. No daemon pending-state JSON was present in the scanned location. This is a point-in-time observation, not proof that all editors or files are settled.
- Railway reported deployment `645253b7-cd23-4917-aaa1-084a0845dc3a` as successful, with its instance running and the volume ready at `/data`. Its image digest is `sha256:854f8108e66fa9f50b453262bf694e87f5190b4f6cc570b9199af960c47b109e`. This identifies the existing binary for coordinated rollback; it does not replace a fresh data backup. Run Railway commands from the linked original checkout, not an unlinked worktree.
- The connected iPhone was discoverable, but CoreDevice refused read-only file transfer with `Transfer Files is not supported by this device`. Its pending state remains **unverified**; no phone backup was made and no phone state was changed.

Private candidate apps, executable checksums, source-file hashes, and the preparation reports are under `/Users/joe/arbor-protocol-prep-20260913.Kc0cVj/`. `build-manifest.json` identifies the source/base and both app executables. These observations and unsigned builds are preparation evidence; revalidate if source, dependency, deployment, or device state changes.

## Repeatable preparation commands

From the integration worktree:

```sh
bun tools/protocol-cutover-preflight.ts /Users/joe/.arbor
bun test tests/unit/protocol-cutover-preflight.test.ts
```

The inventory reports only paths and blocker names, not request bodies or credentials. It reads existing files directly without opening application stores or writing client state. Missing roots, malformed records, and unknown native schemas fail closed. It does not inspect in-memory editor changes, authorize a cutover, or compare filesystem contents to Canopy.

A clean old checkout is retained at `/tmp/arbor-protocol-old-683bb57`. To reproduce the old/new rehearsal, use a clean isolated checkout at `683bb57` with its own frozen-lockfile dependencies, then run:

```sh
bun tools/protocol-cutover-rehearsal.ts /path/to/old-checkout
```

The script verifies the old checkout's exact revision and cleanliness, launches old code in a separate process, and only creates/opens disposable server roots. It uses no production credentials, endpoints, or data roots and removes its temporary data afterward. The rehearsal proves compatibility on its synthetic corpus, not the completeness of a production backup.

## Remaining joint cutover

Follow [the coordinated upgrade procedure](protocol-ready.md#coordinated-upgrade). The steps reserved for our joint session are:

1. Pause authoring on every participating app/device and verify unsaved editor state, daemon pending strings, native heads/attempts/holds, and exact accepted update/root convergence. Repeat the Mac inventory and obtain the phone's state through a supported connection. Confirm any other device is either settled and included or remains stopped throughout the upgrade.
2. Take fresh, verified backups of Canopy and each client's durable state while writers are quiescent. Preserve authored files, pending evidence, accepted history, and rollback identities. The old migration-005 archive is not a backup of current edits.
3. Finalize the integrated source revision, sign the native builds, and coordinate server/daemon/client installation. The configured deploy branch is `main`; publishing or triggering deployment belongs here, after writer quiescence. Neither `railway apply/up` nor app install/restart was run during preparation.
4. Verify all participants use the new Wire shape, exact accepted history is retained, and a temporary cross-device edit and its removal converge byte-for-byte. Only then resume ordinary authoring.
5. If rollback is needed, stop all writers first. Revert the binary/client set together while preserving edits accepted since the backup; do not restore old data over new work merely because an older binary can read the snapshot format.

## Joint backup verification — 2026-09-14

Joe paused authoring with both apps open. The active daemon runs on port 4317, with durable state under `~/.arbor/.state`; inventory this directory separately from native state at `~/.arbor`. All three Mac placements were idle, with clean bootstrap and no durable pending/conflict records. Uncached filesystem hashes and authenticated Canopy snapshots matched at configuration update 1583, Console update 1651, and profile update 1585.

The physical phone is Warthog (iPhone 16e); the previous failed preparation targeted a simulator. A Wi-Fi copy of its Arbor application-support directory succeeded. All 491 copied files matched the device inventory by path and size. The active working-tree head and coordinator were current at Console update 1651. All 111 reachable objects passed hash verification; 79 materialized source strings and 24 file references matched the accepted snapshot. Phone coordinator records live under `Sync/<key>/sync`, separate from `WorkingTrees/<key>/control`; inspect both.

Fresh private backups and the recovery report are at `/Users/joe/arbor-protocol-backup-20260914.sFnsIx/`. The Mac copy preserves all durable state and the external authored placement. SQLite backup-API snapshots supplement the raw copy because live cache WAL/SHM files can change while the app is open. The Canopy archive checksum matched after download; every database table count matched the live server, including 70 accepted updates and five trees. A restored copy passed integrity verification under the protocol-ready code without migration. The server archive is on `canopy-arb-nxhx-org-volume`, not the historical `resplendent-freedom-volume`.

## Cutover completion — 2026-09-14

The joint cutover is complete; see [live verification](protocol-ready.md#live-cutover-verification-2026-09-14). The preparation and backup observations above are historical evidence. Deployment `81d7dbe6-624c-4b03-8924-dff34e448684` and both installed signed apps use source revision `e1e2531`. Main was fast-forwarded locally; Railway received an explicit source upload. No GitHub push was made.
