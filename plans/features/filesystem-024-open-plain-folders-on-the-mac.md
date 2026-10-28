# Filesystem 024: Open plain folders on the Mac

**Timing:** Later.

**Why and when:** opening an ordinary folder in the Mac app, and making it into a tree from there, went away with the daemon's editor path; today a new tree needs `story place`. Joe wants this soon, before the web editor.

Historical identifier: **Native 024**, formerly "Disk editors for non-tree folders". On 2026-10-11 Joe cut the plan to the Mac. The earlier design also gave Story Sync `/v1/fs/*` routes for a browser folder editor; that half is an open question in [Web 025](../later/story-web-025-story-web.md#open-plain-folders-in-the-browser) and its design is in this file's git history.

> **Executor instructions**: Give the Mac app a plain disk editor for folders that are not placed Overstory trees. No update machine, no change log, no recovery: read, write with a revision check, list, watch. Keep it visibly separate from tree synchronization in code and docs. Refuse to open a path inside a placed tree; route it to the tree session instead. Story Sync gains no route.
>
> **Drift check**: `git diff --stat c134a85..HEAD -- swift/Packages/StoryKit swift/StoryApp docs/implementing-editors`. The plan dates from 2026-09-09, before Clients 001 and the 2026-10-11 Mac setup work; read `StoryRootView`, `StoryOnboarding` and `StorySharePresentation` as they are now before starting.

## Status

- **Effort**: M
- **Risk**: LOW
- **Depends on**: nothing
- **Category**: product completion

## Why this matters

Native 022 removed the daemon's `local` scope, so the Mac app cannot open an ordinary folder. Folders that are not trees need no synchronization; they need a dumb, reliable file editor with the same document surface.

It also stranded the Mac's only way to make a folder into a tree: the share panel's "Make This an Overstory Tree" (`StorySharePresentation.promotable`, `promoteLocalFolder`) appears only for a `local` workspace, which nothing opens now. Opening a plain folder brings it back, including onto a placement host's `~handle · host` destination (Security 007). Since 2026-10-11 the getting-started list after a join calls `promoteLocalFolder` for one chosen folder (`StoryOnboarding.swift`), so a new person gets a first tree without the command; after setup there is still no way to add another.

## Design

`swift/Packages/StoryKit/Sources/StoryKit/FilesystemWorkspaceProvider.swift` plus a document session, shaped on `InMemoryWorkspaceProvider`:

- resolve and children from `FileManager`, with the `_index.md` and sibling rules ported from `WorkingTreeSemantics`;
- bounded title and body search;
- plain moves, creates, and trash;
- `readFile`, and a guarded write that compares the byte revision ([sessions without a change log](../../docs/implementing-editors/editor-source.md#5-sessions-without-a-change-log));
- `updates()` from a file watcher.

The editor writes through the provider directly. `openLocalFolder(url)` with a persisted-URL store; Open Folder and Open Location in `StoryRootView`.

## Steps

1. `FilesystemWorkspaceProvider` with the provider contract cases from `ProviderContractTests` re-targeted, an external-edit observation test, and a test that a path inside a placed tree is refused and routed to its tree session.
2. Open Folder and Open Location; the share panel's "Make This an Overstory Tree" for the opened folder, onto the home host and onto a placement destination.
3. Docs: `docs/implementing-editors/design.md` (opening a folder that is not a tree; making it one), the pointer in `editor-source.md` §5, and `status.md`.
4. By hand, with Joe: open a plain folder, edit, see the file change on disk; edit the file outside the app and see the page update; open a path inside a placed tree and land in the tree session; make the folder a tree and see it sync.
5. **Close out.** Record the evidence in `status.md`, remove the "remaining gap" notes that point here ([Release 001](../../status.md#plans-closed-out--2026-10-20)), and delete this plan.

Gate: `bun run test:affected` and `swift/scripts/test-story-app.sh`.

## Done criteria

- The Mac app opens non-tree folders again with no synchronization machinery involved.
- A placed-tree path can never be opened through the folder editor.
- A folder becomes a tree from the Mac app without the `story` command.
