# Testing 002: Make parallel integration tests reliably isolated

> **Drift check:** run the maintained Bun suite repeatedly with its configured
> parallelism and inspect integration tests that mutate `ARBOR_DATA_HOME`, global
> `fetch`, fixed ports, or shared fixture paths. Stop if repeated runs are clean
> and all process-global changes already have explicit ownership and restoration.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** LOW
- **Progress:** TODO
- **Written against:** `450d2a4`

## Problem

The first Data 002 closure run observed one workspace fixture reading another
in-file state and one self-sync wait exhausting its five-second ceiling after
hundreds of passing tests. Both passed immediately in isolation and the full
parallel rerun passed. Several integration files mutate process-global
`ARBOR_DATA_HOME`; some also replace `globalThis.fetch` or depend on timing
polls. A green run therefore does not yet prove scheduling independence, which
makes Testing 001 an unreliable required CI gate.

## Required behavior

1. Add a small test helper that creates uniquely named filesystem and private
   state roots and restores every process-global value in `finally`/`afterAll`.
   Follow the existing save/restore pattern rather than assigning a different
   global value during cleanup.
2. Inventory every integration test that mutates `process.env`, global fetch,
   ports, current-device state, or shared on-disk configuration. Give each
   resource one explicit owner for the complete test lifetime.
3. Where two concurrently running files require different values of the same
   process global, prefer explicit dependency injection or a subprocess boundary.
   Do not make the entire suite serial merely to hide shared state.
4. Replace order-dependent fixtures with setup local to the test or suite that
   asserts them. No test may depend on content written by an earlier test.
5. Replace fixed sleeps used as readiness checks with condition-based waits that
   report the last observed state, elapsed time, and relevant paths/cursors on
   timeout. A deadline remains mandatory.
6. Add a repeated parallel stress command or CI lane with enough iterations to
   expose coupling. Keep ordinary local `bun test` fast; the repeated lane may
   be a separate script consumed by Testing 001.

## Scope

Start with:

- `Tests/integration/workspace.test.ts`;
- `Tests/integration/self-sync.test.ts`;
- other integration files returned by searches for `ARBOR_DATA_HOME`,
  `globalThis.fetch`, fixed `setTimeout`/`Bun.sleep`, and fixed ports;
- shared test helpers under `Tests/helpers/`; and
- `package.json` only for the named stress command.

Product code changes are allowed only when a narrow constructor/configuration
parameter removes a process-global test dependency and matches existing runtime
ownership. Do not redesign production storage or synchronization for the test.

## Verification

Establish the baseline failure rate before editing, then run the final parallel
stress command repeatedly. At minimum verify:

```sh
bun test --parallel=4 Tests/unit Tests/integration
bun run test:sync-merge
bun run typecheck
git diff --check
```

The new stress command must run the affected integration groups repeatedly with
parallelism and fail on the first leaked state, timeout, open handle, or cleanup
error. Also run each formerly flaky file alone to retain useful focused tests.

## Done criteria

- [ ] No integration test depends on a previous test's filesystem or process state.
- [ ] Every global mutation is restored to its exact previous value.
- [ ] Tests needing conflicting globals use explicit configuration or process isolation.
- [ ] Readiness waits are condition-based and produce actionable timeout evidence.
- [ ] A repeated parallel lane passes consistently and is ready for Testing 001.

## STOP conditions

- The only route to green is global serialization, broad retries, or longer
  unexplained sleeps.
- A suspected race cannot be reproduced or tied to shared state after the
  repeated baseline; report the evidence instead of changing unrelated tests.
- Isolation requires a material production architecture decision rather than a
  narrow injectable boundary.
