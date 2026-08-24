# Arbor client reference interaction design

Arbor web and native Arbor are the reference human clients, not normative UIs. The portable client requirements are in [spec/client.md](../spec/client.md). Another conforming human client may use wholly different controls, labels, layout, editor, and platform conventions.

This document records the intended Arbor web/native product design so those choices do not leak into protocol contracts.

## Browser and Home

Arbor clients use one locator-driven browser for ordinary local files, placed trees, remote visits, historical revisions, and safe `system:` records. Home groups:

- current local location and recent places;
- placed and nested Arbor trees;
- writable community/profile trees;
- durable remote visits, with stale/offline state;
- merged search, backlinks, Trash, recovery, and diagnostics with visible provenance.

The launch path is a starting location, not a navigation boundary. Local untracked browsing stays shallow and demand-driven. Remote unplaced trees render as read-only Arbor content, not embedded public HTML. Historical pages show a persistent read-only revision state.

Navigation retains back/forward history, breadcrumbs, mounted-boundary provenance, and familiar sidebar/drawer behavior. Web may use a responsive overlay drawer; native follows platform navigation conventions.

## Editing

Arbor clients present the complete operational Markdown returned by arbord. The first standalone link to an immediate physical child represents that child; arbord appends ordinary Markdown links for unmatched children without materializing on read. Reordering those rows edits source, so Source view and the block editor always describe the same document.

Web currently uses BlockNote as the interactive layer. This is a reference choice: Markdown remains canonical, unsupported syntax has a raw/source path, and untouched source is preserved. Properties, body edits, and structural operations show pending, saving, saved, conflict, read-only, and diagnostic states without claiming persistence before arbord returns a durable receipt.

## Profile control and Claim

The persistent profile control shows the active safe community/profile identity, connected or credential-unavailable state, and every writable community, person-profile, and group-profile namespace. Selecting an unplaced namespace asks where it should live locally; selecting an existing placement opens it. The control never displays or copies stored credentials.

An unresolved person-profile URL renders as an empty reserved profile with a **Claim** action. Claim asks where the profile should live locally, previews the canonical address and local path, explains that the first valid claim wins, and creates/places the profile only after authority success. Conflict and unavailable-credential states remain recoverable and explicit.

Community and group profiles remain authored trees rather than a separate account/group database. Their `members` property is a real locator list: Arbor clients show one person per row and provide **Add person** on the community or **Add member** on a group without flattening the YAML array. A community accepts a local handle such as `~alice` and stores its complete same-community profile locator, explains that this reserves a first-claim-wins address, rejects duplicates, and confirms removal because removing a community member disables that account.

## Arbor-tree promotion and Share

The promotion surface turns an ordinary directory into an Arbor tree. It:

1. shows the source folder and destination writable profile/group boundary;
2. chooses the canonical child name;
3. explains that the folder stays at its current OS path while receiving independent identity, history, and synchronization;
4. commits identity and boundary without implying that another person can access the tree.

**Share** changes an Arbor tree's audience and access. It requires an explicit audience—Private, public view/edit, or selected people/groups—and may follow promotion in one combined transaction, but sharing is not what gives the tree its storage or synchronization identity.

The access editor uses literal **Can view**, **Can edit**, and **Remove access** labels and shows Everyone, person/group profiles, and revocable links separately. It distinguishes public access from effective access and lets an administrator revoke by entry. New link secrets are generated client-side and shown once; copy/open behavior keeps them in a fragment until converted into the secret header.

Arbor clients must not place raw secrets in loopback URLs, browser history, visit records, logs, or diagnostics.

## Labels and actions

Arbor clients favor user-facing nouns and effects:

- **Add to workspace** places a visited Arbor tree locally.
- **Remove from workspace** removes that placement without suggesting remote deletion.
- **Stop syncing** is reserved for an existing placement and explains that files remain.
- **Private**, **Can view**, and **Can edit** describe tree access.
- **Recover** restores a selected recoverable item; **Trash** does not imply immediate destruction.
- mounted child rows show their own tree/profile provenance rather than appearing to belong to the parent graph.

File menus provide ordinary rename, move, copy, Trash, restore, and asset import where the resolved node permits them. Actions on child links resolve an explicit child reference and retain its tree scope; deleting an ordinary link never implies Trash.

## Agents

Arbor clients may render agent files with context/tool summaries, a concrete consent sheet, live progress, tool calls, receipts, and ordinary-tree transcripts. The portable behavior is in [spec/agents.md](../spec/agents.md); Arbor's panels, streaming presentation, and approval controls are reference design.
