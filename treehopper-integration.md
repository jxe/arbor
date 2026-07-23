# TreeHopper native (Swift)
*Concrete integration seams for phase B2, organized around the workspace TreeHopper opens, the shared trees it can mount, and the scripts it can render. TreeHopper native is built from the existing Hunch app codebase (`~/src/hunch`) — internal component names (Clamshell, `EditorHost`, …) keep their code names — and it is not merely inspiration: its existing filesystem and durability model already supplies most of the browser.*

## Why the fit is structural

- **Plain Markdown in a folder the user owns.** A materialized Arbor workspace already looks like a TreeHopper workspace and remains directly usable by agents.
- **One link classifier.** `EditorHost.resolvePageID(from:in:)` is the seam through which workspace paths, public names, `TreeID`s, and legacy URLs enter.
- **Hostile concurrent edits are expected.** Clamshell already reconciles iCloud rewrites, journals every block, restores dropped subtrees, and structurally merges conflicts—the same threat model created first by local mutations/overlay routing and later by remote sync.
- **The home page plus Cmd+P is enough navigation.** `system:mounts` can appear as subpage-like rows; Arbor does not require a sidebar.
- **Arbord materializes real files.** TreeHopper edits the workspace; arbord watches and routes writes to local folders, mounted trees, or overlays. Neither side needs a second document model.
- **Collections keep one UI vocabulary across stores.** File-backed, SQLite, and Postgres collections render through the same built-ins or islands; Clamshell never becomes a database engine.
- **BlockNote is an interaction layer over canonical Markdown.** TreeHopper web uses Arbor's source-spanned parser/serializer, preserves unsupported syntax as raw blocks, and maps Clamshell's `▸` toggle grammar onto BlockNote's nested toggle UI without persisting disclosure state.
- **Pages keep one logical name as they grow.** Sibling `x.md` supplies `/x`'s body, `x/` supplies its children, and `x/_index.md` is the body fallback only when the sibling is absent; both TreeHopper faces, arbord APIs, links, search, history, and journals use the extensionless identity.

## Division of labor

```text
TreeHopper (Swift, native)                    arbord (Bun, headless)
──────────────────────                   ──────────────────────
block editing, typography, navigation,   shared trees, system: state, mounts,
journal/reconcile/merge, Cmd+P,          overlays, watcher routing, index,
Recover, provenance/share/system UI,     schemas/store drivers/typegen/runtime,
WKWebView island blocks                  render routes; DNS/sync/shares from C
                    │
                    └──── localhost API + materialized files ────┘
```

Clamshell keeps page IO, journals, trash, assets, and editor merge behavior. Its `.history/` and `Trash/` sidecars are device-local and excluded from shared trees. Arbord owns workspace resolution, mounts, permissions, execution, and network synchronization.

## Phase-B seams

### 1. Link and path resolution

`Clamshell.pageID(for:relativeTo:)` gains one branch: anything outside the physical workspace asks `/v/resolve` and receives a typed result such as:

```text
materialized(path, provenance)
visited(path, stale)
external(url)
unresolved(name)
```

In phase B only local folders and mounts resolve. Phase C adds public aliases, `TreeID`s, and invitations without changing the TreeHopper classifier again. Materialized pages still enter `openPage` through the existing path. The classifier canonicalizes `.md` and `/_index.md` storage aliases before navigation, and rendered Markdown links use the same resolver rather than behaving as inert editor text.

The web sidebar lists the current page's containing directory (or the current directory's own children) and offers parent navigation only inside the launched workspace root. Native TreeHopper may keep its home-plus-Cmd+P navigation, but it must preserve the same logical paths and bounded parent semantics anywhere it exposes hierarchy.

### 2. Human-readable `system:` surfaces

The mount table no longer lives in `_index.md` or `_mounts.toml`. Its canonical backing is one human-readable local record per mount. When the Arbor workspace home opens, TreeHopper asks for `system:mounts` and renders each mount as a native subpage-like row alongside ordinary authored home content.

- Selecting a row opens its materialized `at` path.
- The default row reads naturally: “Team Atlas → projects/atlas · read-write · latest.”
- Add/edit/remove actions use an inline table or form and call arbord's atomic system API; drag/repath is allowed where unambiguous.
- Source view opens the same Markdown/frontmatter record, and direct edits remain fully supported.
- Friendly shared-tree names are primary; `TreeID`, endpoint, credential reference, revision/pin, overlay, and staleness are progressively disclosed.
- Invalid source edits show arbord diagnostics while the last valid mount remains active.
- A user may still author normal links on `_index.md`; those are ordinary workspace pages, not control records.

`system:connections` gets the same treatment. A user may paste a Postgres DSN into a connection sheet; TreeHopper sends it to arbord for Keychain storage and thereafter shows only safe fields (driver, host, database, user, status, and credential label). Raw system source never contains the secret.

These are intentional native views over canonical readable records, not private settings screens or magic Markdown inside the publishable home page.

### 3. Arbord writes under open pages

Phase B exercises mutations and overlay routing before network sync adds another source of rewrites. The presenter wakes, reconcile classifies and splices, and the journal backstops a bad outcome.

Entry spike: verify `PatchEngine.reconcile`'s `mdMtime` gate under arbord-written mtimes; if necessary, gate destructive reconciliation on arbord's provenance/content hashes. Second spike: mutate 50 files and confirm watermark/coalescing paths keep the workspace responsive.

### 4. Overlay editing

Mounted trees remain ordinary writable files from TreeHopper's perspective. TreeHopper writes normally; arbord watcher attributes changes to an existing overlay or, under the default policy, creates an overlay on the first edit to a read-only tree. Arbord emits an event and TreeHopper shows a banner such as “Edits saved as your annotations.” An explicit “Annotate” action reaches the same transition before typing.

### 5. Search and provenance

Cmd+P adds arbord FTS body results in phase B and name/`TreeID`/invitation input in phase C. Per-page chips use TreeHopper's existing compact vocabulary for:

```text
local · mounted rw · mounted ro · overlay · visited · pinned · stale · conflicted
```

Arbord is the source of truth for these labels; TreeHopper does not infer them from paths.

### 6. Island blocks

A paragraph containing only a link to a `.tsx` script renders its component as an island: a locked-down WKWebView hosting `/render/{path}`.

- The native editor remains native; islands are leaf blocks like images.
- Collections and their table/board/gallery/calendar views stay out of the editor's document model.
- The UI build contains typed query/mutation handles; their implementations run in arbord workers and are reached through localhost message handlers.
- The consent panel comes from the compiler manifest's resolved handle graph and mounts.
- General navigation/networking is disabled inside the WKWebView; arbord origin and explicit message handlers are the only bridges.

Spike N WKWebViews in the LazyVStack plus first-responder arbitration. Fallback: instantiate only when an island approaches the viewport.

### 7. Database-backed collections

A link to a SQLite-backed collection or Postgres collection reference renders as a collection browser: child tables first, then schema-derived rows. Each table uses the same collection views as a file-backed collection. Editing a row invokes an arbord mutation/driver transaction rather than teaching TreeHopper SQL or storing table state in the editor document.

- SQLite remains an ordinary file for Finder, backup, and external tools.
- TreeHopper shows database snapshot/conflict provenance supplied by arbord.
- A missing Postgres credential renders a “Connect on this device” prompt tied to `system:connections`, not a broken content page.
- Large tables use paged arbord queries; TreeHopper never materializes them into Markdown blocks.

## Phase-C sharing UI

### Share a folder

“Share this folder…” calls arbord to:

1. give the selected folder a shared-tree identity, history, and permission boundary;
2. move its backing data into that shared tree;
3. leave a mount at the same workspace path;
4. issue a scoped grant and invitation.

The folder does not visibly move. TreeHopper shows the operation as folder sharing, not namespace administration. The confirmation makes the new independent history and selected rights legible when that information matters.

### Accept an invitation

Opening an Arbor invitation shows the shared tree's identity, endpoint hints, granted/local access, and a workspace-path picker. Acceptance stores an opaque credential reference and mounts the tree at that path. The recipient may mount an rw grant read-only.

### Collaboration states

Remote writes arrive through the same file-presenter path exercised in phase B. CAS conflicts appear as arbord diagnostics and files that TreeHopper can open. Share revocation, offline/stale state, pinning, and overlay divergence reuse chip/banner patterns rather than new navigation objects.

## iOS

The Bun arbord does not initially run on iOS. The v1 bridge remains the Mac as home relay: it synchronizes and materializes the workspace; iCloud carries those real files to TreeHopper on iOS; per-device journals preserve durability.

iOS can read and edit already materialized rw shared trees. Without a reachable arbord it cannot accept new invitations, browse new public trees, run live islands, or push directly. Tailscale/local access to the Mac arbord is the incremental improvement; a Swift sync-core port remains a phase-D/evolution option.

## Complete TreeHopper change surface

- one resolver branch;
- human-readable `system:mounts` rows, editor/source views, and system-operation calls;
- `system:connections` safe connection/credential UI;
- Cmd+P arbord FTS, then name/`TreeID`/invitation input;
- provenance/share chips and a small set of banners;
- explicit read-only/annotate transition;
- island block rendering and consent chrome;
- built-in SQLite/Postgres table browsing and database-conflict states;
- share-folder and accept-invitation sheets;
- arbord sidecar coordination.

The editor, save chain, journals, navigation model, typography, and recovery philosophy remain TreeHopper's.
