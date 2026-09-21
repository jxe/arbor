# Web 025: Canopy for the web: one browser editor for `arbor open` and canopyd

> **Executor instructions**: Build Canopy for the web as one browser bundle that is the TypeScript twin of the native app: the same working tree, update machine and document admission machine as the Mac app, the same information architecture and vocabulary, served by two hosts. The **local host** is Arbor Sync on loopback, opened by `arbor open`. The **canopyd host** is a host serving the bundle at a tree's canonical URL for a browser that holds a paired device credential. Nobody edits through the daemon; the browser publishes to canopyd itself. Port surfaces, not chrome: no menu bar, sheets, gestures, audio or camera. Clean breaks over shims. Nothing live (Railway, `~/.arbor`, the iPhone) flips without Joe's go-ahead.
>
> **Companion**: [surfaces.md](surfaces.md) is the surface-by-surface inventory this plan builds from; every surface there names its phase here.
>
> **Drift check**: `git diff --stat HEAD -- packages/client packages/object-store packages/protocol packages/render packages/editor packages/arborsync packages/canopy swift/ArborApp swift/Packages/CanopyEditor conformance docs/implementing-editors/design.md docs/implementing-sync-services/arborsync-api.md` against the commit this plan is written at.

## Status

- **Priority**: P1 — restores the web editor and makes canopyd trees editable from any browser
- **Effort**: XL, split into three projects with a soak between each
- **Risk**: MEDIUM (B1), MEDIUM (B2: new canopyd surface and browser credential), LOW (B3)
- **Depends on**: historical Native 022 (implemented and live); Native 022 soak closeout in [release and soak](../verification/release-and-soak.md)
- **Supersedes**: Web 023 (completed plan, deleted; see git history) (its library and endpoint-removal steps are folded into B1 and B2 below), Web 008 (completed plan, deleted; see git history) (its parity targets are restated per surface in [surfaces.md](surfaces.md)), and the shell items of Web 005 (completed plan, deleted; see git history) (its remaining editor-depth items become the B3 backlog at the end of this plan). Moved to `_done/web/` on 2026-09-19.
- **Written at**: 2026-09-19, native reference `swift/ArborApp` and `swift/Packages/CanopyEditor` at HEAD

## Why this matters

Native 022 deleted the daemon's editor path, so `arbor open` serves a placeholder. The Mac and iPhone apps are now direct canopyd working-tree clients, and the native UI has settled into a coherent set of surfaces (sidebar as a page picker with three orders, breadcrumb heading, attention banner, Share, Accounts, Sync Status, choice review). The web should be the third client of the same machines and the same surfaces, so that a browser on any machine, including one with no daemon, can edit a tree Joe has access to.

## Design

### One bundle, two hosts

`packages/canopy-web` (`@overstory/canopy-web`) builds one Vite bundle. Everything host-specific sits behind one interface:

```ts
interface WebHost {
  kind: "local" | "canopy";
  /** Trees this host can open: placements (local) or the account's trees (canopy). */
  trees(): Promise<HostTree[]>;
  /** Accepted-root bootstrap for one tree: spine, accepted {root, update, cursor}, modifiedAtByPath. */
  bootstrap(tree: TreeID): Promise<Bootstrap>;
  /** Content-addressed bytes, hash-verified by the caller. */
  objects: ObjectStore;
  /** Bearer credential provider for the tree's canopyd, or null for read-only. */
  credential(configurationTree: TreeID): Promise<string | null>;
  /** Account, device, pairing and share reads/mutations. */
  accounts: AccountService;
  /** URL <-> tree location mapping for this host's route shape. */
  locations: LocationCodec;
}
```

| Concern | Local host (`arbor open`) | canopyd host |
|---|---|---|
| Serves the bundle | Arbor Sync `browser-http.ts` at `127.0.0.1:<port>`, which already serves the placeholder and built assets | One static directory mounted at `/.arbor/web/*` (immutable, hashed assets) |
| App URLs | OS-shaped paths as today (`/Users/joe/notes/foo`) | The tree's canonical URLs (`/~joe/notes/foo`); see *Mounting on canonical URLs* |
| Trees | `GET /v1/trees` (exists) plus recent visits kept in the browser | `GET /.arbor/trees` (exists) for the paired account |
| Bootstrap | `GET /v1/bootstrap?tree=` (exists) | Built in the browser: the tree's ref route gives the accepted root, and `CanopyObjectStore` walks directory objects and `.md` entries from it through the existing object route. Same `Bootstrap` shape as the daemon's, produced client-side; no modification dates |
| Objects | `GET /v1/objects/{hash}` (daemon cache, canopyd fetch-through) | existing canopyd object route |
| Credential | `GET /v1/credential` (daemon's device credential) | browser device credential from pairing, stored in IndexedDB for that origin |
| Publish/watch | directly to canopyd from the browser (needs CORS on Overstory routes) | same origin |
| Accounts, devices, share, app permissions | The same on both hosts: the browser opens the account configuration tree as an ordinary working tree (bootstrap by its TreeID) and edits `devices.yaml`, `trees.yaml` and the resource-policy rules exactly as `ArborAppModel` does; pairing offers and claims go to canopyd's existing pairing routes with the bearer. `GET /v1/accounts` (exists) only lists which configuration trees the local host knows. The Web 008 idea of an account-scoped daemon REST boundary is dropped | |
| Daemon diagnostics | none; `arbor daemon status` stays a CLI surface | none |

Invariant, enforced by types: the app model imports only `WebHost`; `LocalHost` and `CanopyHost` are the only modules that know a route. A surface that needs something one host cannot provide gets an `undefined` capability and hides itself; it never branches on `host.kind` for behaviour.

### The add-on rule: no new routes

Canopy for the web is an add-on to two servers that keep their shape. Arbor Sync gains **no routes**: the five it already serves for the Mac app (`/v1/trees`, `/v1/bootstrap`, `/v1/objects`, `/v1/credential`, `/v1/accounts`) plus `POST /v1/bootstrap/accounts` are the whole local host, and its browser handler goes from serving a placeholder to serving the bundle. canopyd gains **no Overstory or account routes**: it adds CORS headers on the routes it already has (so a loopback origin can publish and watch with its bearer) and one static mount for the bundle and the loader. Everything the Mac app does through the working tree, the browser does through the working tree: device administration, deauthorization, share access, and app permissions are edits to the account configuration tree, published like any other update and enforced by canopyd's existing account-configuration merge rules (last administrator, self-revocation), not by new server endpoints. If a surface appears to need a route, the answer is a working-tree edit or a client-side computation; if neither works, stop and report.

The only things dropped by this rule are the Mac-only **Reconnect to arborsync** and **View arborsync Logs…** actions, which stay in the native Sync Status and the CLI.

### The twin model

Mirror the Swift split so the two clients stay legible side by side:

| Swift | TypeScript | Owns |
|---|---|---|
| `CanopyWorkingTree`, `OverstoryObjectStore` | `@overstory/working-tree`, `@overstory/object-store` (browser-safe core; node stores under `./node`) | state, writes, `UpdateMachine`, `UpdateCoordinator`, `ObjectOverlay`, `LayeredObjectStore`, `DaemonObjectStore`, `CanopyObjectStore` |
| `ArborWorkspaceState` | `WorkspaceState` | launch phase, opened tree, trees list, accounts, sharing, credential, the coordinator |
| `ArborAppModel` | `AppModel` | location, history, sidebar order and search, full-text search, backlinks, editor leases, title-rename proposals, trash prompts, History |
| `ArborEditorHost` | `EditorHost` | document lookup/creation, mentions, assets, move/relocate, `persistCommit` into the admission machine |
| `ArborConflictReviewModel` | `ConflictReviewModel` | choices, drafts, preview, apply |

These are plain TypeScript classes over a small observable store; React components only render them. Every model has tests without React, and the two fixture-driven machines (`working-tree-updates`, `document-admission`) run unchanged from `docs/overstory-spec/conformance/client-state-machines.json`.

### Editor engine

Keep BlockNote as the interactive layer and `@overstory/protocol` as the source-preserving Markdown adapter; both exist and already carry document-link rows, toggles, math, footnotes and raw-Markdown carrier blocks. Add the Quagmire behaviours as BlockNote extensions in the order [surfaces.md §4](surfaces.md#4-editor-pane) lists. Do not port Quagmire itself: a second bespoke engine would double the editor surface Joe maintains. Revisit only if block navigation mode proves impossible on ProseMirror; it does not.

### Browser credential on the canopyd host

A browser pairs like any other device: Accounts on the Mac shows the pairing QR and confirmation code; the browser's Accounts surface has **Pair this browser** where the code is pasted (no camera). The claim uses the existing `PUT /.arbor/pairings/{id}/claim` with a browser-generated `DeviceID` and label such as `Safari on Joe's MacBook`, and the credential lives in IndexedDB keyed by canopyd origin. It appears in Devices with the same **Deauthorize Device** action and revocation semantics as an iPhone. No new server concept, no cookie session, no raw secret in a URL. Access-link recipients remain [Security 004](../security/004-access-link-secrets.md); this plan does not give them editing.

### Mounting on canonical URLs

Spec 07 requires links to remain correct as ordinary HTTP navigation. So on the canopyd host the public HTML page stays the HTTP response for a canonical URL; it gains one `<script type="module" src="/.arbor/web/loader.js">`. The loader checks IndexedDB for a credential for this origin (or `?arbor-web` on the URL, which is how an unpaired browser reaches the pairing surface) and, when present, mounts the app over the public page at the same URL. Back, forward, reload and copy-URL are browser semantics; the app pushes canonical URLs only. Without a credential and without `?arbor-web` the response is byte-identical to today's public page.

### Storage and tabs

One writable working tree per tree per browser profile through `navigator.locks` (B1); other tabs on the same tree open read-only with a visible **Read-only: open for editing in another tab** state. If the soak shows Joe editing one tree in several tabs, B2 moves the working tree and coordinator into a `SharedWorker` so every tab is a view of one machine; the model boundary above is what makes that a transport change rather than a rewrite. Durable state (attempt, head, overlay, recovery copies, network log) is IndexedDB through `WorkingTreeStateStore`; `beforeunload` waits on the admission machine's flush the way `applicationShouldTerminate` does natively.

### Keyboard

The native shortcut map ports except where the browser owns the key. Reassignments are fixed in [surfaces.md §9](surfaces.md#9-keyboard-map) and documented in `docs/implementing-editors/design.md` under the phase that implements each surface.

## Projects and phases

Each project ends with the listed gates, a `status.md` entry and a soak on Joe's Mac before the next starts.

### B1 — the local editor returns (`arbor open`)

**Phase 0 — bookkeeping.** This file and [surfaces.md](surfaces.md). The package is `packages/canopy-web` (`@overstory/canopy-web`); `build:web` still fails because the bundle imports `@overstory/arborsync-client/api`, which does not exist, and fixing it is part of Phase 1.

**Phase 1 — libraries.** `@overstory/object-store`: split the browser-safe interface (`ObjectStore { bytes(hash) }`, `ObjectOverlay`, `LayeredObjectStore`, `MemoryOverlay.retain(roots)`) from the node filesystem store, which moves under `./node`; add `DaemonObjectStore` over `/v1/objects` and `CanopyObjectStore` over the protocol object route, both hash-verifying. `@overstory/working-tree`: state `{ tree, root, accepted?, generation, pending?, index: byPath, byPageID }` built from a bootstrap spine; content-addressed writes rewriting the spine to a new root; `WireProjection` for node semantics; `WorkingTreeStateStore` with memory and IndexedDB implementations; `UpdateMachine` moved from `@overstory/client` (re-exported for the daemon) and `UpdateCoordinator` mirroring Swift (`syncImmediately`, `syncOnce`, `observe`, `recoverWatchGap`); `CanopyWatchRunner` over `WireClient.watch`; `WireClient` takes a token provider and `onUnauthorized`. Node-bound parts of `@overstory/client` move behind `./node`. A client text index for page search, full-text search and backlinks, rendering excerpts as marked ranges, never HTML ([Security 001](../security/001-search-excerpts.md) lands here).
*Verify*: both `@overstory/working-tree` and `CanopyWorkingTree` pass `docs/overstory-spec/conformance/client-state-machines.json`; a write's root equals `snapshotDirectory` of the same files; envelopes ⊆ overlay; IndexedDB store contract tests in a browser.

**Phase 2 — local host and app model.** `LocalHost` over `/v1/trees`, `/v1/bootstrap`, `/v1/objects`, `/v1/credential`, `/v1/accounts`. `WorkspaceState`, `AppModel`, `EditorHost` with tests. canopyd adds CORS on its existing routes (`Access-Control-Allow-Origin: *`, `Authorization` and `Arbor-Access-Link` allowed, preflight cached; the bearer is the authority, so no credentials mode) so a loopback origin can publish and watch directly; the daemon proxies nothing and gains no routes. The endpoint removals from Web 023 execute here, unchanged in substance: delete `POST /v1/me`, `POST /v1/local/forget`, `GET /v1/resolve` and filesystem-path byte serving (`?raw`, `/render` aliases, Referer scoping) together with their callers; keep `POST /v1/bootstrap/accounts`, explicit built-asset routes and app-shell navigation; assets resolve through the working tree and object store. `arbor open` drops its notice.
*Verify*: `bun test tests/unit/local-handlers.test.ts tests/integration/server.test.ts`, `bun run test:protocol`, direct-resolver regressions for symlinks, nested boundaries and account-qualified locators; a filesystem path or `?raw` never returns placed-file bytes; the three removed routes answer `405 unsupported-operation`.

**Phase 3 — shell.** Surfaces [1, 2, 3, 5, 10, 11 in surfaces.md](surfaces.md): launch and empty states, sidebar as the page picker (heading, three orders with their groups, rows with emoji icon and context path, context menu), breadcrumb heading, back/forward/parent/home, Open Location, Search Contents, attention banner, Home, the keyboard map, narrow-layout drawer.
*Verify*: component tests for the page picker and grouping; Playwright at desktop and 390 px: empty search lists pages with 0/1/N inbound counts, nested results show title, emoji and parent path, heading parent navigation and drawer focus work by keyboard, no visible UI says "workspace".

**Phase 4 — editor pane, minimum.** Surface [4](surfaces.md#4-editor-pane) items marked B1: BlockNote document bound to the admission machine through `EditorHost.persistCommit`, document footer (backlinks, sync chip), block menu with Turn Into tiles, @mention, autotransforms, inline marks, images to `Assets`, undo, find in page, New Document/Folder, Trash/Restore with confirmations, title-rename proposal, orphan-trash prompt, Source and Properties, History/Recover. Source admission uses the existing TypeScript source-admission session: real transactions capture original source and basis; do not infer move/copy from final text; support only operation forms the browser captures and the server executes.
*Verify*: `bun run build`, `bun run test:e2e` restored with disposable canopyd: edit in the browser and see the folder update within a second; edit on disk and see the page update; close the tab mid-edit and reopen to see the browser's own head replay once; leave a daemon request pending or conflicted and the browser still publishes; a second tab opens read-only.

**Phase 5 — docs and release.** `docs/implementing-editors/design.md` (the browser is a working-tree client; BlockNote sentence updated; shortcut table), `docs/implementing-sync-services/arborsync-api.md` (§3b unchanged, removed routes, §6 static hosting), `docs/architecture/README.md`, `status.md`. Install on Joe's Mac; two-week soak recorded in [release and soak](../verification/release-and-soak.md).

### B2 — the canopyd host and the account surfaces

**Phase 6 — canopyd host.** canopyd mounts one static directory at `/.arbor/web/*` from a build stage in `packages/canopyd/deploy/Dockerfile.canopyd` (`bun run build:web`; hashed immutable assets; CSP and the other headers from [Security 003](../security/003-canopy-host-responses.md) on the bundle and the loader). The loader script tag on public pages. `CanopyHost` builds its bootstrap client-side from the existing ref and object routes and uses `/.arbor/trees`, `/.arbor/account`, the pairing, object, update and watch routes as they are. Browser device pairing (paste code) and credential storage; **Deauthorize** from any device clears the browser's editing state on its next request. `arbor open <canopy-url>` opens the URL directly and no longer requires a daemon; it appends `?arbor-web` so an unpaired browser lands on the pairing surface.
*Verify*: `bun test tests/integration/canopy`, a Playwright run against disposable canopyd that pairs a browser, edits a page, sees it on a second client, is deauthorized and becomes read-only; a public page without a credential is byte-identical to today's; `bun run test:protocol`. Deploying to Railway is a separate step needing Joe's go-ahead, with a fresh backup under `.backups/railway/`.

**Phase 7 — accounts, devices, share, sync status, app permissions, network log.** Surfaces [6, 7, 8, 12](surfaces.md) on both hosts. One **Accounts / Sync Status** dialog with a persistent tab selector and a dialog-level cache. Devices with **This browser / Active / Administrator** tags, the ellipsis actions as `devices.yaml` edits through the configuration tree's working tree on both hosts, with the last-administrator rule enforced by canopyd's existing account-configuration merge; pairing shows the QR and code so a phone or another browser can join. Share with the tracked-tree hierarchy (heading with canonical address, invite row, **Who has access** with **Can view / Can edit / Remove access**, scoped and app permissions). Sync Status with the twelve user-facing states, current-document detail, **Sync Now** and **Network Log…**. Network log as a filterable list over the browser's own `WireNetworkLog` in IndexedDB with **Copy**, **Clear**.
*Verify*: server tests for non-admin, stale-write, last-admin and deauthorization failures; dialog opens immediately at the requested tab and never flashes a first-load spinner on tab change; Share is content-sized, closes on Escape and restores focus; Sync Status orders save failure, conflict, offline, pending, syncing, healthy correctly.

**Phase 8 — docs and release.** Spec: none required (pairing already admits ordinary devices; no new routes). `docs/architecture/README.md` gains the static mount, CORS and the loader. `docs/implementing-editors/design.md` profile/pairing and share sections gain the browser rows. Railway deploy with go-ahead; soak.

### B3 — choice review and editor depth

**Phase 9 — conflict review.** Surface [13](surfaces.md#13-conflict-and-choice-review): `ConflictReviewModel` over the coordinator's inspection routes; choices entry and list in the sidebar; the review panel anchored above the document (no accessory API in BlockNote; a document-anchored panel is enough) with previous/next choice, alternatives, remove toggle, composed source, destination, preview, apply, discard, retained-draft states; per-document conflict view with **Current / Mine / Both / Edit**; the line comparison. Track [Native 010](../swift/010-client-conflict-review.md) for finer source mapping; do not fork policy.
*Verify*: the live review scenarios from `docs/native-conflict-review.md` reproduced against disposable canopyd in Playwright.

**Phase 10 — editor depth (the former Web 005 backlog, re-ranked).** Block navigation mode with contiguous selection; keyboard structural editing (Tab/Shift-Tab, ⌥↑/↓, ⌘↩, ⇧⌘P Move to sheet, Move Page sheet); heading folding with fold/unfold all; `:emoji` completion and document icon; Markdown-aware copy/paste; link previews; unsupported-block carrier display; drag handles with drop onto link rows and sidebar rows; multi-tab `SharedWorker` if the B1 soak asked for it. Each item is independently selectable after Phase 9.

## Verification (every project)

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run build:web
bun run test:e2e
swift test --package-path swift/Packages/CanopyWorkingTree
git diff --check
```

## Done criteria

- `arbor open` on the Mac serves the editor from Arbor Sync; the browser opens the accepted-root bootstrap, edits through its own `UpdateCoordinator` against canopyd, never imports daemon client state and never calls a daemon editor route.
- A browser with no daemon opens a tree's canonical URL on canopyd, pairs once, and edits with the same surfaces; deauthorizing it from the Mac ends that.
- `@overstory/working-tree` and `CanopyWorkingTree` pass the same fixture; `WorkspaceState`/`AppModel` have React-free tests.
- Every surface in [surfaces.md](surfaces.md) marked B1/B2/B3 is implemented with the listed labels, states and actions, and every item marked *not ported* is absent by decision, not omission.
- `POST /v1/me`, `POST /v1/local/forget`, `GET /v1/resolve` and filesystem-path byte serving are gone with their callers; `POST /v1/bootstrap/accounts` remains.
- Docs and `status.md` describe the browser as the third working-tree client; the superseded plans are deleted (git history) and this plan carries their pointers.

## Boundaries and stop conditions

- No new Arbor Sync routes and no new canopyd Overstory or account routes; no daemon proxy to canopyd, no second file-reading API, no cookie session for editing, no raw secret in a URL.
- No new Overstory operations; if a surface needs one, stop and write the protocol change as its own plan.
- Do not port Quagmire's engine, the menu bar, sheets as a concept, gestures, audio, camera, App Intents, Keychain or Finder integration.
- If CORS for direct browser publication turns out to need credentials mode (it should not: the bearer is the authority), stop and report rather than widening origins.
- Live deploys and `~/.arbor` changes wait for Joe.
