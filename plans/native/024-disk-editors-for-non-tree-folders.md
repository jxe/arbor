# Plan 024: Disk editors for non-tree folders

> **Executor instructions**: Give the Mac app and Arbor web a plain disk editor for folders that are not placed Arbor trees. No update machine, no admission fence, no journal, no recovery: read, write with an etag check, list, watch. Keep it visibly separate from tree synchronization in code and docs. Refuse to open a path inside a placed tree; route it to the tree session instead.
>
> **Drift check**: `git diff --stat c134a85..HEAD -- packages/arborsync packages/arborsync-client packages/render native/Packages/ArborKit native/ArborApp docs`

## Status

- **Priority**: P2 — restores non-tree browsing
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Native 022 (for the Mac editor); Native 023 (for the web editor)
- **Category**: product completion
- **Planned at**: Arbor `c134a85`, 2026-09-09

## Why this matters

Native 022 removed the daemon's `local` scope, so neither client can open an ordinary folder. Folders that are not trees need no synchronization; they need a dumb, reliable file editor with the same document surface.

## Design

**Daemon backend for the web** (`packages/arborsync/src/fs-editor.ts`, own module, own doc section, no `NodeRef`, no tree IDs):

```text
GET  /v1/fs/list?path=       → { entries: [{name, kind, size, mtime, etag}] }
GET  /v1/fs/read?path=       → bytes; ETag; 404
PUT  /v1/fs/write?path=      → If-Match: <etag> or "*"; 412 on mismatch; returns etag
POST /v1/fs/mkdir|move|delete?path=&to=   → plain; delete moves to ~/.Trash
GET  /v1/fs/events?path=     → SSE {kind, path, etag}
```

Absolute paths under `$HOME`; a path inside any placed tree is refused with `409 use-tree-session`; etag is `readRevision`; the watcher is `@parcel/watcher` with the existing ignore globs. Arbor web's `FsSession` implements the same scoped API shape with the local transport and the existing local block merge on external change.

**Mac provider** (`native/Packages/ArborKit/Sources/ArborKit/FilesystemWorkspaceProvider.swift` plus a document session), shaped on `InMemoryWorkspaceProvider`: resolve and children from `FileManager` with the `_index.md` and sibling rules ported from `WorkingTreeSemantics`; bounded title and body search; plain moves, creates, and trash; `readFile`; `admit(source:baseContentRevision:)` as a compare-and-swap on the byte revision; `updates()` from a file watcher. The provider is dumb; the editor host's admission machine runs as for any provider. `openLocalFolder(url)` with a persisted-URL store; Open Folder and Open Location in `ArborRootView`.

## Steps

1. `fs-editor.ts` and routes with tests: list, read, write with etag and 412, refusal inside placed trees, events without gaps.
2. Web `FsSession` and an end-to-end test that edits a plain folder and merges an external edit.
3. `FilesystemWorkspaceProvider` with the provider contract cases from `ProviderContractTests` re-targeted, an external-edit observation test, and the refusal test.
4. Docs: a "Folder editor (`/v1/fs`)" section in `docs/arborsync-api.md` labelled "not tree sync"; `docs/local-system.md`; `status.md`.

## Verification

```sh
bun run typecheck
bun run test
swift test --package-path native/Packages/ArborKit
git diff --check
```

Open a plain folder in both clients, edit, see the file update, make an external edit and see it merge; open a path inside a placed tree and land in the tree session.

## Done criteria

- Both clients open non-tree folders again with no synchronization machinery involved.
- A placed-tree path can never be opened through the folder editor.
