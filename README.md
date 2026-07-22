# Arbor

A successor to the web built around three concepts: **a workspace**, the tree a person or agent sees and works in; **a shared tree**, a folder with independent identity, history, synchronization, and permissions; and **a script**, a `.tsx` file that reads, renders, or changes the workspace through components and typed operations.

A workspace may contain local folders, SQLite databases, connected stores, and shared trees mounted wherever their reader wants them. Sharing a folder gives it an independent sync boundary without moving it in the visible workspace. The wire synchronizes shared trees as small live refs plus immutable objects.

Working documents:

- **[intro.md](intro.md)** — narrative introduction and pitch: from the agent-playground problems (sharing/syncing, human interface, containment) to a universal dynamic material that supersedes the web.
- **[spec.md](spec.md)** — spec overview, v0.5, with the architecture split into topic files under [spec/](spec/): on-disk format, names and URLs, the `system:` tree/mounts/durability, script compilation/execution, the browser, shared trees and the wire, and the CLI.
- **[plan.md](plan.md)** — ten phases ordered so Arbor is a daily driver before it is a framework or a network: (1) browse a whole local subtree; (2) edit in the browser; (3) scripts; (4) agents with a chat interface; (5) arbord and mounts; (6) `arbor deploy`; (7) SQLite; (8) the wire and self-sync; (9) sharing, public names, and publication; (10) TreeHopper as a parallel track.
- **[treehopper-integration.md](treehopper-integration.md)** — the concrete browser/editor seams for friendly mount/connection editing, materialized files, database-backed collections, island scripts, provenance, and sharing.
- **[social-networking.md](social-networking.md)** — a thought experiment: with Arbor ubiquitous and the wire lowered to the transport layer, what remains of atproto, and how relays, AppViews, feeds, and labelers collapse into trees, watches, and queries.

Placeholder names throughout: **Arbor** (system), **workspace** (the visible local tree), **shared tree** (independent sync root), **arbord** (the daemon: local workspace/runtime), **wire** (shared-tree protocol), and **TreeHopper** (the browser — web and native). All remain provisional.

Earlier drafts that centered “spaces” and “composition,” along with global DNS-rooted trees, `_mounts.toml`, `_delegate`, general export-graph slicing, and static-origin work in the reference-server phase, are superseded by these documents.
