# Protocol 001: retire the old routes the spec review replaced

Joe is walking through the Overstory spec chapter by chapter (2026-11-09) and changing it
where it is not what he wants. When a change needs both ends to move, the spec changes at
once, overstoryd answers both the old and the new form, clients move to the new form and
are released, and then the old form is removed (Joe, 2026-11-09). This plan collects those
changes so one release and one cleanup covers them all. Add each new one here as the
review makes it.

## The changes

| Change | Spec | Old form, still answered | New form | Who moves |
|---|---|---|---|---|
| Joining with an existing identity is `PUT /accounts` with `profile` | accounts §1.4 | `PUT /.overstory/placements`, answering the bare descriptor | `PUT /.overstory/accounts`, answering `{ account }` | TS and Swift clients (moved) |
| The people directory is an optional read under the account | locators §5 | `GET /.overstory/directory` | `GET /.overstory/account/directory` | TS and Swift clients (moved) |
| Host-to-host routes under `/.overstory/peer/` | README route index, accounts §5.4, locators §5.1 | `/.overstory/profiles/{id}/device-keys`, `/.overstory/domain-check` | `/.overstory/peer/profiles/{id}/device-keys`, `/.overstory/peer/domain-check` | overstoryd and the `story` CLI (moved); the old paths are answered for released CLIs |

Additions with no old form to retire: `entry-metadata?path=` (tree operations §1.1.2a)
returns only the times of the directories a path read walks. Swift's page-by-page
`TreeSession` may adopt it in place of the whole-tree read; nothing has to.

`/.overstory/execution/authority-watch` had no caller, so it was removed outright rather
than moved.

## Steps

Swift moved to `PUT /accounts` in dc76eab (Overstory and OverstoryClient tests and the Mac
app build pass on Joe's Mac). The release is on [Joe's to-do](../joe.md).

1. **Remove the old forms** once that release is out: the `/.overstory/placements` and `/.overstory/directory` routes, the unprefixed device-keys and
   domain-check paths, `LEGACY_DOMAIN_CHECK_PATH`, and the tests'
   "old path" checks. There is one host and it updates on push, so only released clients
   need the old forms (Joe, 2026-11-09).
