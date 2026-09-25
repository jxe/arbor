# Declined folder changes for Arbor Sync clients

How a client of the daemon presents a placed folder with changes the host
declined. The daemon's routes are described in
[the Arbor Sync REST API](../implementing-sync-services/arborsync-api.md#4-identity-account-bootstrap-and-declined-changes);
the Canopy app's review of accepted-state choices is a different surface,
defined by the [accepted-state review contract](../overstory-spec/09-client-synchronization.md#accepted-state-review).

A tree descriptor with `declined` has folder paths whose changes the host
declined. Those paths stay on disk and unpublished; the rest of the folder
keeps publishing and receiving updates, so `sync` is usually `idle`. It does
not mean the accepted state has alternatives to choose between: that is
`conflicted: true`, which synchronizes normally and is reviewed through the
host.

Call it "declined" in the interface. Show the paths (`GET /v1/declined`
gives where they are on disk now) and the host's reason when it gave one, and
say that making them match the host releases them. Offer the two explicit
actions and say plainly what each does:

- `POST /v1/declined/restore` puts the host's version back at those paths.
  Edits there are lost; the folder's other changes are kept.
- `POST /v1/declined/resend` sends those paths again as the folder holds
  them, for when the reason has gone.

Never take either action without the user's request. `sync: "conflict"`
still means a request is held whole (an operation the host does not
support, or edits in a read-only placement); `POST /v1/held/discard` is its
way out and removes every change made on top of it.

`arbor declined` is the reference client:
`arbor declined <folder>`, `arbor declined --restore <folder>`,
`arbor declined --resend <folder>`.
