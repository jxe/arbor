# Cleanup 003 — Remove singular update compatibility

- **State:** SUPERSEDED on 2026-09-11 by active Reliability 007
- **Original priority:** P1 after plural-update rollout

> Current follow-up (2026-09-12): Reliability 007 was narrowed to the minimal
> conflict contract and completed without the proposed v2 request cutover.
> The singular adapter remains implemented; its removal is deferred in the
> [active index](../../README.md). The account below records the retired strategy.

## Supersession outcome

The original plan delayed removal until a mixed-version deployment window and
telemetry proved no singular callers remained. That compatibility requirement
was explicitly dropped. Active
[Reliability 007](../reliability/007-reify-composable-canopy-conflicts.md)
now owns a coordinated server/client cutover to an explicit v2 request union
and removes both singular and unversioned v1 request/response shapes. No source
cleanup described here has been implemented yet; this file is historical
evidence for the retired rollout strategy.

## Original outcome

Delete the temporary reference-implementation adapter for the pre-rollout
single-candidate `POST /.arbor/trees/{TreeID}/updates` body and response. The
portable protocol is always plural; this adapter existed only to permit a
short mixed-version deployment window.

## Work absorbed by Reliability 007

1. Remove request decoding that wraps the legacy top-level `candidate`,
   `ifMatch`, `onConflict`, `objects`, and `deltas` fields as one `updates`
   element.
2. Remove response negotiation that flattens a one-element plural result for a
   legacy caller.
3. Remove lenient decoding defaults for old conflict envelopes and durable
   native attempts.
4. Remove legacy-only models, fixtures, tests, and reference documentation.
5. Preserve the plural protocol's one-element convenience APIs where useful;
   only obsolete on-wire representations are removed.

## Verification now owned by Reliability 007

- TypeScript and Swift protocol/conformance suites.
- Canopy endpoint and Arbor Sync retry, replay, response/watch ordering, and
  cumulative-prefix tests.
- A source search accounting for every remaining legacy top-level update field.
- Repository-wide relative-link check and `git diff --check`.
