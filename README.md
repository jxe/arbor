---
id: jrigzm
---
# Arbor

A successor to the web built around three concepts: **a workspace**, the tree a person or agent sees and works in; **a shared tree**, a folder with independent identity, history, synchronization, and permissions; and **a script**, a `.tsx` file that reads, renders, or changes the workspace through components and typed operations.

## Current implementation

The current implementation is a Bun workspace. `arbor browse <locator>` opens the filesystem-wide TreeHopper React/BlockNote browser. Local paths browse ordinary files; HTTP and Arbor URLs open remote locations. An unclaimed profile URL appears as an empty, reserved profile with a Claim action. Ordinary files remain local until they are shared beneath an active community profile. One host can serve many accounts in a mounted namespace: `/` is the community profile, `/~joe` and `/~editors` are complete person/group profile trees, and longer exact boundaries such as `/~editors/handbook` resolve by longest prefix. Sharing promotes a subtree in place into its own `TreeID`, sync, history, and access boundary without changing its URL. TreeHopper uses the REST v1 TypeScript client in `packages/client`; the matching Foundation-only Swift 6 client lives in `native/Packages/ArborClient`. Start from this checkout with:

```sh
bun install
bun run build:web
bun run dev -- /path/to/workspace
```

The tree path may be absolute, relative to the current directory, or shell-expanded with `~`; omit it to browse the current directory. `bun install` creates the repo-local `arbor` executable, which Bun exposes as `bun run arbor`; it does not put a bare `arbor` command on the surrounding shell's global path. `bun link` remains an optional convenience if you want that global command.

To create a group after joining a community, make an ordinary folder with an `_index.md` such as:

```md
---
type: group
members:
  - arbor://garden.example/~joe
---

# Editors
```

Then sync the folder to an available group handle, with the audience options before the locators:

```sh
arbor sync -r public ~/groups/editors arbor://garden.example/~editors
```

The folder stays where it is. Its new `TreeID` becomes the stable group identity, its members remain ordinary authored locators, and membership alone does not grant write access to the group tree.

Launch a new local community without preparing credentials or environment variables:

```sh
bun run host -- ./garden --community garden --first-writer joe
```

Arbor creates the `garden` community, reserves `/~joe`, and prints that complete profile address. Its initial display name is the handle and Joe can edit the community profile later. Run `arbor browse <that-address>`: TreeHopper shows the empty reserved profile, and its Claim action asks only where the profile should live locally. The folder may be new and `~` is expanded. The first successful claim activates that device and becomes the initial community writer. Running the same command again restarts the existing authority without another bootstrap. `--url` sets an explicit public origin for unusual HTTP or nonstandard-port deployments; standard HTTPS hosting uses `ARBOR_DOMAIN`. `--hostname` and `--port` separately control the listener, while Railway's generated public domain and port are detected automatically. Environment-based account bootstrap remains available for legacy migration. See [Remote trial deployment](deploy/README.md) for Railway and VPS instructions.

Arbor keeps its local state in `~/.arbor`. The human-editable [`trees.yaml`](spec/system.md) registry records local placements, while canonical boundaries are authority records independent of those placements. `system:community` stores only safe account/community metadata and an operating-system credential reference; raw account and link credentials never enter content, journals, receipts, events, diagnostics, errors, or logs. One local Arbor data home has one active personal identity. Private per-tree indexes, journals, and recovery state remain under `~/.arbor/workspaces/`. `ARBOR_DATA_HOME` selects an isolated alternate root.

Markdown uses CommonMark/GFM plus the readable Clamshell toggle extension (`▸ Title` with two-space-indented children). CSV and JSONL use the fixed `_store.csv` and `_store.jsonl` names. Configure Postgres references without a plaintext DSN using `arbor connection set <name>`.

Markdown page names are logical and extensionless in Arbor. `x.md` supplies `/x`'s body and a sibling `x/` supplies its children, so a page can gain children without moving or rewriting its body. If `x.md` is absent, `x/_index.md` is the fallback directory body. Both body files at once are a blocking duplicate-body diagnostic. Thus this repository's `spec.md` is the body of `/spec`, while `spec/` contains its children.

## Testing

Install the browser binary once, then run every automated gate:

```sh
bun install
bunx playwright install chromium
bun run typecheck
bun test
bun run test:protocol
bun run build
bun run test:e2e
bun run test:performance
swift test --package-path native/Packages/ArborClient
```

`bun run test:protocol` is the cross-language conformance gate: it checks the shared JSON/SSE fixtures, starts a temporary live arbord, and runs the Swift tests against it. Running `swift test` directly checks the standalone package and fixture decoding; its live-server case is skipped when `ARBOR_TEST_URL` is absent.

For hands-on testing without modifying the checked-in fixture, copy it to a scratch tree and start Arbor:

```sh
test_root="$(mktemp -d)"
cp -R tests/fixtures/workspace/. "$test_root/"
bun run arbor browse "$test_root" --port 4317 --no-open
```

Open `http://127.0.0.1:4317`. Check that the sidebar shows `notes` without `.md`; while reading it, the sidebar should still list its containing directory. Toggle it with the header control and Cmd-\, then verify a narrow window uses the overlay drawer. Its inline link and authored `Book subpage` row should both navigate to `books/one`, and an auto-generated directory-child row on the root page should open its child. Entering `/render/notes.md` should immediately canonicalize to `/render/notes`. Expand and collapse its toggle without producing an authored change, then type `▸ ` in an empty paragraph and confirm BlockNote converts it in one undo step. Open the Properties disclosure, edit a property and body block, and verify the contextual status progresses from pending/saving to the visually quiet saved state without remounting or losing the current editor position; inspect the copied Markdown for a six-character `id` plus a minimal source diff. Make a clean external file edit and confirm the open BlockNote instance reconciles it without adding an authored undo step. On a directory page, drag one child row by BlockNote's native handle between prose blocks and verify only that row moves, with the normal BlockNote drop target visible; a stale or removed insertion target should fail rather than append the row elsewhere. Check Undo, Redo, and Recover in the page menu and filesystem actions in the directory/sidebar menus. Open `books` to edit its Markdown-backed row. CSV/JSONL/Postgres collection cells should remain read-only.

For inline editing, open a page containing `__strong__`, `_emphasis_`, `~~strike~~`, inline code, links, and hard breaks. Confirm they render as rich inline content; a property-only save leaves their original delimiters byte-identical; editing one block normalizes only that block. Type the standard emphasis/code delimiters, paste Markdown as both explicit Markdown and plain text, and copy a formatted selection into a plain-text destination. The toolbar should offer bold, italic, strike, code, and links, but not underline, colors, or alignment.

For objective visual checks without adding browser tests, evaluate [`tools/browser/editor-audit.js`](tools/browser/editor-audit.js) in the built-in browser as `(${source})()` to return a font, width, spacing, indentation, theme, overflow, and chrome report. In a writable page context it also installs `window.__arborEditorAudit` with `report()`, `overlay()`, `setTheme("light" | "dark" | "restore")`, and `cleanup()` methods; the built-in browser's read-only evaluation sandbox returns the report without retaining those mutating helpers.

To exercise live Postgres catalog reads against an already-running server, provide a DSN for a role allowed to create a schema:

```sh
ARBOR_TEST_POSTGRES_DSN='postgresql://user:password@127.0.0.1:5432/postgres' \
  bun test tests/integration/postgres.test.ts
```

The test creates and drops a uniquely named `arbor_test_*` schema; it does not touch existing schemas or persist the supplied DSN.

# Workspaces

A workspace may contain local folders, SQLite databases, connected stores, and shared trees mounted wherever their reader wants them. Sharing a folder gives it an independent sync boundary without moving it in the visible workspace. The wire synchronizes shared trees as small live refs plus immutable objects.

Working documents:

- **[intro.md](intro.md)** — narrative introduction and pitch: from the agent-playground problems (sharing/syncing, human interface, containment) to a universal dynamic material that supersedes the web.
- **[spec.md](spec.md)** — spec overview, v0.7, with the complete intended reference system split into topic files under [spec/](spec/): on-disk format, Arbor locators, the `system:` tree/placements/durability, arbord REST and its TypeScript/Swift clients, scripts, the browser, shared trees and the wire, and the CLI.
- **[plan.md](plan.md)** — the forward roadmap: canonical hosting, community profiles/groups/sharing, workspace composition, scripts, agents, data, fuller publication, and non-blocking polish.
- **[plan-history.md](plan-history.md)** — implemented browser/editor, REST/client, daily-driver, and tracked-root milestones with verification evidence.
- **[plan-native.md](plan-native.md)** — the separate Swift/Hunch integration plan: adapting the Swift protocol client into provider/page-session boundaries, arbord-mediated macOS, direct Clamshell on iOS, migration, sidecars, and native product surfaces.
- **[social-networking.md](social-networking.md)** — a thought experiment: with Arbor ubiquitous and the wire lowered to the transport layer, what remains of atproto, and how relays, AppViews, feeds, and labelers collapse into trees, watches, and queries.

Placeholder names throughout: **Arbor** (system), **workspace** (the visible local tree), **shared tree** (independent sync root), **arbord** (the daemon: local workspace/runtime), **wire** (shared-tree protocol), and **TreeHopper** (the browser — web and native). All remain provisional.

Earlier drafts that centered “spaces” and “composition,” along with global DNS-rooted trees, `_mounts.toml`, `_delegate`, general export-graph slicing, and static-origin work in the reference-server phase, are superseded by these documents.
