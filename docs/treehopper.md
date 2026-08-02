# TreeHopper reference interaction design

TreeHopper is Arbor's reference human client, not a normative UI. The portable client requirements are in [spec/client.md](../spec/client.md). Another conforming human client may use wholly different controls, labels, layout, editor, and platform conventions.

This document records the intended TreeHopper web/native product design so those choices do not leak into protocol contracts.

## Browser and Home

TreeHopper uses one locator-driven browser for ordinary local files, placed trees, remote visits, historical revisions, and safe `system:` records. Home groups:

- current local location and recent places;
- placed and nested shared trees;
- writable community/profile trees;
- durable remote visits, with stale/offline state;
- merged search, backlinks, Trash, recovery, and diagnostics with visible provenance.

The launch path is a starting location, not a navigation boundary. Local untracked browsing stays shallow and demand-driven. Remote unplaced trees render as read-only Arbor content, not embedded public HTML. Historical pages show a persistent read-only revision state.

Navigation retains back/forward history, breadcrumbs, mounted-boundary provenance, and familiar sidebar/drawer behavior. Web may use a responsive overlay drawer; native follows platform navigation conventions.

## Editing

TreeHopper presents a directory as its authored/implicit body plus immediate managed child rows. Authored child links may be reordered among prose; otherwise children receive synthetic rows. Source view shows actual Markdown and clearly distinguishes projected rows.

Web currently uses BlockNote as the interactive layer. This is a reference choice: Markdown remains canonical, unsupported syntax has a raw/source path, and untouched source is preserved. Properties, body edits, and structural operations show pending, saving, saved, conflict, read-only, and diagnostic states without claiming persistence before arbord returns a durable receipt.

## Profile control and Claim

The persistent profile control shows the active safe community/profile identity, connected or credential-unavailable state, and a path to account/device management. It never displays or copies stored credentials.

An unresolved person-profile URL renders as an empty reserved profile with a **Claim** action. Claim asks where the profile should live locally, previews the canonical address and local path, explains that the first valid claim wins, and creates/places the profile only after authority success. Conflict and unavailable-credential states remain recoverable and explicit.

Group profiles remain authored trees. Their members and descendants are edited through ordinary content/structural operations; TreeHopper does not invent a separate group database.

## Share sheet

**Share** is the explicit promotion surface for an ordinary directory. The sheet:

1. shows the source folder and destination writable profile/group boundary;
2. chooses the canonical child name;
3. requires an explicit initial audience—Private, public view/edit, or selected people/groups;
4. explains that the folder stays at its current OS path while receiving independent identity, history, synchronization, and access;
5. commits identity, boundary, and the complete initial ACL atomically.

The access editor uses literal **Can view**, **Can edit**, and **Remove access** labels and shows Everyone, person/group profiles, and revocable links separately. It distinguishes public access from effective access and lets an administrator revoke by entry. New link secrets are generated client-side and shown once; copy/open behavior keeps them in a fragment until converted into the secret header.

TreeHopper must not place raw secrets in loopback URLs, browser history, visit records, logs, or diagnostics.

## Labels and actions

TreeHopper favors user-facing nouns and effects:

- **Add to workspace** places a visited shared tree locally.
- **Remove from workspace** removes that placement without suggesting remote deletion.
- **Stop syncing** is reserved for an existing placement and explains that files remain.
- **Private**, **Can view**, and **Can edit** describe tree access.
- **Recover** restores a selected recoverable item; **Trash** does not imply immediate destruction.
- mounted child rows show their own tree/profile provenance rather than appearing to belong to the parent graph.

File menus provide ordinary rename, move, copy, Trash, restore, and asset import where the resolved node permits them. Actions on projected rows use their explicit child reference; they never derive tree scope from the visible parent path.

## Agents

TreeHopper may render agent files with context/tool summaries, a concrete consent sheet, live progress, tool calls, receipts, and ordinary-tree transcripts. The portable behavior is in [spec/agents.md](../spec/agents.md); TreeHopper's panels, streaming presentation, and approval controls are reference design.
