# Native 012: Show held folders in the Mac app

Status: NOT STARTED. No priority assigned.

## Outcome

When the host refuses a placed folder's changes, the Mac app says so and
offers the one way out. Arbor Sync already holds the refused request and every
change made on top of it, reports the tree as `sync: "conflict"`, and discards
on `POST /v1/held/discard`
([the Arbor Sync REST API](../../docs/implementing-sync-services/arborsync-api.md#4-identity-account-bootstrap-and-held-changes),
[held folder changes](../../docs/implementing-editors/held-folder-changes.md)).
Today the app reads that state and shows nothing actionable.

## What exists

- `ArborSyncRESTClient.discardHeld(tree:)` (`swift/CanopyApp/ArborSync/`) calls the route.
- `CanopyAppModel` receives each daemon tree's `sync` in
  `LocalArborSyncTreePresentation`.
- `editAccountConfigurationFile` refuses to edit a configuration tree in
  `conflict` with "review it in Sync Status", which names a review that no
  longer exists.
- The app's own working tree already has "Discard Refused Changes…" in
  `ArborSyncStatusView`, backed by `CanopyAppModel.discardHeldChanges()`.

## Work

1. In Sync Status, list each placed folder whose `sync` is `conflict`, with
   its name and path and the sentence the guide gives: the host refused these
   changes; they are kept in the folder and nothing publishes until you
   discard them.
2. Offer "Discard Refused Changes…" per folder with a confirmation that says
   the folder will be rewritten to the host's current state and edits made
   there since the refusal are lost. Call `discardHeld(tree:)`, then refresh
   the overview.
3. Reword the configuration-tree refusal to point at that entry.
4. Keep `conflicted: true` (accepted alternatives) visually distinct: it is
   ordinary accepted state, reviewed through the portable
   [accepted-state review contract](../../docs/overstory-spec/09-client-synchronization.md#accepted-state-review).

## Verify

- A `CanopyAppTests` case with the bundled daemon: seed a refused change in a
  placed folder's change log (as `tests/integration/self-sync.test.ts` does),
  see the folder listed, discard, and see it idle with the folder rewritten.
- By hand on Joe's Mac, on his go-ahead: the same with a real refusal.
