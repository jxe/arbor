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

| A tree's accepted `update` is also where its watch resumes | tree operations §1.1, §1.1.3, §2.4; locators §5; client synchronization | `observedThrough` beside the descriptor, in update answers' `head` and in locator resolutions, and a watch frame's `id` read as a separate cursor | `update` alone: `watch?after={update}`, the frame's `id` is its update | Not yet: TS (protocol, working-tree, Story Sync, CLI) and Swift stop reading `observedThrough`; the conformance vectors drop it. overstoryd keeps sending it, equal to `update`, until the cleanup |
| One spelling for an accepted state: `update` and `root` | tree operations §1.1.3, §1.2.2, §1.2.3; source intent §5 | `previous` and `from` as `{ id, root }`; the conflict read's `?state=` and `state`; `state` in alternative references and resolution declarations | `{ update, root }` (`AcceptedRef`); `?update=` and `update` | Not yet: host answers and accepts both, then TS and Swift move and the vectors follow |
| List reads name what they list | locators §5 | `{ snapshot: [...] }` from `GET /trees` and `account/directory` | `{ trees: [...] }`, `{ people: [...] }` | Not yet: host sends both keys, then TS and Swift move |
| Locator resolutions drop `historical` | locators §5 | `historical: false` | absent | Not yet: host stops sending it once clients ignore it |
| Entry times come with the content | tree operations §1.1.2a | `GET /trees/{id}/entry-metadata[?path=]` | `?times` on snapshot and path reads | overstoryd serves `?times`; TS, Story Sync and Swift moved (31e643fb). Superseded by [Protocol 003](protocol-003-times-in-directory-entries.md), which puts times in directory entries and removes both |
| Update fields that default to empty may be omitted | tree operations §2.1 | `trace`, `resolves`, `objects`, `deltas` always sent | each may be omitted (`trace` → null, the rest → `[]`); the request digest is unchanged because it is computed over the filled-in values | Host accepts omissions; clients may stop sending empty fields |
| References are told apart by their keys | tree operations §1.2.2; source intent | `{ material: { kind: "basis" \| "operation" \| "alternative", ... }, within?, range? }` | flat `{ path, object }`, `{ change, operation }` or `{ update, conflict, alternative }`, with `within?`/`range?` beside them | Not yet: host accepts both, then TS and Swift move and the vectors follow |
| Objects travel as plain bytes | tree operations §2.1, §2.4, §2.5, §4.4 | `objects: [{ hash, bytes }]` in updates, watch transitions and the objects route | `objects: [bytes]` (base64 in JSON, byte strings in CBOR, as in a snapshot bundle) | Not yet: host accepts both in updates; once clients read both, host sends the new form |
| A delta's `copy` is a pair | tree operations §2.5 | `{ copy: { offset, length } }` | `{ copy: [offset, length] }` | Not yet: host accepts both, clients move with the objects change |

`/.overstory/execution/authority-watch` had no caller, so it was removed outright rather
than moved.

## Steps

Swift moved to `PUT /accounts` in dc76eab (Overstory and OverstoryClient tests and the Mac
app build pass on Joe's Mac). The release is on [Joe's to-do](../joe.md).

1. **Clients stop reading `observedThrough`** for trees: about 120 uses across
   `packages/protocol` (`transport.ts`, `updates/json.ts`, `model/node-model.ts`),
   `packages/working-tree`, `packages/story-sync`, `packages/cli`, and Swift
   (`ProtocolModels`, `ProtocolClient`, `TreeSession`, `UpdateCoordinator`, `StoryAppModel`).
   Views keep their own `observedThrough` (executable documents §12), which is a different
   thing. Move the conformance vectors in the same change.
2. **Remove the old forms** once that release is out (and `observedThrough` from overstoryd's
   tree answers): the `/.overstory/placements`, `/.overstory/directory` and `entry-metadata` routes (with `ProtocolClient.entryMetadata` in TS and Swift and the `entry_metadata` table, which only that route and the entry-time index's first-root seeds read), the unprefixed device-keys and
   domain-check paths, `LEGACY_DOMAIN_CHECK_PATH`, and the tests'
   "old path" checks. There is one host and it updates on push, so only released clients
   need the old forms (Joe, 2026-11-09).
