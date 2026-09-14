# Protocol-ready source intent

The [portable contract](../spec/10-source-intent.md) is now represented in TypeScript and Swift. Every candidate carries `change` and explicit `operations`; snapshot constructors emit a fresh change ID and `operations: null`. Semantic fields participate in canonical request identity. Durable pending requests, prepared bodies, successors, and adopted prefixes retain those fields. No per-character identity map is added to ordinary Markdown reads.

Canopy currently accepts only snapshot semantics. It validates the operation grammar and rejects an operation-bearing batch with `422 unsupported-operation`, without applying a prefix or storing its objects. Operation recognition is not execution support. Unknown/missing semantic fields fail validation. Snapshot merge behavior and accepted-conflict signals retain their existing meaning. The commit guard now checks accepted update identity as well as the projected root.

The TypeScript Wire client exposes `WireUnsupportedOperation`; the daemon retains the pending request and marks the tree as an error, suppressing repeated submission of that same request for the synchronizer's lifetime. A replacement authored request or a restarted upgraded synchronizer can try again. Swift Wire does not retry this response, and the native coordinator enters its terminal validation state while keeping the durable request. Neither client silently strips operations. Native durable attempts are decoded and their digests verified when reopening; old incompatible attempts remain on disk and fail closed.

## Coordinated upgrade

[Preparation evidence and remaining joint steps](protocol-cutover-preparation.md) records the integration onto newer main, successful native builds, disposable cutover rehearsal, and device checks. It supersedes the original worktree test counts below.

The live cutover is to be performed together with Joe, in a separate session after this work is reviewed. Do not execute these steps as part of implementation or verification.

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

All runtime verification used disposable test services and state. Live cutover remains pending our joint session.
