# Arbor

A successor to the web built around three concepts: **a workspace**, the tree a person or agent sees and works in; **a shared tree**, a folder with independent identity, history, synchronization, and permissions; and **a script**, a `.tsx` file that reads, renders, or changes the workspace through components and typed operations.

## Current implementation

Phases 1–2 are implemented as a Bun workspace: `arbor dev <path>` indexes and watches a local tree, serves the TreeHopper React/BlockNote browser, renders CSV/JSONL/Markdown/Postgres collections, and journal-writes Markdown edits back to canonical files. Start from this checkout with:

```sh
bun install
bun run build:web
bun link
arbor dev /path/to/workspace
```

The tree path may be absolute, relative to the current directory, or shell-expanded with `~`; omit it to browse the current directory. From this checkout, `bun run dev -- <path>` is equivalent and does not require linking the command.

Markdown uses CommonMark/GFM plus the readable Clamshell toggle extension (`▸ Title` with two-space-indented children). CSV and JSONL use the fixed `_store.csv` and `_store.jsonl` names. Configure Postgres references without a plaintext DSN using `arbor connection set <name>`.

Markdown page names are logical and extensionless in Arbor. A leaf stored as `x.md` and the same page after it gains children, stored as `x/_index.md`, both open at `/render/x` and appear as `x` in navigation, search, links, and API results. They must not coexist; Arbor operations preserve that invariant and report externally-created duplicates instead of guessing which body wins.

## Testing

Install the browser binary once, then run every automated gate:

```sh
bun install
bunx playwright install chromium
bun run typecheck
bun test
bun run build
bun run test:e2e
bun run test:performance
```

For hands-on testing without modifying the checked-in fixture, copy it to a scratch tree and start Arbor:

```sh
test_root="$(mktemp -d)"
cp -R tests/fixtures/workspace/. "$test_root/"
bun packages/cli/src/index.ts dev "$test_root" --port 4317 --no-open
```

Open `http://127.0.0.1:4317`. Check that the sidebar shows `notes` without `.md`; while reading it, the sidebar should still list its containing directory. Its inline link and authored `Book subpage` row should both navigate to `books/one`, and an auto-generated directory-child row on the root page should open its child. Entering `/render/notes.md` should immediately canonicalize to `/render/notes`. Expand and collapse its toggle and verify Save remains disabled. Edit a property and body block, save, and inspect the copied Markdown for a six-character `id` plus a minimal source diff. Open `books` to edit its Markdown-backed row. CSV/JSONL/Postgres collection cells should remain read-only.

To exercise live Postgres catalog reads against an already-running server, provide a DSN for a role allowed to create a schema:

```sh
ARBOR_TEST_POSTGRES_DSN='postgresql://user:password@127.0.0.1:5432/postgres' \
  bun test tests/integration/postgres.test.ts
```

The test creates and drops a uniquely named `arbor_test_*` schema; it does not touch existing schemas or persist the supplied DSN.

A workspace may contain local folders, SQLite databases, connected stores, and shared trees mounted wherever their reader wants them. Sharing a folder gives it an independent sync boundary without moving it in the visible workspace. The wire synchronizes shared trees as small live refs plus immutable objects.

Working documents:

- **[intro.md](intro.md)** — narrative introduction and pitch: from the agent-playground problems (sharing/syncing, human interface, containment) to a universal dynamic material that supersedes the web.
- **[spec.md](spec.md)** — spec overview, v0.6, with the architecture split into topic files under [spec/](spec/): on-disk format, names and URLs, the `system:` tree/mounts/durability, script compilation/execution, the browser, shared trees and the wire, and the CLI.
- **[plan.md](plan.md)** — ten phases ordered so Arbor is a daily driver before it is a framework or a network: (1) browse a whole local subtree; (2) edit in the browser; (3) scripts; (4) agents with a chat interface; (5) arbord and mounts; (6) `arbor deploy`; (7) SQLite; (8) the wire and self-sync; (9) sharing, public names, and publication; (10) TreeHopper as a parallel track.
- **[treehopper-integration.md](treehopper-integration.md)** — the concrete browser/editor seams for friendly mount/connection editing, materialized files, database-backed collections, island scripts, provenance, and sharing.
- **[social-networking.md](social-networking.md)** — a thought experiment: with Arbor ubiquitous and the wire lowered to the transport layer, what remains of atproto, and how relays, AppViews, feeds, and labelers collapse into trees, watches, and queries.

Placeholder names throughout: **Arbor** (system), **workspace** (the visible local tree), **shared tree** (independent sync root), **arbord** (the daemon: local workspace/runtime), **wire** (shared-tree protocol), and **TreeHopper** (the browser — web and native). All remain provisional.

Earlier drafts that centered “spaces” and “composition,” along with global DNS-rooted trees, `_mounts.toml`, `_delegate`, general export-graph slicing, and static-origin work in the reference-server phase, are superseded by these documents.
