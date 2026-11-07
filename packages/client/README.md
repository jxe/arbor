# @ovst/client

Client-side account plumbing against an Overstory host. The Swift twin is
`OverstoryClient`.

- `account-bootstrap.ts`, `account-client.ts`, `account-pairing.ts`, `ports.ts`:
  claiming and pairing through the host, and the ports a daemon or app
  implements.
- `tree-file.ts`: `editTreeFile`, which edits one file of a tree on its host
  (read at the head, change, submit with `ifCurrent`, retry a lost race).
- `invitations.ts`: community invitations (`createInvitation`,
  `pendingInvitations`, `renewInvitation`, `cancelInvitation`), each a checked
  edit of the community's `members`. `story invite` is a thin command over these,
  and talks to the host with the device's key, not through Story Sync.

The update machine, the change log, and their runner are in
[`@ovst/working-tree`](../working-tree/README.md); Story Sync runs them
for each placed folder.
