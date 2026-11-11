# Protocol 001: retire the old routes the spec review replaced

Joe is walking through the Overstory spec chapter by chapter (2026-11-09) and changing it
where it is not what he wants. When a change needs both ends to move, the spec changes at
once, overstoryd answers both the old and the new form, clients move to the new form and
are released, and then the old form is removed (Joe, 2026-11-09). This plan collects those
changes so one release and one cleanup covers them all. Add each new one here as the
review makes it.

**2026-11-11 (Joe):** the moves still marked "Not yet" ship with the
[Protocol 003](protocol-003-times-in-directory-entries.md) flag day instead, when every client
updates at once. They need no period of answering both forms: host and clients switch to the
new form together, and the old forms are deleted in the same change.

## The changes

| Change | Spec | Old form, still answered | New form | Who moves |
|---|---|---|---|---|
| Joining with an existing identity is `PUT /accounts` with `profile` | accounts §1.4 | `PUT /.overstory/placements`, answering the bare descriptor | `PUT /.overstory/accounts`, answering `{ account }` | TS and Swift clients (moved) |
| The people directory is an optional read under the account | locators §5 | `GET /.overstory/directory` | `GET /.overstory/account/directory` | TS and Swift clients (moved) |
| Host-to-host routes under `/.overstory/peer/` | README route index, accounts §5.4, locators §5.1 | `/.overstory/profiles/{id}/device-keys`, `/.overstory/domain-check` | `/.overstory/peer/profiles/{id}/device-keys`, `/.overstory/peer/domain-check` | overstoryd and the `story` CLI (moved); the old paths are answered for released CLIs |

| A tree's accepted `update` is also where its watch resumes | tree operations §1.1, §1.1.3, §2.4; locators §5; client synchronization | `observedThrough` beside the descriptor, in update answers' `head` and in locator resolutions, and a watch frame's `id` read as a separate cursor | `update` alone: `watch?after={update}`, the frame's `id` is its update | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| One spelling for an accepted state: `update` and `root` | tree operations §1.1.3, §1.2.2, §1.2.3; source intent §5 | `previous` and `from` as `{ id, root }`; the conflict read's `?state=` and `state`; `state` in alternative references and resolution declarations | `{ update, root }` (`AcceptedRef`); `?update=` and `update` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| List reads name what they list | locators §5 | `{ snapshot: [...] }` from `GET /trees` and `account/directory` | `{ trees: [...] }`, `{ people: [...] }` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Locator resolutions drop `historical` | locators §5 | `historical: false` | absent | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| A watch frame is flat | tree operations §1.1.3 | `{ transition: { update, from?, requestDigest?, objects, deltas }, access, canonical }` | `{ update, from?, requestDigest?, objects?, deltas?, access, canonical }` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Transfer arrays may be omitted | tree operations §1.1.3, §2.4 | `objects: []` and `deltas: []` always sent in frames and `reconciliation` | omitted means `[]` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Decisions list no actions | tree operations §1.2.3 | `actions: ["resolveConflict"]` on every decision | absent; every decision is resolvable | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| A rejection names the head as a success does | tree operations §2.4 | `details.current`, a whole `AcceptedUpdate` | `details.head`, an `UpdateHead` `{ update, root, conflicted }` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| A property operation's `at` defaults to its update's | source intent §4.1 | `at` on every property operation | optional; omitted means the update's `at` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Presence names the stream's own entry once | presence §3 | `self` (only when listed) and `stream` (for messages) in `presence.ready` | one `self` for any caller with an account, listed or not | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Entry times come with the content | tree operations §1.1.2a | `GET /trees/{id}/entry-metadata[?path=]` | `?times` on snapshot and path reads | overstoryd serves `?times`; TS, Story Sync and Swift moved (31e643fb). Superseded by [Protocol 003](protocol-003-times-in-directory-entries.md), which puts times in directory entries and removes both |
| Update fields that default to empty may be omitted | tree operations §2.1 | `trace`, `resolves`, `objects`, `deltas` always sent | each may be omitted (`trace` → null, the rest → `[]`); the request digest is unchanged because it is computed over the filled-in values | Host accepts omissions; clients may stop sending empty fields |
| References are told apart by their keys | tree operations §1.2.2; source intent | `{ material: { kind: "basis" \| "operation" \| "alternative", ... }, within?, range? }` | flat `{ path, object }`, `{ change, operation }` or `{ update, conflict, alternative }`, with `within?`/`range?` beside them | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Objects travel as plain bytes | tree operations §2.1, §2.4, §2.5, §4.4 | `objects: [{ hash, bytes }]` in updates, watch transitions and the objects route | `objects: [bytes]` (base64 in JSON, byte strings in CBOR, as in a snapshot bundle) | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| A delta's `copy` is a pair | tree operations §2.5 | `{ copy: { offset, length } }` | `{ copy: [offset, length] }` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| One challenge route | accounts and devices §1.2, §4.1; federation §3, §5 | `POST /account-challenges` and `POST /device-sessions/challenges`; session challenges say `purpose: "device-session"` | `POST /challenges` with `purpose: "account" \| "placement" \| "session"`, signed in the challenge | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Account bodies carry only the signed challenge | accounts and devices §1.2; federation §3 | `account`, `profileTree`, `configurationTree` (and `profile` for a placement) beside the challenge in `PUT /accounts` | `{ challenge, publicKey, signature, inviteCode?, device?, configuration? }`; the host reads the rest from the challenge, and `purpose` tells a claim from a placement | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| No `configurationTree` in requests | accounts and devices §1.2 | clients send the derived configuration TreeID and the host refuses another | the host derives it; the challenge still binds it | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Pairing has one code | accounts and devices §4, §4.2 | `PUT /pairings/{PairingID}/claim` plus a secret in the body | `PUT /pairings/claim` with `code`; the host finds the pairing by the code's digest | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| One account descriptor | locators §5; federation §2 | home and placement descriptors differ; `homeHost` only at a placement host | one shape: `homeHost` always (the host itself at home), `configuration` only at home, `placementRoot` only at a placement host | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| No access route | access control §4 | `GET /trees/{id}/access` (a safe projection plus locators) | none: administrators read `access.yaml` from the configuration tree; Story's share sheet resolves names itself | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| Views and mutate name no document | apps and views §12.1, §12.2 | `document: { tree, path, version }` in `ViewsRequest` and `MutateRequest` | absent; each handle carries its tree, path and version | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| View results and receipts carry no `observedThrough` | apps and views §12.1, §12.2 | `observedThrough` on each `result`, in `ready`, and on `MutationResultReceipt` | absent; a receipt has `affected?: { tree, update }` naming the update its writes made | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |
| View streams are `no-store` | apps and views §12.1 | `Cache-Control: no-cache` on the views SSE response | `no-store` | Built on the Protocol 003 branch (host, TS, Swift); ships on the flag day |

`/.overstory/execution/authority-watch` had no caller, so it was removed outright rather
than moved.

## Steps

Swift moved to `PUT /accounts` in dc76eab (Overstory and OverstoryClient tests and the Mac
app build pass on Joe's Mac).

1. **With the Protocol 003 flag day,** move every "Not yet" row at once, host and clients
   together: clients stop reading `observedThrough` for trees (about 120 uses across
   `packages/protocol` (`transport.ts`, `updates/json.ts`, `model/node-model.ts`),
   `packages/working-tree`, `packages/story-sync`, `packages/cli`, and Swift
   (`ProtocolModels`, `ProtocolClient`, `TreeSession`, `UpdateCoordinator`, `StoryAppModel`);
   views keep their own `observedThrough` (executable documents §12), which is a different
   thing), and the host stops sending it. Move the conformance vectors in the same change.
2. **Remove every old form in the same release:** the `/.overstory/placements`,
   `/.overstory/directory` and `entry-metadata` routes (with `ProtocolClient.entryMetadata` in
   TS and Swift and the `entry_metadata` table), the unprefixed device-keys and domain-check
   paths, `LEGACY_DOMAIN_CHECK_PATH`, and the tests' "old path" checks. Every client updates
   at the flag day, so nothing older needs them.
