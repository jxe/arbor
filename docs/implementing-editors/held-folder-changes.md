# Held folder changes for Arbor Sync clients

How a client of the daemon presents a placed folder whose changes the host
refused. The daemon's route is described in
[the Arbor Sync REST API](../implementing-sync-services/arborsync-api.md#4-account-bootstrap-forget-and-held-changes);
the Canopy app's review of accepted-state choices is a different surface,
described in [Native 010](../../plans/swift/010-inline-choice-context.md).

`sync: "conflict"` means the host refused the folder's latest request. The
refused changes, and every change made on top of them, are held in the
folder's change log; the folder keeps its bytes and nothing publishes until
the user acts. It does not mean the accepted state has alternatives to choose
between: that is `conflicted: true`, which synchronizes normally and is
reviewed through the host.

Present the refusal and offer the explicit way out, `POST /v1/held/discard`
with the tree. Say plainly what it does: the held changes are removed and the
folder is rewritten to the host's current state, so edits made in the folder
since the refusal are lost. Never retry, rebase, or merge held changes on the
user's behalf, and never clear the state without that request.
