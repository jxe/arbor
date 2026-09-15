# Protocol-ready source intent

The [portable contract](../spec/10-source-intent.md) is now represented in TypeScript and Swift. Every candidate carries `change` and explicit `operations`; snapshot constructors emit a fresh change ID and `operations: null`. Semantic fields participate in canonical request identity. Durable pending requests, prepared bodies, successors, and adopted prefixes retain those fields. No per-character identity map is added to ordinary Markdown reads.

Deployed Canopy accepts only snapshot semantics. Source-built Canopy now accepts the [exact-basis source-edit subset](exact-source-execution.md); unsupported operations still return `422 unsupported-operation` before any prefix is accepted. Unknown/missing semantic fields fail validation. Snapshot merge behavior and accepted-conflict signals retain their existing meaning. The commit guard now checks accepted update identity as well as the projected root.

The TypeScript Wire client exposes `WireUnsupportedOperation`; the daemon retains the pending request and marks the tree as an error, suppressing repeated submission of that same request for the synchronizer's lifetime. A replacement authored request or a restarted upgraded synchronizer can try again. Swift Wire does not retry this response, and the native coordinator enters its terminal validation state while keeping the durable request. Neither client silently strips operations. Native durable attempts are decoded and their digests verified when reopening; old incompatible attempts remain on disk and fail closed.

## Coordinated upgrade

[Preparation evidence and remaining joint steps](protocol-cutover-preparation.md) records the integration onto newer main, successful native builds, disposable cutover rehearsal, and device checks. It supersedes the original worktree test counts below.

The coordinated live cutover completed with Joe on 2026-09-14. Canopy, Arbor Sync, macOS, and iOS now run the protocol-ready contract from commit `e1e2531`. The procedure below is retained as the upgrade and rollback reference; it is not an instruction to repeat the cutover.

There is one current Wire request shape and digest contract. The singular request adapter is removed. This code change does not deploy any service, change Quagmire pins, migrate live data, or reset history. No database schema change is required for this milestone: Canopy has not yet accepted operation provenance.

1. While the old builds still run, stop authoring and settle every app and daemon. Verify each tree's accepted update and exact root, and verify that no uncertain pending request, held conflict request, or unattempted suffix remains. Preserve backups of server and client durable state. Merely matching file roots is not proof that pending work is settled.
2. If any old request is ambiguous or still held, keep the old builds available and complete its recovery/review before cutover. Never manufacture new IDs for an old transmitted request, edit stored digests, clear client state, or rebase it from the latest files. If necessary, postpone the cutover for that work.
3. Stop old writers and upgrade Canopy, Arbor Sync, and all native clients together. Do not allow old clients to resume against the new server. Existing immutable objects and accepted history remain intact; their old request digests remain historical records.
4. Reopen each client, verify descriptor/snapshot/watch convergence, submit an ordinary edit, and verify its retained request has a stable change ID and `operations: null`. Exercise an exact prepared retry in a disposable test tree. Operation-bearing traffic must return the explicit unsupported response with no accepted-state change.
5. Resume authoring only after every participating client is upgraded. If rollback is necessary, stop all writers and restore a mutually compatible service/client set and its verified durable state; do not downgrade one active participant in isolation.

## Remaining milestones

- [008: operation execution and editor emission](../plans/reliability/008-enable-source-operations.md), enabled one operation family at a time.
- [009: Canopy correspondence, provenance, and accepted conflicts](../plans/reliability/009-canopy-provenance-merges.md).
- [010: contextual conflict review](../plans/reliability/010-client-conflict-review.md), including stale-review and crash safety.

Cross-language fixtures live in `conformance/wire-operations.json` and `conformance/wire-update-intent.json`. The semantic examples are grammar/digest vectors; they do not assert that their effects execute today. `status.md` remains authoritative for the implemented subset.

## Verification, 2026-09-13

- `bun run typecheck`, `bun run build`, and `bun run test:performance` passed. The performance fixture exercised 50,000 files.
- `bun run test:protocol` passed, including shared operation/digest vectors, disposable live Canopy/Arbor Sync tests, and the newly included ArborWorkingTree suite (56 tests). The Wire tests verify the actual streamed HTTP request body on retries and unsupported-operation rejection.
- `swift test --package-path native/Packages/ArborSyncClient` passed separately (14 tests).
- `bun run test`: 458 passed; one previously reproduced baseline failure remains in `tests/integration/child-provider.test.ts:84` (`One` expected, `one` returned). No new product failures remain.
- Repository Markdown validation checked 697 relative links in 163 files: no newly broken links; 11 existing broken historical/fixture links remain. `git diff --check` passed.
- Focused coverage includes whole-batch rejection before a valid prefix or activation; persistence of operation-bearing requests and snapshot successors; adopted operations surviving native restart at equal roots; changed durable request bases failing closed; and accepted-update CAS at unchanged roots.

The preparation checks above used disposable services and state. The subsequent live cutover is recorded below.

## Live cutover verification, 2026-09-14

Railway deployment `81d7dbe6-624c-4b03-8924-dff34e448684` is healthy. Signed macOS and physical-iPhone builds were installed, and the source-backed Arbor Sync daemon was restarted from the same revision. Quagmire remains at the tested local revision recorded in the preparation report; published pins are unchanged. No data migration or reset occurred.

All 70 original accepted-update rows survived byte-for-byte. A temporary snapshot with a durable change ID and explicit null operations was accepted as update 1652; an exact request replay returned the same response without another accepted update. An operation-bearing request returned nonretryable `422 unsupported-operation` without changing the accepted state. Both devices adopted the temporary note. Removing it through the Mac filesystem synchronized as update 1653 and restored the exact original root. The attempted short-lived daemon pending-record capture missed the pending window; acceptance by the strict new server and subsequent clean state verified the client submission.

Final Mac filesystem hashes, daemon descriptors, authenticated Canopy snapshots, and iPhone working-tree/control state agree. All three Mac placements are idle. The phone is current at update 1653 without pending requests or conflicts, and all 104 materialized nodes retain their original content and structure. The final accepted history has 72 rows: the original 70 plus test addition/removal. Fresh backups and private verification artifacts are preserved at `/Users/joe/arbor-protocol-backup-20260914.sFnsIx/`.
