# Canopy for the web surfaces

The surface-by-surface inventory behind [Web 025](025-arbor-web.md). Each native surface is listed with its Swift source, what the web version keeps, which host it applies to, and the project (B1, B2, B3) that builds it. **Keep** means the same labels, states and actions; **adapt** means the same information in browser-idiomatic form; **not ported** is a decision, not a gap. Native polish (menu bar, sheets, gestures, sounds, camera, audio) is listed at the end so nobody reads its absence as an omission.

Reference: `swift/CanopyApp/*.swift` and `swift/Packages/CanopyEditor`. Sidebar, directory, account, and sync surfaces were refreshed against the working tree on 2026-09-22. Older line-number references below are historical navigation hints; use the named types and current source. Quote the native strings when building; parity is in the vocabulary as much as the layout.

| # | Surface | Native source | Web | Host | Project |
|---|---|---|---|---|---|
| 1 | Launch, empty and confirmation states | `ArborDailyDriverViews.swift:1576–1684`, `ArborAppModel.swift:2284` | keep | both | B1 |
| 2 | Sidebar: pages/Trees modes, rows, People footer, context menu | `ArborRootView.swift` (`sidebarList`, `sidebarTreesList`, `sidebarFooter`), `ArborDailyDriverViews.swift` (`ArborSidebarSearchRow`) | keep | both | B1 |
| 3 | Navigation: breadcrumb heading, back/forward/parent/home, Open Location, tabs | `ArborRootView.swift:1428, 1869, 2172`; `ArborDailyDriverViews.swift:1176` | keep; tabs adapt | both | B1 |
| 4 | Editor pane and document footer | `ArborEditorSurface.swift`, `ArborEditorHost.swift`, `ArborDailyDriverViews.swift:936`; Quagmire | adapt on BlockNote | both | B1 / B3 |
| 5 | Search Contents palette | `ArborDailyDriverViews.swift:277` | keep | both | B1 |
| 6 | Share and app permissions | `ArborRootView.swift:2381, 3990` | keep | both | B2 |
| 7 | Profile, sync, devices, account addition | `ArborRootView.swift` (`MacArborSyncAccountPanel`, `IOSAccountPanel`, `ArborDevicesHeader`), `CanopyOnboarding.swift` | keep; pairing adapt | both | B2 |
| 8 | Sync Status within account management | `ArborDailyDriverViews.swift` (`ArborSyncStatusView.sections`) | keep; no daemon actions | both | B2 |
| 9 | Keyboard map | `ArborApp.swift:34–305` | adapt | both | B1 (shell), B3 (editor) |
| 10 | Attention banner | `ArborDailyDriverViews.swift:895`, `ArborRootView.swift:2217` | keep | both | B1 |
| 11 | Web Home; native sidebar Trees mode | `ArborRootView.swift` (`sidebarTreesList`, `IOSPlaceTreePanel`); `ArborDailyDriverViews.swift` | adapt per-host | both | B1 (local), B2 (canopy) |
| 12 | Network log | `ArborNetworkLogView.swift` | keep | both | B2 |
| 13 | Conflict and choice review | `ArborConflictReview.swift`, `ArborDailyDriverViews.swift:1325–1540` | keep | both | B3 |
| 14 | Source and Properties, History/Recover | `ArborDailyDriverViews.swift:1219, 1250` | keep | both | B1 |
| 15 | Move to (blocks), Move Page (structural) | `ArborDailyDriverViews.swift:445, 689` | keep | both | B3 / B1 |
| 16 | Trash, restore, orphan prompt, title rename | `ArborRootView.swift:971–977`, `ArborAppModel.swift:2054` | keep | both | B1 |
| 17 | People directory and shared profile rows | `ArborDirectoryView.swift` (`ArborDirectoryView`, `ArborProfileRow`) | keep | both | B2 |

## 1. Launch, empty and confirmation states

- **Opening**: blank for 250 ms, then spinner and `Opening <name>…`.
- **Empty** (local host): `No Tree Open` / `Couldn't Open Tree`, description `Open one of the trees placed on this Mac, or open a location.` (say *this computer* on the web), actions `Try Again` on failure, `Open Location…`, `Accounts…`, and the `Trees on this Mac` list (icon, title, path). canopyd host: `No Tree Open` with the account's trees instead, and `Pair this browser` when unpaired.
- **Confirmation bar** above the page: `confirming` shows spinner and `Connecting… Editing turns on once this tree is up to date.`; `unconfirmed` shows the warning `Read-only: <message>` with `Try Again`. The editor is non-interactive until `ready`, exactly as `.allowsHitTesting(node.isWritable)`.
- **Read-only in another tab** (web only): same bar style, `Read-only: this tree is open for editing in another tab.`

## 2. Sidebar

One `PagePicker` component serves the sidebar, Search Contents, Move to and Move Page, as `ArborPageSearchControls` + `ArborOrderedPageSections` + `ArborPagePickerSelection` do natively.

- **Heading**: the current location; the parent portion is a quiet link (`Go to Parent`), then a spaced slash and the final segment. No brand row, no separate Parent row.
- **Search field**: prompt `Search pages`, clear button `Clear Search`. ↑/↓/↩ move and open; Escape returns focus to the editor. Empty query lists every page so the sidebar is useful before typing.
- **Order control** beside the field: `Alphabetical` / `Recent` / `Link Count`, plus `Trees` in the sidebar only. Page destination pickers retain the three page orders. Selection is persisted per surface (`pageOrder.sidebar`, `pageOrder.moveTo`, `pageOrder.movePage`) in `localStorage`.
  - Recent groups: `Today`, `This Week`, `This Month`, `Earlier`, `Unknown date`.
  - Link Count groups: `0 Links`, `1 Link`, `Multiple Links`; counts visible only in the last group.
  - Alphabetical: flat, leading emoji ignored for sorting.
- **Rows**: leading emoji from the title or a document glyph; folder glyph for folders; title without its emoji; context path `/parent/dir` head-truncated; optional backlink count. Context menu: `Open`, `Open in New Tab` (web-native: ordinary link target), `Move Page…`, `Move to Trash`. Rows accept a dragged block (B3) and append it to that page.
- **Trees mode** replaces pages with the available tree inventory, shows account/host context and a checkmark for the current tree, and changes the search prompt to `Search trees`. Search filters tree names and account labels; ↑/↓/↩ select and open trees, never stale page results. Native Mac lists local placements with `Open Tree…`; iOS lists native placements with `Add Tree…`. Web inventory and placement policy follow §11.
- **People footer** is fixed below the scrolling rows, shares their text/icon alignment, and opens the directory (§17). Native uses `person.crop.square`, clear interactive glass, and a continuous right-hand hairline; web adapts the material while retaining hierarchy and alignment. It contains no My profile shortcut.
- **Choices entry**: header button `Review choices` with a count badge when a review model has decisions or is pending (B3).
- **Collapse**: subdued double-chevron with help `Show Sidebar` / `Hide Sidebar`; width min 180, ideal 260, max 500, persisted. Narrow layouts use an overlay drawer with backdrop and focus restoration; no edge gesture.
- **Empty**: `No results for "<text>"`.
- Do not port `ArborSidebarRow` (dead code natively).

## 3. Navigation

- **Breadcrumb heading** in the toolbar: parent prefix as a button (`Go to Parent`), leaf as text, head-truncated. Stops at the tree root.
- **Back / Forward** are the browser's history; the app pushes one canonical URL per location. **Go to Parent** ⌘↑ and **Home** ⇧⌘H.
- **Open Location** (⌘⇧L on the web; ⌘L is the browser's): field `Location path`; `http(s)://` and `arbor://` open a visit (read-only working tree following the tree's watch); `~`/absolute paths open the enclosing placed tree (local host only) or fail with `… is not inside a placed tree. Place the folder with arbor place first.`; otherwise a path in the current tree. canopyd host also accepts canonical paths on that canopyd.
- **Tabs**: the in-app tab strip is not ported; browser tabs are the tabs. `Open in New Tab` on rows and ⌘-click on links do the browser thing. See the plan's *Storage and tabs* for writability.
- **Toolbar right side**: `Share` (when fully synced) or the sync indicator button (opens Sync Status), then the `Accounts` control with the sync badge (`Accounts — <status>`). Both account and sync entry points open the same profile/sync/devices pane (§7), without tabs. Indicator states: `Fully synced`, `Syncing`, `Offline`, `Sync needs attention`.

## 4. Editor pane

Backed by BlockNote plus `@overstory/protocol`; each item names its project.

**B1 (minimum editable document)**

- Theme from `ArborStyle.editorTheme`: body 16 px with 3.5 px line spacing, page title 40, H1 30 / H2 24 / H3 20 / H4 18 / H5 17 / H6 16, inline code 13.6, content width 708, proportional padding, indent 24, marker column 24.
- Block kinds: paragraph, heading (h1–h3 authorable; h4–h6 displayed), bullet, numbered, to-do, quote, code with language, divider, toggle, template button, document link, image, and the read-only **unsupported** carrier row labelled by kind (`Table`, `HTML`) so source round-trips. Title is the first top-level H1; the leading emoji grapheme is the document icon.
- Autotransforms on trailing space: `# `, `## `, `### `, `- `/`* `, `1. `, `[] `/`[ ] `, `> `, `" ` (toggle); on Enter: `---` divider, ```` ``` ```` code fence.
- Inline marks ⌘B, ⌘I, ⌘E, ⇧⌘S; ⌘K toggles a link on a selection. Internal links open in the app; external links open normally; URL autolinking.
- **Block action menu** ⌘/ (and the slash menu): row one is Turn Into tiles in groups with one-key chips: `Text` t, `Page` p; `Bullet` *, `Number` 1, `To-do` [, `Toggle` >; `H1` #, `H2` 2, `H3` 3; `Divider` -, `Template` m. Current type selected, unavailable targets hidden. Row two: `Copy`, `Move to`, `Outdent` [, `Indent` ]. Turn Into on a document-link row inlines the child page.
- **@mention**: up to 8 pages ranked as `mentionSuggestionRank`; `Searching…`, `No matching pages`; commits a document-link row; never creates pages. Home page row labelled `Home page`.
- **Images**: paste or drop stores bytes under the tree's `Assets` directory through the working tree, resolved from the overlay before acceptance; states `Loading image…`, `Missing image: <source>`, `Could not load image`; click opens a lightbox (not a window).
- **Undo**: one undo stack with 750 ms pause-delimited typing checkpoints; external reconciled replacement rebases it; conflict or reload replacement clears it. ⌘Z / ⇧⌘Z.
- **Find in page** ⌘F when the editor has focus: `Find in Page`, `No results` / `N of M`, `Previous Match`, `Next Match`, `Close Find`.
- **Document footer** inside the scroll: `LINKED FROM` with backlink rows (same presenter as the sidebar); the sync chip (indicator plus label, opens Sync Status, hint `Shows local durability and synchronization details`). Zero backlinks shows no section.
- **Read-only** documents render the same editor with editing disabled and the provenance line plus lock.
- **Non-document surfaces**: provenance line with `Read only`; directory shows its listing; file shows name, size and type; collection shows kind and row count; `Not available offline`; `Historical revision <rev>`.

**B3 (depth)**

- Block navigation mode: ↑/↓ collapse selection, ⇧↑/↓ extend contiguously, ↩ enters edit, Escape leaves; edge-of-text traversal between blocks.
- Structural keys: Tab / ⇧Tab indent and outdent, ⌥↑ / ⌥↓ move blocks, ⌘↩ insert below, ⇧⌘P Move to, ⌘K create a page from the selected block.
- Folding: chevron on every heading except the title H1; `Fold Section` / `Unfold Section` in the block menu; ⌥⌘← / ⌥⌘→ fold and unfold all; session-local.
- `:emoji` completion (`Search emoji`, `No matching emoji`, frequency ranking) and document icon set/clear.
- Drag handles with midline drop, drop onto a closed toggle, template button or link row appends as a child; drop onto a sidebar row moves to that page (`Page moved`).
- Markdown-aware copy/paste with HTML and plain-text flavours; link previews (favicon and title, cached, cancellable).
- Template button insertion and host block actions if Overstory ever supplies any (it supplies none today).

## 5. Search Contents

⇧⌘F. Field `Search titles and text`, 140 ms debounce, stale requests disregarded. Rows: title, containing path, two-line excerpt rendered as marked ranges. ↑/↓/↩ with scroll-to. States: `Search this tree` (`Find words in page titles and body text.`), `Searching contents`, `No results`. Desktop: a 480×460 modal; narrow: full-height sheet. Scope stays the current tree; `All trees` is offered on the local host when several placements exist.

## 6. Share and app permissions

- **Tracked tree**: heading `Share` and the canonical address on one line (selectable, middle-truncated). Invite row `Add people or groups` with prompt `~handle or Overstory profile URL` and a `Share` button; several locators accepted; invites get read. Non-administrator footer `This browser needs administrator access to share. Open Accounts and make this device an administrator.`
- `Who has access`: avatar, name (`Everyone`, display name or `Person or group`, `Private link`), detail (`Owner`, `Anyone who can find this tree`, `Existing access-link grant`, locator), `(You)`, and either `Full access` (help `Your access cannot be removed`), a menu `Can view` / `Can edit` / `Remove access`, or a static label. Synthetic `Everyone` row when absent. Read-only footer `Only an administrator for this canopyd account can change access.`
- `Scoped and app permissions`: existing rules plus `Manage app permissions…`.
- **Promotable folder** (local host only): `Upgrade this folder`, explanation `The folder stays in place and gains its own Arbor identity, history, synchronization, and access controls.`, `Destination` account picker (`~handle · host`), `Canonical URL` with suggested slug, `Initial access` (`Private` / `Everyone can view` / `Everyone can edit`), `Make This an Arbor Tree`. Empty state `No connected canopyd account`.
- **App permissions**: title `App permissions`; rules list; form `Caller: me, everyone, or profile TreeID`, `Executable TreeID (optional)`, `Within`, one toggle per operation, `Remove matching rule`, `Review change`; review shows `Account configuration:`, `Resource:`, `Before:`, `After:` and the caveat `This grants only authority this account currently holds. Other matching rules may also grant access.`; `Back`, `Grant permission` / `Remove permission`.
- Dialog is content-sized with a bounded scroll region, closes on Escape unless a destructive confirmation or in-flight operation owns dismissal, restores focus to the Share control.

## 7. Accounts, devices, pairing

One scrolling dialog, ordered **profile rows → current-client sync status → devices**. No Accounts/People/Sync tabs and no tree chooser. The account control and sync chip open this same pane. Profile and sync rows have grouped backgrounds; the working-tree/provider detail is a background-free footer belonging to the sync section.

- Accounts, devices, share and app permissions are all edits to the account configuration tree through its own working-tree session, on both hosts, exactly as `ArborAppModel` edits `devices.yaml` and `trees.yaml`; only pairing offers and claims call canopyd directly.
- Per account: the shared directory-style profile row (§17), with avatar, display name, account/host detail, and a far-right chevron opening the profile. No `Open profile` text button or duplicate `Edit name & photo…` action. `Devices` rows with label and tags `This browser` / `This Mac` / `Active` / `Administrator`; ellipsis menu `Make Administrator`, `Remove Administrator`, `Deauthorize Device` (destructive; disabled for the last administrator or a non-administrator caller); confirmation `Deauthorize <label>?`; results `<label> can now manage sharing.` / `<label> was deauthorized.`
- **Add account** is a small `person.badge.plus` affordance at the right of the first Devices header (accessible name `Add account`, help `Add account…`), also present when no accounts exist. It is not a separate large form row. Mac opens a focused connect-community/pair-device flow; iOS opens pairing without restoring the existing placement. Web adapts this to its host's claim/pair capabilities.
- The Mac profile ellipsis offers `Back up identity…` when the local identity key is available; `Recover identity…` appears when the key is missing. These are native identity operations, not browser credential exports. The Welcome flow is not reopened for ordinary account management.
- Profile and device sections have separate identities even when they refer to the same account, so list reconciliation cannot merge them.
- `Pair another device…` shows the QR (generated client-side) and the `Confirm on both devices` code, for a phone or another browser.
- **Pair this browser** (canopyd host, and the local host when the daemon has no credential): paste the code (`Paste Pairing Code`, `The clipboard has no pairing code.`), show `Pairing with your Mac…`, then the account appears. No camera.
- Identity: `Profile TreeID` (monospaced, selectable), `Copy Profile TreeID`, `Send this public ID to the canopyd administrator before claiming your account.`, URL field and `Claim Account` — local host only, with an existing identity; identity creation stays swift/CLI.
- `Disconnect` is quiet and destructive: `Disconnect this browser from Arbor?` with `Your server tree is not deleted.`; on the canopyd host it forgets the browser credential.
- States: `No canopyd account` (`Claim or pair an account to manage its devices.`), `Loading account…`, `Could not refresh: …` with `Try Again`.

## 8. Sync Status

- Hero: symbol, title (`A document needs attention`, the state label, `Retaining edit locally`, or `This Arbor client is up to date`), detail (`This client has no unpublished document or working-tree changes.` or the per-state text: offline, local changes waiting, request queued, uploading, downloading, merged automatically, conflict needs a choice, reconnect the account, device no longer has access).
- States and labels: `Offline`, `Local changes`, `Sync pending`, `Uploading`, `Downloading`, `Current`, `Merged`, `Merged approximately`, `Conflict`, `Sign in required`, `Device revoked`.
- Primary button by state: `Review Edit Conflict` | `Retry Save` | `Sync Now` (disabled offline). Always `Network Log…` (help `Timings for updates, watch frames, and reads`). `Reconnect to arborsync` and `View arborsync Logs…` are not ported (no new daemon routes).
- `Current document` section while saving, conflicted or failing: `Save status` values `Retaining edit locally`, `Conflict needs a choice`, `Private recovery failed`, `Retained in recovery; working tree pending`, `Latest edit not retained locally`, `Retained locally`; diagnostic cause, explanation, recovery and monospaced technical detail.
- The browser's Sync Status reports only the browser's own document and coordinator, as native does. On the local host, `GET /v1/trees` sync state may appear as one quiet diagnostic caption at the bottom; it is never the badge.

## 9. Keyboard map

Same as native unless the browser owns the key. Reassignments:

| Native | Web | Reason |
|---|---|---|
| ⌘L Open Location | ⇧⌘L | browser location bar |
| ⌘P Jump to Page | ⌘P intercepted when the app has focus | print is rarely wanted; matches common editors |
| ⌘[ / ⌘] Back / Forward | browser history | free |
| ⌘W, ⌘T tabs | browser tabs | tab strip not ported |
| ⌘F Find in Page | ⌘F intercepted when the editor has focus | otherwise browser find |
| ⌥⌘1/2/3 page order; ⌥⌘4 Trees mode | same | none |
| ⌘\ Toggle Sidebar, ⇧⌘F Search Contents, ⌘↑ Parent, ⇧⌘H Home, ⌥⌘P Move Page, ⇧⌘\ Recover, ⌘I Source and Properties, ⌥⌘S Share, ⌥⌘← / → fold all, ⌘Z / ⇧⌘Z, ⌘/ Block Actions, ⌘K, ⌘↩, ⇧⌘P, Tab / ⇧Tab, ⌥↑ / ⌥↓, ⌘B / ⌘I / ⌘E / ⇧⌘S, ⌥⌘↑ / ⌥⌘↓ choices | same | none |

Every picker list (sidebar, Search Contents, Move to, Move Page) takes ↑ ↓ ↩ and Escape; block-menu one-key chips while open: `t * 1 [ > # 2 3 p - m c [ ]`. Publish the table in `docs/implementing-editors/design.md` in the phase that implements each surface.

## 10. Attention banner

One floating capsule at the top of the page, max 560 px, chosen in priority order: document conflict (headline, `Review…` / `Hide`, `Merge` when an automatic merge source exists, tooltip with `Current revision: …`); title rename proposal (`Rename this page to "X" to match its title?`, `Rename` / `Not Now`, two seconds after the accepted title changes); save diagnostic (red, `Retry`, `Details…`); model or workspace error (red, `Dismiss`).

## 11. Home: trees and accounts

Native no longer has a separate Trees & Accounts switcher sheet: Trees lives in the sidebar order picker. The web Home surface below remains a browser-specific entry point to the same inventory, not a native management tab.

- **Local host**: placements from `/v1/trees` grouped per account (`~handle` and host; unmatched as `Other Trees`), current tree checked, recent visits with stale/offline state (there is no native visits view; the web adds one because Open Location is the only entry today), `Open Location…`, `Accounts`. `Place Another Tree` is not offered: placing stays `arbor place` and native.
- **canopyd host**: the paired account's trees from `/.arbor/trees` with `Can edit` / `Can view`; opening one bootstraps it in the browser. No placement concept.
- Reached from the breadcrumb root and ⇧⌘H, not from an overscroll gesture.

## 12. Network log

- **Network Log**: filters per kind (`update`, `connect`, `frame`, `disconnect`, `read`, `note`), `Filter` text, visible count; rows newest first with time, kind capsule, name, shortened tree, HTTP status, round trip or duration, `server N`; expand for tree, updates, root, cursor, digests, attempt, bytes out/in or `frames`, `after response`, `server phases`. Toolbar `Copy` → `Copied`, `Refresh`, `Clear`, `Done`. Empty `No network events`. Source: the browser's own `WireNetworkLog` in IndexedDB, bounded. `Reveal File` is not ported.

## 13. Conflict and choice review

- **Choices list** replaces the page list in the sidebar: back chevron `All pages`, title `Choices · N`, refresh; grouped by page (`Tree contents` for `/`), rows with decision summary and `Draft retained`; section `Retained drafts` with `Choice resolved` / `Status unavailable`; empties `No choices` (`Every choice in this tree has been reviewed.`), `Choices unavailable`. Per-row `Review choices on <title>` button in the ordinary list.
- **Review panel** above the document (document-anchored, revealed by the marker `N unresolved choices` / `Choice resolved`): header with decision title, `Previous choice` ⌥⌘↑, `Next choice` ⌥⌘↓, `Close review`; dependent-group notice `Resolve N dependent choices together` with member picker; status `Choice resolved · Your draft retained`, `This choice has changed. Your draft is retained.` with `Review latest alternatives`; `Alternative` picker (`Choose a version…`, `Version N · Currently displayed`); toggle `Remove this source range` / `Remove this entry in the combined result`; composed source editor `Proposed resolution source` with `Use selected version instead…`; alternative presentation (directory listing, `This version removes the entry.`, source comparison, `Binary content · N bytes`); `Destination` path (`Absolute path within this tree. The parent must exist in the proposed result.`); obligations; `Combined result · N changed paths` with per-change disclosure; `Copy exact source`; `Preview combined result` / `Preparing preview…`, `Apply and resolve`, `Close review` or `Discard draft…`; pending row `Checking whether applied · Draft retained` with `Check again`. Confirmations `Discard the composed result and use the selected version?`, `Discard this review draft?`. Draft retention labels `Applied result`, `Proposed result · Draft retained locally`, `… Retaining draft…`, `… Draft retention failed`.
- **Source comparison**: `Proposed result` / `Currently displayed`, status `Identical source`, `N changed lines highlighted`, `Changes appear in the other version`, `Highlighting unavailable for this large comparison`, `Comparison unavailable`; `Compare with displayed` / `Show proposed`; byte-exact line diff; `(Empty file)`.
- **Document conflict view**: `Resolve Document Conflict`; `What happened` (headline, explanation, `Reported by`, `Conflicting paths`, reasons); `Resolution choices` with chips `Current` / `Mine` / `Both` / `Edit`, monospaced editor in Edit, `Compare versions` disclosure (`Current`, `Mine`, `Both (server draft)`, `Common base`); `Apply Choice`.

## 14. Source and Properties, History

- **Source and Properties** ⌘I: `Identity` (Tree, Path, Stable key), `Provenance` (Source, Revision, Access `Writable` / `Read only`), `Exact source` monospaced and selectable. Read-only; there is no in-editor source mode natively either.
- **History** ⇧⌘\: title `History`; rows with entry title, timestamp and `Restore as New Change` with confirmation `Restore this revision as a new change?`; empty `No local editor copies yet`; footer `Local editor copies are saved on this device before synchronization. Restoring creates a new change and keeps the original copies.` Recovery copies live in IndexedDB per browser profile.

## 15. Move to and Move Page

- **Move to** (blocks, ⇧⌘P, B3): title `Move to`; `On this page` lists headings and toggles with `H1/H2/H3` or toggle glyphs, depth indent, collapsed to five with `Show N more` / `Show less`; then pages with the shared order control; `No matching destinations`.
- **Move Page** (⌥⌘P, B1): title `Move Page`, prompt `Search pages and folders`, rows with home, folder or document glyph, context path and backlink count, hint `Moves the page beneath this destination`; not dismissable by clicking outside while a move is in flight; `No legal destinations`. Enabled only for a writable document that is not `/` and not in Trash.

## 16. Trash, restore, orphan prompt, title rename

- `Trash Page…` with `Move this node to Trash?` (`Move to Trash` destructive / `Cancel`); `Restore Page` only under `/Trash/`.
- After a document-link row is deleted: `Move linked page to Trash?` with `"<title>" no longer has any links pointing to it.`, `Move to Trash` / `Keep Page`.
- Title rename proposal as in §10; `New Document` (`Name`, `Initial Markdown`, `Cancel` / `Create`) and `New Folder` forms.

## 17. People directory

Opened from the sidebar's **People** footer or the People command. Search prompt
`Search people and groups`; separate **People** and **Groups** sections. Do not add
a second prominent People heading above the section header. Rows use avatar,
display name, account/host detail, and a trailing chevron; both the name/avatar area
and chevron open the hosted profile. Unhosted profiles are disabled with `Not hosted`.
The account modal reuses this row, adding its identity menu before the chevron.

Keep `Refresh`, `Done`, the directory error, and `No people found` empty state.
Do not display `Community`, `Group`, or `Shared` source badges: those indicate
how the profile was discovered, not the person's type or role. Retain source
provenance in the underlying directory data.

## Not ported (by decision)

| Native affordance | Where | Web replacement |
|---|---|---|
| Menu bar, `@FocusedValue` command routing | `ArborApp.swift` | keyboard map and in-page menus |
| Sheets and popovers as a concept, the Mac dismiss-handoff dance | `ArborRootView.swift:1687–1740` | ordinary modal stack |
| Search in the sidebar's toolbar section, `NSPopUpButton` order picker, hover washes | `ArborRootView.swift:1545, 388, 279` | a field above the list, a native `<select>`-style menu |
| iOS edge-drawer gestures, top-overscroll `Pull for Trees` (opens sidebar Trees mode) | `ArborRootView.swift:1058–1113, 1999, 3498` | sidebar toggle, Home link |
| Pinch-to-insert, three-finger cycling, swipe-to-extend selection | Quagmire | keyboard structural editing |
| Voice recording, transcription, pending-recording recovery, Siri and App Intents | `ArborRootView.swift:52`, `VoiceRecordingIntents.swift` | none; the `🎙` heading convention still renders |
| Sounds and haptics | `ArborStyle.swift`, Quagmire | none |
| QR camera scanning | `ArborRootView.swift:3882` | paste the pairing code; QR is still shown for phones |
| Keychain stores, `terminateLater` flush | `ArborRootView.swift`, `ArborApp.swift:311` | IndexedDB; `beforeunload` waits on the admission flush |
| Finder reveal, full-size image window | `ArborNetworkLogView.swift`, `ImageBlockView.swift:223` | `Copy`; lightbox |
| In-app tab strip | `ArborDailyDriverViews.swift:1176` | browser tabs |
| Reconnect / view arborsync logs | `ArborDailyDriverViews.swift:992` | not ported; `arbor daemon status` and the native app keep them |
| Placing a tree from the app | `ArborRootView.swift:3670` | `arbor place`; the canopyd host has no placement |
