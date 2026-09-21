# Conflict review for Arbor Sync clients

How a client of the daemon presents and submits a synchronization conflict.
The daemon's own review path and the durable conflict state it keeps are
described in [the Arbor Sync REST API](../implementing-sync-services/arborsync-api.md); the Canopy app's
review of accepted-state choices is a different surface, described in
[Native 010](../../plans/swift/010-client-conflict-review.md).


Treat tree status and review evidence as separate facts. `sync: "conflict"`
means automatic synchronization stopped; it does not authorize a choice.
Fetch `/v1/conflicts?tree=...` and offer resolution only after that request
returns the durable, identity-fenced Base, Current, Mine, and canopyd Draft
values. A missing or unavailable workspace is an error state, never an empty
conflict and never permission to keep local or remote implicitly.

The UI may present Current, Mine, `Both` when `offersBoth` is true, and Edit
when at least one returned value is textual. It submits those semantic choices
and the opaque workspace identity to Arbor Sync. The daemon owns graph
replacement, validates every resulting object hash, rechecks both the remote
accepted update and local candidate, and durably records the reviewed result
before clearing the conflict. On a stale-identity response, discard the open
review and fetch it again.

Persist review material before depending on it for recovery. A restart must
not turn remembered status into fabricated evidence, and losing connectivity
after the first successful review fetch must not make the four graphs vanish.
If `unattemptedCount` is nonzero, keep the suffix untouched and disable submit;
the failed element and later update-string elements are distinct authored
history boundaries.
