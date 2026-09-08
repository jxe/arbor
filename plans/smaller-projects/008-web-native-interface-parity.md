---
id: wnp4kq
---
# Smaller project 008: Bring Arbor web to native interface parity

- **Priority:** P2 product polish
- **State:** PLANNED
- **Reference:** native Arbor at `5a45847`
- **Depends on:** no implementation milestone; coordinate unsafe search excerpts
  with [Security 001](../security/001-search-excerpts.md) and synchronization
  meaning with [Reliability 005](../reliability/005-client-synchronization-state-machines.md)

## Target result

Make local Arbor web and native Arbor feel like two platform-appropriate
versions of the same product. Match the information architecture, vocabulary,
data, and visible states introduced in native Arbor at `5a45847`; do not copy
macOS menu placement, toolbar chrome, sheets, or controls literally into the
browser.

The completed web interface has:

- one quiet, location-led shell using **tree**, never **workspace**, in visible
  product language;
- a contextual sidebar whose heading is the current location, whose parent
  portion navigates upward, and whose child rows use authored H1 titles and a
  leading emoji in place of the generic document glyph;
- search that is useful before typing, includes non-root paths, uses the same
  title/icon presentation as navigation, and visibly distinguishes pages with
  zero, one, or several inbound links;
- bottom-of-page backlinks with the same title/icon/path vocabulary;
- a compact Share dialog with the canonical address in its heading, no
  redundant explanatory copy, content-sized height, and Escape dismissal;
- one account/status dialog with **Accounts** and **Sync Status** tabs, durable
  loaded state across tab switches, account/profile context, device status and
  safe actions, tree-by-tree status, and an overall synchronization state; and
- responsive, keyboard-accessible equivalents on desktop and narrow browser
  layouts.

## Current source and constraints

The browser shell is currently concentrated in
`packages/render/src/App.tsx`, with presentation in
`packages/render/src/styles.css` and the local REST adapter in
`packages/render/src/api.ts`.

Useful foundations already exist:

- `crumbsFor()` and the main `.breadcrumbs` header preserve OS-shaped URL
  navigation and collapse long paths;
- the sidebar already loads a contextual directory without refetching the
  current document;
- `SearchResult` now carries the authored display title and `backlinkCount`,
  and an empty `/v1/search` query lists indexed pages;
- `NodeSummary.title` carries the display title while `name` remains the
  storage name; `packages/editor/src/display-title.ts` owns leading-emoji
  splitting;
- `PageEditor` already renders indexed backlinks at the bottom;
- `LocalTreeDescriptor.sync` exposes `idle`, `syncing`, `offline`, `conflict`,
  or `error`, while `missing`, placement, canonical address, account scope, and
  access are already available from `/v1/trees`;
- the profile dialog already loads plural accounts, active devices, pairing,
  profile namespaces, and share controls; and
- editor save status already exists inside `PageEditor`.

Do not collapse TreeID, logical path, stable key, browser URL, canonical URL,
and local OS path into one display or navigation value. Do not expose account
configuration TreeIDs or `~/.arbor/accounts/tr_…` paths when a profile handle,
canonical path, or literal “Account settings” label is available.

## 1. Freeze shared presentation helpers

Add small browser presentation helpers, tested without React, for:

1. splitting a leading emoji from an authored display title;
2. choosing the visible title (`title`, then storage `name` only as fallback);
3. formatting a parent path separately from its final segment while preserving
   the exact navigation URL;
4. formatting account-configuration, profile, ordinary, remote, missing, and
   unplaced trees without leaking opaque IDs; and
5. mapping tree synchronization and editor-save state to the user-facing
   labels used by native Arbor.

Reuse the semantics of `display-title.ts`; do not introduce a second Markdown
parser in `@arbor/render`.

## 2. Recompose the shell and sidebar

Extract only the concrete shell pieces from `App.tsx` that this work needs
(`Sidebar`, `SearchView`, `AccountStatusDialog`, and `ShareDialog`). Keep
navigation and mutation ownership in `App`; this is not a general component
framework or state-management migration.

For the desktop sidebar:

- replace the Arbor brand plus separate `.sidebar-path` row with one
  location heading;
- render the parent portion as a quiet link, then a spaced slash and the final
  segment in normal foreground text;
- remove the dedicated Parent row because the heading owns that action;
- use a subdued, borderless double-chevron control for collapse/expand with a
  comfortably sized hit target;
- render a folder glyph for folders and the leading title emoji instead of the
  document glyph when present; otherwise retain one restrained document glyph;
- show the authored title without repeating its emoji and increase row type
  slightly; and
- place a compact alphabetical/recent page-order toggle beside search, keep
  alphabetical as the default contextual child view, and group the recent view
  under calendar-relative headings such as **Today**, **This Week**, **This
  Month**, and **Earlier** using each result's source modification time; and
- keep contextual child loading, selection, context menus, and local sidebar
  width/collapse persistence intact.

Do not add Recently Visited or “On this Mac” sections to the sidebar. The home
surface may retain its distinct tree chooser and remote-visit history; this
plan does not silently delete those capabilities.

On narrow layouts, retain the overlay drawer and backdrop. Its heading,
search, rows, focus restoration, and close behavior must match the desktop
information model.

## 3. Make search a useful navigation view

On wide layouts, opening search replaces the sidebar child list with search
results and an idiomatic search field; closing it restores the prior contextual
listing. On narrow layouts, use a focused modal or drawer presentation rather
than forcing a permanently visible sidebar.

The search view must:

- issue the empty query on first presentation so pages appear before typing;
- preserve the selected page order while searching: alphabetical mode sorts by
  authored title with path as a stable tie-breaker, while recent mode sorts by
  modification time and retains the same calendar-relative groups;
- retain the current-tree/all-trees scope choice without disabling useful
  empty-state navigation;
- cancel or disregard stale requests and preserve the current 120 ms debounce
  only for non-empty text;
- show the leading emoji as the row icon, the authored H1 as the primary label,
  and the parent path as a secondary VS Code-style location;
- retain exact URLs for navigation across nested and mounted tree boundaries;
- show an inbound-link indicator for every page, including zero, with readable
  singular/plural accessibility labels; and
- support Up/Down, Return, and Escape without stealing text-editing shortcuts
  after dismissal.

Render excerpts as text/marked ranges, not `dangerouslySetInnerHTML`; Security
001 owns the safe excerpt boundary and must land with or before this rendering
change.

## 4. Align page footer and Share

Keep backlinks at the bottom of the page, but route their rows through the
same title/icon/path presenter used by the sidebar and search. Preserve
TreeID/stable-key navigation and existing loading cancellation. Zero backlinks
should not create an empty ornamental section; search remains the place where
zero is intentionally visualized.

Restyle both existing-tree and promotion Share flows around the native
hierarchy:

- heading “Share” and canonical web address on one horizontal line;
- no visible “Tree address” label;
- remove generic additive-access and multi-handle helper paragraphs when the
  controls are self-explanatory, while retaining warnings tied to a concrete
  unsafe permission;
- size the desktop dialog to its current rows with a bounded scrolling region
  only when accounts or access rules exceed the available viewport;
- close on Escape unless a destructive confirmation or in-flight operation
  owns dismissal; and
- retain click-outside close and restore focus to the invoking Share control.

## 5. Unify Accounts and Sync Status

Replace the overloaded profile dialog with a single dialog whose persistent
tab selector is **Accounts** / **Sync Status**. Opening the profile control
selects Accounts; a new status entry in the web page-actions menu selects Sync
Status. Once open, switching tabs must be immediate.

Load account descriptors, devices, tree descriptors, and daemon status into a
dialog-level cache. Show a first-load state inside the selected tab, refresh in
the background, retain successful rows when refresh fails, and never defer
opening the dialog until a request completes.

### Accounts

For each account, show the handle/name and Canopy host, a link to its profile,
then an idiomatic Devices heading and rows. Each device row has status tags
such as **This device**, **Active**, and **Administrator**, plus an ellipsis
menu for the actions the current administrator may perform:

- Make Administrator;
- Remove Administrator; and
- Deauthorize Device.

Put Pair another device below the device rows as a link without row
background. Preserve confirmation for deauthorization and the invariant that
the last administrator cannot be removed or deauthorized.

The current browser helper reads individual `devices/*.yaml` files and cannot
represent administrator state safely. Add one account-scoped Arbor Sync REST
presentation/mutation boundary rather than teaching React to infer or rewrite
authorization policy. Update `@arbor/client`, the REST documentation, shared
fixtures if the protocol shape changes, and focused daemon tests together.
Server-side mutation must re-read current account state, authorize the acting
device, preserve unrelated YAML/comments, enforce the last-administrator rule,
and use guarded writes.

Keep identity creation and account claiming as explicit setup flows, not
ordinary rows in an already-configured Accounts tab. Keep Disconnect quiet and
destructive. Do not duplicate Trees here; they belong in Sync Status.

### Sync Status

Lead with one overall condition and primary Sync Now action. Combine editor
save state with tree synchronization state so an unsaved/conflicted document
takes precedence, followed by daemon/account synchronization, then per-tree
attention. User-facing states are:

- Everything is up to date;
- Local changes;
- Sync pending;
- Uploading;
- Downloading;
- Merged;
- Merged approximately;
- Offline;
- Conflict;
- Sign in required; and
- Device revoked.

Reliability 005 owns any new portable state-machine contract. Until that lands,
derive only states supported by current observations and do not pretend an
`idle` tree proves an interrupted document save is durable.

List every known tree with friendly title, account context, canonical or local
location, access, and one status tag. Label the configuration tree as account
settings and the profile tree as Profile. Show current-document detail only
while saving or when it needs attention. Put provider/daemon detail in quiet
caption text at the bottom.

Place Reconnect to arborsync and View arborsync logs in an ellipsis menu beside
the top status action. If logs need a new browser-safe REST endpoint, return a
bounded redacted diagnostic payload; never expose credentials, pairing secrets,
private access-link secrets, or arbitrary local files.

## 6. Verification and acceptance

Add focused unit/component coverage for presentation helpers and state
priority, then extend `tests/e2e/browser.e2e.ts` with deterministic fixtures.
Acceptance requires:

1. empty search shows pages and correct 0/1/N inbound counts;
2. nested results show title, emoji-as-icon, and parent path and navigate with
   exact tree scope;
3. sidebar heading parent navigation, icon fallback, collapse/expand, and
   mobile drawer focus all work by keyboard;
4. backlinks share the same presentation without losing stable-key targets;
5. Share has no redundant labels/copy, is content-sized, and Escape restores
   focus;
6. either account/status entry opens the dialog immediately at the requested
   tab, repeated tab changes do not flash a first-load spinner, and stale
   responses cannot replace a newly selected account;
7. device action menus expose only authorized operations and server tests prove
   non-admin, stale-write, last-admin, and deauthorization failures;
8. Sync Status prioritizes save failure, conflict, offline, pending, syncing,
   and healthy states correctly and gives configuration trees friendly names;
9. no visible local browser UI says workspace; and
10. 390 px and desktop Playwright screenshots have no clipped controls,
    unintended horizontal scrolling, or inaccessible icon-only buttons.

Run at minimum:

```sh
bun run typecheck
bun test tests/unit tests/integration
bunx playwright test tests/e2e/browser.e2e.ts
node tools/browser/editor-audit.js
git diff --check
```

If protocol or account mutation surfaces change, also run all affected Swift
client conformance tests and regenerate checked-in protocol fixtures before
calling the plan complete.

## Out of scope

- pixel-copying macOS controls, application menus, toolbar placement, or sheet
  decoration into HTML;
- the persistent hierarchical sidebar and sidebar drag/drop still owned by
  Smaller project 005;
- changing Markdown title/icon semantics, TreeID, locator, stable-key, access,
  or synchronization contracts merely to simplify React state;
- exposing a generic accepted-history browser, conflict auto-resolution, raw
  credentials, or unrestricted daemon logs; and
- broad React state-library, router, CSS-framework, or component-system
  migrations.
