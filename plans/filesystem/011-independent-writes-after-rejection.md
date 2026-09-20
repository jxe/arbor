# Keep independent filesystem writes moving after a rejection

Split from **Reliability 011 / Sync 011**. Status: NEEDS DESIGN; priority selection is open.
[Verification 011](../verification/011-client-compatibility.md) owns the separate compatibility audit.

## User-visible problem

If canopyd definitively rejects one filesystem update, the daemon should retain that work for
recovery while continuing to publish other work that it can prove does not depend on it.
A rejected change must not unnecessarily stop the entire folder from syncing.

This concerns changes canopyd has refused to accept. An accepted update with unresolved choices
is a different case and must already continue syncing normally.

## Remaining implementation

1. Inspect the current filesystem scheduler, retained requests and rejection tests. Establish
   a concrete reproducible case before changing sequencing.
2. Define how independence is proved using original bases, transaction dependencies and effects.
   Different paths alone are insufficient: a rename or parent change can connect them.
3. Preserve the rejected request, its basis and any dependent suffix. Publish only proven
   independent effects, with durable accounting so recovery cannot apply them twice.
4. After the rejected work is repaired or explicitly reauthored, continue without losing or
   duplicating effects that have already been accepted. Reauthored work gets fresh identity.

An unknown network outcome is not a definitive rejection: retry the exact request first.
Preserve newer local bytes and all recoverable work through restart. Do not revive Native's
retired rejected-update UI or infer a new client merge engine from this scheduling requirement.

## Acceptance

- A remains recoverable after definitive rejection while independent B is published.
- B can also arrive from another client while A is retained; replaying A neither loses nor
  duplicates B.
- Dependent changes remain ordered and cannot bypass A merely because their paths differ.
- A lost response triggers exact retry, not speculative independent publication.
- Restart at each persistence boundary preserves original intent and accounts for every effect.

Use focused scheduler/integration tests and the relevant [development gates](../../DEVELOPMENT.md).
Record evidence before archiving; this plan does not authorize live deployment.
