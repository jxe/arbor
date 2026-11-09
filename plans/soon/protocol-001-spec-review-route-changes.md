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
| Joining with an existing identity is `PUT /accounts` with `profile` | accounts §1.4 | `PUT /.overstory/placements`, answering the bare descriptor | `PUT /.overstory/accounts`, answering `{ account }` | TS client (moved), Swift `ProtocolClient.acceptInvitationAsPlacement` |
| Host-to-host routes under `/.overstory/peer/` | README route index, accounts §5.4, locators §5.1 | `/.overstory/profiles/{id}/device-keys`, `/.overstory/domain-check` | `/.overstory/peer/profiles/{id}/device-keys`, `/.overstory/peer/domain-check` | overstoryd and the `story` CLI (moved; each falls back to the old path on a `404` from a host not yet updated) |

`/.overstory/execution/authority-watch` had no caller, so it was removed outright rather
than moved.

## Steps

1. **Swift.** Move `ProtocolClient.acceptInvitationAsPlacement` in
   `swift/Packages/Overstory` to `PUT /.overstory/accounts` and read `account` from the
   answer. Build and test on Joe's Mac.
2. **Release.** The next Story release (Mac, iPhone, npm CLI) carries the new forms; it
   goes on Joe's list when step 1 lands.
3. **Remove the old forms** once that release is out and the hosts that matter run current
   overstoryd: the `/.overstory/placements` route, the unprefixed device-keys and
   domain-check paths, `LEGACY_DOMAIN_CHECK_PATH`, the `404` fallbacks in
   `ProtocolClient.publishedDeviceKeys` and the CLI's `domainCheckToken`, and the tests'
   "old path" checks. Self-hosted communities built from the Railway template update by
   redeploying; give them a release's notice.
