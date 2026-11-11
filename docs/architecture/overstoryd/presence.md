# Presence in overstoryd

[Host: overstoryd](README.md) · [Spec 12: presence](../../overstory-spec/1.2-reading-and-watching.md#3-presence)

`PresenceHub` (`packages/overstoryd/src/presence.ts`) holds every open presence
entry in this process's memory: `Map<TreeID, Map<PresenceID, Entry>>`. Nothing
touches SQLite. A restart or deploy empties it, and clients start over with a
fresh roster. overstoryd runs as one process per data root, so one hub sees
every stream of a tree.

- **Routes** are in `host.ts` beside the watch, and share its admission
  (`readableTree`), the 250 ms authorization tick that ends a revoked stream,
  the 20 s keepalive comment, and `server.timeout(request, 0)`. Execution
  tokens are refused.
- **Entries.** An entry is the caller (account and device, or none for an
  access-link or anonymous reader), whether it is listed, an agent label, the
  host's display name for the profile (read once at join from the stored
  profile facts, `null` for a profile homed elsewhere), its page, selection
  and status.
- **Queues.** Each subscriber has a queue keyed by kind and peer, so a newer
  peer, cursor or leave frame replaces an older pending one about the same
  peer; a slow consumer only ever gets the latest. A queue over 512 frames
  closes the stream.
- **POSTs** are limited per stream to a burst of 20 and 10 a second (`429`
  beyond), and to 1 KiB (`413`).
- **Scope.** Account access to a tree is whole-tree, so every subscriber may
  read every page; a page is never `null` for want of access today. If scoped
  account reads arrive, the hub must filter `page` per subscriber.
