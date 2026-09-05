# Cleanup 003 — Remove singular update compatibility

- **State:** WAITING
- **Priority:** P1 after plural-update rollout
- **Depends on:** every supported Canopy server and Arbor client emitting and
  accepting the plural `updates` protocol in production

## Outcome

Delete the temporary reference-implementation adapter for the pre-rollout
single-candidate `POST /.arbor/trees/{TreeID}/updates` body and response. The
portable protocol is always plural; this adapter exists only to permit a short,
mixed-version deployment window.

## Entry evidence

Before starting, record evidence that:

- every deployed Canopy accepts and returns the plural form;
- ArborSync, ArborWire, the native replica coordinator, the CLI, and all other
  shipped clients emit plural requests and decode plural responses;
- supported clients have crossed their normal upgrade window; and
- production request telemetry or logs show no supported singular callers for
  the agreed observation period.

## Work

1. Remove request decoding that wraps the legacy top-level `candidate`,
   `ifMatch`, `onConflict`, `objects`, and `deltas` fields as one `updates`
   element.
2. Remove response negotiation that flattens a one-element plural result for a
   legacy caller.
3. Remove lenient decoding defaults for pre-plural conflict envelopes and
   durable native attempts after the retained-state upgrade window closes.
4. Remove legacy-only models, fixtures, tests, and reference documentation.
5. Keep the plural protocol's one-element convenience APIs if they still help
   callers; only the on-wire singular representation is temporary.

## Verification

- Run the TypeScript and Swift protocol/conformance suites.
- Run Canopy endpoint and ArborSync integration tests, including retry, replay,
  mixed response/watch ordering, and cumulative-prefix trimming.
- Search for the legacy top-level update fields at the endpoint boundary and
  account for every remaining match.
- Run the repository-wide relative-link check and `git diff --check`.

## Exit evidence

Move this plan to `_done/` with the deployment versions, observation window,
search results, and test commands that prove the compatibility path is no
longer serving a supported peer.
