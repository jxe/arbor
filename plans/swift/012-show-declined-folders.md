# Native 012: Show declined folders in the Mac app

Status: NOT STARTED. No priority assigned.

## Outcome

When the host declines a placed folder's changes, the Mac app says which
paths are declined and offers the two ways out. Arbor Sync already keeps the
declined paths on disk and unpublished while the rest of the folder keeps
syncing, lists them in the tree descriptor's `declined`, and serves
`GET /v1/declined`, `POST /v1/declined/restore` and `POST /v1/declined/resend`
([the Arbor Sync REST API](../../docs/implementing-sync-services/arborsync-api.md#4-identity-account-bootstrap-and-declined-changes),
[declined folder changes](../../docs/implementing-editors/declined-folder-changes.md)).
`arbor declined` is the reference client. Today the app reads none of it.

## What exists

- `ArborSyncRESTClient.discardHeld(tree:)` (`swift/CanopyApp/ArborSync/`) calls
  `POST /v1/held/discard`, which now discards only a request held whole
  (`sync: "conflict"`: one the host does not support).
- `CanopyAppModel` receives each daemon tree's `sync` in
  `LocalArborSyncTreePresentation`; it does not decode `declined` yet.
- `editAccountConfigurationFile` refuses to edit a configuration tree in
  `conflict` with "review it in Sync Status", which names a review that no
  longer exists. A declined configuration edit now leaves the tree `idle` with
  `declined`, so that check no longer fires for it.
- The app's own working tree already has "Discard Refused Changes…" in
  `ArborSyncStatusView`, backed by `CanopyAppModel.discardHeldChanges()`.

## Work

1. Decode `declined` on daemon trees and, in Sync Status, list each placed
   folder that has it, with its name, path, declined paths (from
   `GET /v1/declined`) and the host's reason, and the guide's sentence: the
   host declined changes at these paths; they are kept in the folder and not
   published, the rest of the folder keeps syncing, and making them match the
   host releases them.
2. Offer "Restore Host Version…" with a confirmation that names the paths and
   says edits there are lost and other changes are kept, and "Send Again".
   Add `restoreDeclined(tree:)` and `resendDeclined(tree:)` beside
   `discardHeld`. Refresh the overview after either.
3. Keep `sync: "conflict"` with the existing discard, and reword the
   configuration-tree check to use `declined` and point at the Sync Status
   entry.
4. Keep `conflicted: true` (accepted alternatives) visually distinct: it is
   ordinary accepted state, reviewed through the portable
   [accepted-state review contract](../../docs/overstory-spec/09-client-synchronization.md#accepted-state-review).

## Verify

- A `CanopyAppTests` case with the bundled daemon: make a declined change in a
  placed folder (as `tests/integration/self-sync.test.ts` does), see its path
  listed, restore it, and see `declined` cleared with the path rewritten.
- By hand on Joe's Mac, on his go-ahead: the same with a real rejection.
