# Sharing 002: Invite from the command line, through a client library

**Timing:** Later.

**Why and when:** setting up the intro video on 2026-10-11, Joe needed an invitation for `~chungus` and the only way to make one was the Mac app's People sheet. He wants `story invite`, and he wants it to be the first command built the way the other clients work: the command talks to the host itself through a client library, and Story Sync is not in the path. "Echoing everything through story sync just adds complexity. What we want is just a client lib." No date; before the next person is invited from a machine without the Mac app.

> **Executor instructions**: Develop and test against a disposable overstoryd. The first invitation made on arb.nxhx.org with the new command, and its cancellation, wait for Joe's go-ahead. No host route or response shape changes, so `bun run test:protocol` is not needed unless that turns out false.

## Status

- **Effort**: M
- **Risk**: LOW. The command edits the community's member list on a live host, where a wrong edit could drop members; the edit is checked before it is sent (see Decisions).
- **Depends on**: nothing
- **Category**: product completion, and a first step in simplifying the CLI

## What exists

Read from source on 2026-10-11; nothing here was run.

- **An invitation is one entry in the community tree's root `_index.md`**: a `members` item with exactly `handle` and `inviteDigest` (accounts, `docs/overstory-spec/04-accounts-and-devices.md`). The code is 16 random bytes as unpadded base64url; the digest is `sha256:` and the hex SHA-256 of that text. The link is `https://<host>/~<handle>#overstory-invite=<code>` (`buildInviteLocator`). The host never holds the code.
- **Only the Mac app writes one.** `StoryInvitation` and `createInvitation` in `swift/StoryApp/StoryRootView.swift`, the text edit in `StoryProfileDocument.addingInvitation` (`StoryDirectory.swift`), published by the app's working tree. New Link removes the entry and adds another; cancelling removes it.
- **The digest is written three times**: Swift, a private `inviteCodeDigest` in `overstoryd.ts`, and inline in `tests/integration/overstoryd/community-hosting.test.ts`. TypeScript has no generator for invitation codes.
- **The CLI already talks to the host itself for its host edits.** `story place`, `story mv <url> <url>` and `story agent create` build a `ProtocolClient` in the CLI's own process from `HostAccountStore.get()`, which reads the device key and opens or reuses a session; `accountProtocolClient` in `@ovst/client` wraps that. Story Sync's `/v1/credential` is not used by the CLI.
- **But each of those commands still requires a running Story Sync** (`withStorySync` in `packages/cli/src/index.ts`), and some of their edits go the long way round: `story agent revoke` deletes the device from `devices.yaml` in the account checkout on disk and asks Story Sync to push it, and `story place` and `story mv` edit `mounts.yaml` the same way when the parent is the caller's own profile.
- **There is no helper for editing one file of a tree on a host.** `editRemoteTreeConfig` in the CLI does it for configuration trees, which are rebuilt whole from values. The nearest for an ordinary file is `inviteAndClaim` inside the community-hosting test: descriptor, snapshot, decode the root directory, swap one entry, `submitUpdate` with `ifCurrent`. The pieces are all exported from `@ovst/protocol`.
- **What Story Sync is needed for** is the local side: watching and pushing placed folders, `story status` and the `story sync` commands, and moving a watched folder.

## Decisions

- **The command.**

  ```
  story invite <account-url>            story invite https://arb.nxhx.org/~chungus
  story invite list [<host-url>]
  story invite renew <account-url>
  story invite cancel <account-url>
  ```

  The argument is the account URL, as `story place` takes URLs: it names the host, and it is the link without its code. `invite` and `renew` print the link and nothing else on standard output. `list` prints pending invitations by handle; it is not a member list. `renew` exists because the code cannot be shown twice.
- **`story invite` does not use Story Sync at all.** It runs with Story Sync stopped, and never calls `withStorySync`. It needs only the account's device key in the data home.
- **The library is `@ovst/client`.** It gains two things, both taking a `ProtocolClient` and no ports:
  - `editTreeFile(client, tree, path, change)`: read one file at the tree's current head, apply `change` to its bytes, submit with `ifCurrent`, and on a lost race read again and retry a bounded number of times. `change` returning the same bytes submits nothing. This is the general tool; `editRemoteTreeConfig` stays for configuration trees.
  - `invitations.ts`: `createInvitation`, `pendingInvitations`, `renewInvitation`, `cancelInvitation`, each for a community tree found from `client.account()`. The CLI command is argument parsing and printing around these.
- **One definition of the code and the digest.** `generateInviteCode` and `inviteCodeDigest` are exported from `@ovst/protocol`; overstoryd and the test use them. A conformance vector (code, digest, link) is checked by TypeScript and by Swift's `StoryInvitation`.
- **The member-list edit cannot drop or alter a member.** The edit is made on the YAML source so every other byte is kept, as `claimInvitationEntry` does on the host. Before submitting, the result is parsed with the host's own reader (`structuredMembers`, moved to `@ovst/protocol` so client and host share it), and the edit is refused unless the parsed list equals the previous list plus, or minus, exactly the one invitation. A layout the editor cannot place an entry in safely is an error naming the app, not a rewrite.
- **Refusals are the app's**: a handle that fails the handle rule, a handle already reserved or pending, and a caller who may not write the community tree, each with a sentence saying which.
- **Out of scope**: adding a person who already has a profile on another host, putting the invitee in a group, and a people listing.

## Steps

1. **Protocol.** Export `generateInviteCode` and `inviteCodeDigest`; move `structuredMembers` beside them; overstoryd and the community-hosting test use them. Add the conformance vector and the Swift test that reads it. Confirm accounts §1 already states the entry, the code's form and the digest; add what is missing, with no change of meaning.
2. **`editTreeFile` in `@ovst/client`.** Unit tests against a disposable host: an edit lands; an unchanged result submits nothing; a concurrent accepted update is retried and both changes survive; a file in a subdirectory; a missing file is an error. Replace `inviteAndClaim`'s object surgery in the test with it.
3. **Invitations in `@ovst/client`.** The four functions and the checked member-list edit. Tests: block and flow `members`, an absent `members` field, `[]`, comments and CRLF kept; a result that would lose a member is refused; an invitation made here is claimed through the existing join path; a renewed invitation's old link fails and its new one works; a cancelled one fails.
4. **`story invite`.** The command, its help text, and a package test that runs it with no Story Sync running. Update `packages/client/README.md`, the CLI's help notes, and the invitation paragraph of `packages/overstoryd/deploy/README.md`.
5. **Hand check on the live host (Joe's go-ahead).** Invite a throwaway handle from the terminal, see it pending in the Mac app's People sheet, cancel it from the terminal, see it gone. Also from `bunx @ovst/cli` rather than the app's bundled command, to learn whether macOS asks before a different binary reads the device key; record the answer.
6. **Close out.** Evidence in `status.md`; delete this plan. Open the follow-up below as its own plan if Joe still wants it.

## Follow-up: the rest of the CLI on the client library

Not part of this plan; recorded here so step 6 can lift it out.

- `story agent revoke` edits `devices.yaml` on the host through the library instead of in the checkout.
- `story place` and `story mv <url> <url>` make their `mounts.yaml` edits the same way, and stop requiring Story Sync when nothing local changes.
- `story agent create` drops its `withStorySync` precondition; it already makes its change with two host calls.
- What stays with Story Sync: `story status`, `story sync …`, `story mv` of a local folder, and waiting for a newly placed folder to finish.
- The comment in `packages/protocol/src/config/device-key.ts` ("Local clients never hold it; they get sessions") and `docs/architecture/story-sync/data-home.md` are corrected to say which processes read the key.
- Fewer callers of the loopback port is less for [Security 011](../../status.md#plans-closed-out--2026-10-20) to change.

## Related

- [Release 004](../../status.md#plans-closed-out--2026-10-20): the video's `~chungus` invitation is made in the app.
- [Sharing 001](sharing-001-join-on-iphone-first.md): the other end of an invitation, on the iPhone.
- [Story Web 025](../later/story-web-025-story-web.md): the browser publishes to the host itself with a session, the same direction as this plan.
