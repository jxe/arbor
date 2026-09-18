# Canopy update performance

September 18, 2026: accepted-prefix reuse and Native payload omission are deployed to Canopy and installed on Mac/iPhone.
No schema, Wire, client, or permissions migration is required.

Native sends an authored chain whose prefix may already be accepted. Canopy
previously re-evaluated that prefix whenever a new suffix was present, even though
exact whole-request retries already used receipts. Each evaluation also verifies
retained history, so one new edit became more expensive as the chain grew.

Preflight now uses the credential-bound exact-prefix receipt and its durable
`accepted_merge_states` record to resume from the **authored** candidate state.
It does not substitute the merged accepted projection. Current write access is
still checked, and new suffixes still receive complete preflight and acceptance
validation. Unchanged receipts that refer to a different change, and historical
records without matching authored state, retain the evaluation fallback.

## Production-copy measurement

An isolated schema-12 snapshot at accepted update 2619 was advanced with five
real authored updates. Identical copies then received those five accepted updates
plus the same sixth update, using Bun 1.3.14 on the local Mac:

| Measurement | Before | After |
| --- | ---: | ---: |
| Request duration | 15.58 s | 6.15 s |
| Merge evaluations | 7 | 2 |
| Object reads in Canopy | 38,371 | 14,068 |

The final accepted ID, root, conflict flag, and request digest matched exactly.
These are local timings, not a production latency promise. Native's live logs
before the fix recorded 79- and 85-second requests with 18 and 19 updates.

Regression coverage exercises merged-prefix continuation after a restart, rejects
any attempt to execute an already accepted source prefix, and verifies that the
new suffix preserves independently created entries. Legacy snapshot-prefix
fallback, hidden candidates, guarded retries, and whole-request replay retain
existing coverage.

## Native transport

When preparing a new request, Native retains the full authored identity chain but
omits object envelopes and deltas for changes already recorded as accepted in its
durable control state. It does not rewrite a persisted in-flight request, discard
local recovery objects, or substitute the accepted projection for an authored
basis. Payload envelopes are excluded from semantic request digests.

Applying this omission to a captured 24-update request with 23 durably acknowledged
changes reduced encoded JSON from 1,956,714 to approximately 91,322 bytes. Exact
encoding varies; the remaining object payload belongs to the new edit. The queue
and coordinator tests cover unchanged digests, restart, and hidden-candidate
continuation; the HTTP test also submits a prefix without its object payload.

## Remaining cost

New evaluations still walk retained history repeatedly. One read-only check of
the snapshot's latest retained closure read 4,507 objects totaling 226,806,214
bytes. Optimizing this requires preserving closure validation, hidden material,
and corruption detection; this change does not introduce a cross-request cache
or skip validation of new worker output.

One newly accepted state in the production-copy replay occupies 1,209,489 bytes,
with 127 nodes, 64 effects, and 1,039 change entries. Its acceptance record occupies
347,153 bytes with 4,539 dependency hashes. These are retained-state sizes, not
necessarily unique bytes added: accepted and authored hashes can be identical.

The next structural work should target new-edit cost proportional to changed
material: separately address immutable history entries and effects, share unchanged
state structure, and retain verified dependency edges incrementally. A compact
continuation reference would allow clients to name a previously accepted authored
candidate without resending its entire intent prefix. That is a Wire change and
must preserve tree/credential binding, replay identity, historical authored bases,
and restart behavior in both languages. Full-history integrity auditing remains
separate from ordinary new-output validation. No such format change is made here.

## Verification

The live TypeScript/Swift protocol gate passed, including real editor recovery,
copy, undo, and restart against a disposable Canopy. The 97-test Swift working-tree
suite passed, as did focused source replay tests, TypeScript checking, and the CLI
build. The full product suite passed 1,027 tests with the previously reproduced
private-tree CLI placement failure remaining. Relative-link checking found only
existing/example targets; whitespace checks passed. Native diagnostic logging
remains enabled; these performance changes were installed and deployed with the September 18 permissions cutover.
