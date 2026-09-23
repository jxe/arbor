# Overstory client reference design

Canopy for the web and Canopy are the reference human clients, not normative UIs. Portable content, locator, and protocol requirements live in the [Overstory specification](../overstory-spec/README.md). Another implementation may use different controls, layout, editor, platform conventions, and local daemon boundary.

This document records the intended Canopy for the web/native product design so those choices do not leak into protocol contracts. It is not an implementation-status page: [status.md](../../status.md) records what currently works, including differences between the web and native clients.

## Browser and Home

Overstory clients use one locator-driven browser for ordinary local files, placed trees, remote visits, explicit arborsync historical-root locators, and safe `system:` records. Home groups:

- current local location and recent places;
- placed and nested Overstory trees;
- writable community/profile trees;
- durable remote visits, with stale/offline state;
- merged search, backlinks, Trash, recovery, and diagnostics with visible provenance.

The launch path is a starting location, not a navigation boundary. Local untracked browsing stays shallow and demand-driven. Remote unplaced trees render as read-only Overstory content, not embedded public HTML. Pages opened through an arborsync historical-root locator show a persistent read-only revision state. This does not imply a host accepted-history browser: canopyd exposes neither its accepted-update log nor non-current objects.

Navigation retains back/forward history, breadcrumbs, mounted-boundary provenance, and familiar sidebar/drawer behavior. Native editor links push the current tab’s history, including links into another tree. Back, Forward, and native back gestures reopen the destination tree before resolving the exact page; switching providers for these actions preserves the tab and its trail. macOS renders the current browser-history entry directly in its split view; it does not mirror that history into a second `NavigationStack`. iOS retains its native navigation stack and back gestures. Web may use a responsive overlay drawer.

Both native clients use tree-scoped locations: a `TreeID`, a readable path, and an optional stable key. On macOS an absolute path typed into Open Location opens the placed tree containing it and navigates inside; a folder that is not a placed tree has no browser until the disk editors of Plan C. A remote canonical locator opens a visit and the canonical tree root is its Home. Home is `/` for a tree-scoped address. When that root is already in the current tab’s trail, Home pops to its resolved history entry and retains the departed pages for Forward; otherwise it opens the root as a new visit. Parent follows the preserved location and stops at the tree root.

Every client is a working-tree client. The Mac app, iOS, and (after Plan B) the web editor edit their own working tree and run the same [update machine](document-admission.md) directly against canopyd; nobody edits through the daemon. The daemon is the placed folder's client: it watches canopyd, materializes accepted roots, pushes disk-originated changes, reviews disk-originated conflicts, and serves three loopback services to the other clients on the machine, bootstrap, credential, and a content-addressed object cache over the folder's files. The Mac app opens a placed tree through bootstrap: a sparse spine rooted at canopyd's accepted root seeds an independent in-memory working tree, every other file is a hash fetched on demand, and the app submits with the daemon's device credential. The folder's mutable head, pending request, conflict, or offline state never seeds or blocks the app; concurrent changes reconcile through canopyd like changes from any other client. Each editor session runs the [document admission machine](document-admission.md) against its working tree: a burst of edits coalesces behind a short debounce into one admission, at most one admission is in flight per session with one retained successor, and the editor never merges a host-backed document locally. The account configuration checkout is edited on disk by the Mac app and the CLI and pushed by the daemon like any other placement.

Native's profile-toolbar badge and Sync Status panel report only that Native
client's current document and working-tree coordinator. Arbor Sync tree-list
status remains a daemon/CLI diagnostic and is not folded into Native's badge,
tree conflict state, or publication eligibility.

## Editing

Overstory clients present the complete operational Markdown returned by arborsync. The first standalone link to an immediate physical child represents that child; arborsync appends ordinary Markdown links for unmatched children without materializing on read. Reordering those rows edits source, so Source view and the block editor always describe the same document.

Web currently uses BlockNote as the interactive layer. This is a reference choice: Markdown remains canonical, unsupported syntax has a raw/source path, and untouched source is preserved. Properties, body edits, and structural operations show pending, saving, saved, conflict, read-only, and diagnostic states without claiming persistence before arborsync returns a durable receipt.

The leading emoji grapheme of the first H1 is Overstory's document icon. Setting or clearing it edits that H1; setting an icon on a document without an H1 prepends a heading using the display name. `Assets` is Overstory's conventional destination for imported binary assets. These are client conventions rather than portable authored-format requirements.

Canopy makes every Markdown heading except the leading page-title H1 a
collapsible section. Sections start expanded when a page opens, and folding is
session-local view state: it does not edit Markdown, create authored undo, or
persist across reopening the page. A disclosure control beside each eligible
heading folds or unfolds that section while preserving nested folded state.
On macOS, **Fold All Headings** and **Unfold All Headings** live in the View menu
with Command-Option-Left and Command-Option-Right. On iOS, long-press an expanded
heading's trailing chevron to fold all headings, or long-press a collapsed
heading's chevron to unfold all headings. Tapping the chevron still affects only
that section. An individual heading's block action menu also offers **Fold
Section** or **Unfold Section**.

On iOS, the smaller pinch-to-insert gesture also starts Overstory's on-device voice
recorder after crossing the insertion threshold. Hold the gap open while
speaking: Apple's changing live draft appears in a provisional paragraph or
list row with the same wrapping and spacing as the eventual block. Release to
commit only the finalized transcript; the completed row remains selected in
navigation mode. Pinch audio and partial drafts are ephemeral and never enter
voice recovery. If no speech is detected—or recording could not start—the empty
row enters edit mode and opens the keyboard. The larger heading gesture and a
cancelled pinch discard their temporary audio.
Toolbar recording prefers the block being edited when recording starts and
inserts the transcript at its caret. Page-level routing, including a `🎙`
heading, applies only when recording starts outside edit mode. Toolbar recording
remains host-controlled and durable, including recovery after failed delivery.

## Profile control and Claim

The native sidebar's order picker offers **Alphabetical**, **Recent**, **Link
Count**, and **Trees**. Trees replaces the current tree's page list with the local
tree inventory; search filters tree names and account labels, and keyboard
navigation opens the selected tree. The page-only pickers used for moving pages
retain their three page orders. The sidebar footer opens **People** directly.

The management modal is one scrolling pane ordered **profile, sync status,
devices**. Profile and sync rows use grouped backgrounds; the working-tree detail
is an unfilled footer attached to the sync row. Profile editing lives on the
profile page. macOS retains device and pairing controls; iOS lists its accounts
and current device information, with disconnect/pair-again for the active account.
Sync status comes from the open client, not the tree inventory. The iOS pull-down
opens the sidebar in Trees mode.

**Add account…** is a discreet control at the right of the Devices heading. On Mac it offers community connection
and device pairing without reopening the welcome screen; on iOS it opens pairing
without restoring another tree. The Mac profile menu offers **Back up identity…**
when the identity key is available, and **Recover identity…** is shown when it is
missing. The welcome presentation remains part of first-launch setup.

The persistent profile control shows the active safe community/profile identity, connected or credential-unavailable state, and every writable profile namespace (a tree whose root declares `type: person` or `type: group`). Selecting an unplaced namespace asks where it should live locally; selecting an existing placement opens it. The control never displays or copies stored credentials.

An unresolved URL for a reserved canopyd account renders with a **Claim** action. Claim asks for the already-created local profile tree, previews the canopyd account address and local path, and links the reserved profile TreeID to the account after server success. It neither uploads nor places the profile; giving that tree a canonical URL uses the ordinary declaration/activation flow. Conflict and unavailable-credential states remain recoverable and explicit.

Community and group profiles remain authored trees rather than a separate account/group database. Each structured `members` entry requires `profile: arbor://<TreeID>/`; an optional bare `handle` is current-canopyd policy that also reserves `/~handle` for that identity. Overstory clients show one person per row in a **Members** sheet (**People** on the community tree) that adds and removes entries without flattening the YAML array. Removing a community member asks first, because it disables any account allocated by that entry; removing an ordinary group member is an ordinary, undoable page edit.

The **People** view is the account-scoped directory for name-based sharing. It
combines community members, members of readable groups, and profiles already
named by the account's access rules; shows people and groups separately; and
opens hosted profiles. Refresh is explicit as well as foreground-driven. The
native cache is derived state in `Directory.json`, with avatar bytes under
`Avatars/`; either may be deleted and rebuilt. Share autocomplete uses this
cache but still accepts a raw handle, profile URL, or Profile TreeID.

People lists community members (**On this Canopy**), **Groups** with their
visible member counts, and **Others**. Membership is edited where it is
authored: **Add Person to This Canopy…**, a group's **Edit Members…**, and a
person's **Add to Group ▸** open that profile's home page with its Members
sheet presented (and the person ready to add), so every membership change is
an ordinary page edit. **Add to Group** lists only groups this device can edit.

**New Group…** creates a group profile tree at `/~handle/<slug>` under an
account this Mac administers, placed at `groups/<slug>` in the Arbor data home,
with a name, optional description, and first members. Its one access rule is
read for the community `/` profile, so everyone on the Canopy can see the
group and its roster while it stays private to the web. Share offers the same
sheet as **New Group “…”** when the picker matches no one, and as **Make these
people a group…** once two or more people are listed individually; the new
group is then added to the tree at their shared access level, leaving the
individual entries for the administrator to remove. Group creation is
Mac-only for now.

## Overstory-tree promotion and Share

The promotion surface turns an ordinary directory into an Overstory tree. It:

1. shows the source folder and destination writable profile/group boundary;
2. chooses the canonical child name;
3. explains that the folder stays at its current OS path while receiving independent identity, history, and synchronization;
4. commits identity and boundary without implying that another person can access the tree.

**Share** changes an Overstory tree's audience and access. It requires an explicit audience—Private, public view/edit, or selected people/groups—and may follow promotion in one combined transaction, but sharing is not what gives the tree its storage or synchronization identity.

The access editor uses literal **Can view**, **Can edit**, and **Remove access** labels and shows Everyone, person/group profiles, and revocable links separately. It distinguishes public access from effective access and lets an administrator revoke by entry. New link secrets are generated client-side and shown once; copy/open behavior keeps them in a fragment until converted into the secret header.

Overstory clients must not place raw secrets in loopback URLs, browser history, visit records, logs, or diagnostics.

## Synchronization, conflicts, and devices

A placed tree exposes understandable idle, syncing, offline, conflict, and error states without exposing canopyd internals. Each working-tree client durably owns its own accepted base, ordered candidate roots, and the objects its requests carry; on the Mac the folder's daemon owns the same for the folder, and Sync Status shows the app's own row beside the daemon's per-folder state. A retry preserves the same semantic prefix even if its object/delta packaging changes; clients do not invent or display a server mutation/idempotency key. Current, accepted, and merged results become visible only after arborsync has rehashed, validated, and durably materialized the returned graph.

An unsafe merge remains client state. Canopy reconstructs and hash-validates the failed element's base, current, mine, and server-draft graphs, caches them with the durable conflict, and shows their actual per-path content rather than root hashes. Each reported path offers Current, Mine, Both when the server draft has a distinct combined value, and Edit for textual content; the ordinary document-conflict surface uses the same comparison and choice controls. Resolution assembles a new candidate from the server draft plus the explicit path choices, rechecks the current accepted identity, and only then records it as new pending intent. A conflict with an unattempted suffix remains retained until ordered suffix replay is implemented; Overstory does not collapse that suffix into the failed element. There is no server conflict record, accepted-history page, historical-object fetch, or authored conflict-copy file.

A clean replica reacts to a ref watch event by reading one coherent current
snapshot. It submits an update only when it has a local candidate to reconcile.
Successful submissions verify the server's round-tripped semantic request
digest and advance the durable watch cursor to their accepted update ID. An
already-open watch can carry the same digest back only to the exact submitting
device credential, allowing the client to correlate its own accepted write or
recover a lost response without reconnecting. `Last-Event-ID` is reserved for
reconnect/resume.

The profile control includes **Pair a device** and device management without revealing an existing credential. Pairing uses a short-lived one-use secret plus a confirmation code; a claimed installation receives its own revocable credential and safe device label. Active and revoked devices are identified by stable device identity rather than their mutable labels, and revocation is explicit. The QR/pairing payload is not an Overstory navigation URL and never places a durable credential in browser history.

## Labels and actions

Overstory clients favor user-facing nouns and effects:

- **Add to workspace** places a visited Overstory tree locally.
- **Remove from workspace** removes that placement without suggesting remote deletion.
- **Stop syncing** is reserved for an existing placement and explains that files remain.
- **Private**, **Can view**, and **Can edit** describe tree access.
- **Recover** restores a selected recoverable item; **Trash** does not imply immediate destruction.
- mounted child rows show their own tree/profile provenance rather than appearing to belong to the parent graph.

File menus provide ordinary rename, move, copy, Trash, restore, and asset import where the resolved node permits them. Actions on child links resolve an explicit child reference and retain its tree scope; deleting an ordinary link never implies Trash.

**Rename Page** changes the current page's logical path without changing its authored title. A corresponding directory, sibling Markdown body, and all descendant pages move as one node. Rename and Move proactively rewrite readable paths in links to the moved subtree and links authored by moved pages; stable page identity remains the resolution fallback if healing loses a concurrent-edit race.

## Agents

Overstory clients may render agent files with context/tool summaries, a concrete consent sheet, live progress, tool calls, receipts, and ordinary-tree transcripts. The portable behavior is in [the agents section of executable documents](../overstory-spec/07-executable-documents.md#13-agents); Overstory's panels, streaming presentation, and approval controls are reference design.

## First launch and identity

On macOS, Canopy starts its bundled ArborSync and inspects the local identity,
accounts, and pending claim. New users create an identity or recover its backup.
The app and CLI use ArborSync's same identity store. A sole legacy native identity
is adopted without deleting its original Keychain record; conflicting identities
are retained and require explicit selection of the Arbor identity before proceeding.
Credential errors never cause replacement identity creation. Identity setup uses
an OS-released cross-process lock. The verified credential-store recovery record
is saved before the profile folder is bound or public metadata is published, so
interrupted setup resumes with the same key. The default installation has a
path-independent Keychain record; explicit custom data homes remain isolated.
Existing credential references survive a data-home move. Legacy records are
retained during migration. An explicit matching backup can repair damaged public
metadata when the secure record proves the same identity; the damaged bytes are
preserved separately.

Users can share their public identity, enter a community address (or exact account
URL), resume an interrupted claim, choose an accessible tree, or continue with local
files after identity setup. Unsubmitted connections can be cancelled and their
address corrected; possibly submitted claims must be resumed. A recovered identity
can authorize this Mac on an already-claimed account by pasting a pairing code from
an authorized device. Pairing also resumes after a lost response using the same
device credential. Accounts includes Identity and Community Setup for
later connections and backups. Existing configured users resume their workspace
without requiring the remote community to be reachable.

On iOS, setup is pairing-only: scan a pairing QR code from an existing administrator
device, or paste that same pairing payload when scanning is unavailable. Identity
creation and recovery are not offered. Existing paired accounts and replicas retain
their independent device authorization and offline restoration.

The Mac app already bundles Bun, ArborSync, and its native watcher. Shell tools
are build dependencies, not user installation prerequisites. Background service
registration remains subject to macOS Login Items approval.
