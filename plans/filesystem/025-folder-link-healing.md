# Filesystem 025: Heal links after folder moves, then remove the old editor write path

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MEDIUM. The daemon would write Markdown files you author, and those
  writes publish as ordinary edits.
- **State:** PLANNED, 2026-09-24 at `b7141f61` plus the uncommitted removal of
  `executeMutation` and the write journal.
- **Coordinates with:** Cleanup 001 (closed 2026-09-25, see
  [status](../../status.md#file-relative-markdown-links-and-readable-key-tokens--2026-09-25)) built the byte-preserving `healMarkdownLinks` in `@overstory/protocol`,
  made relative links file-relative (naming the physical `.md` file), and
  removed bare `#<PageID>` identity; this plan's daemon healer reuses that
  function and heals only the stable-key form.

## Why

Links name a page by readable path and, optionally, by stable key
(`?id=`/`#arbor-key=`; [locators](../../docs/overstory-spec/03-locators.md#2-stable-keys-revisions-and-fragments)).
When a page moves, Overstory readers still resolve the key, but the readable
path is stale. Plain Markdown readers, GitHub, agents and `grep` then see a broken
link. The spec expects authored content to be "healed through an ordinary
mutation" ([directory format](../../docs/overstory-spec/02-directory-format.md)).

Today that works only for moves made inside Canopy. `CanopyEditorWorkspace.healLinks`
(`swift/Packages/CanopyEditor/Sources/CanopyEditor/CanopyEditorWorkspace.swift`)
rewrites backlinks and the moved subtree's own links right after an app Rename or
Move, as ordinary edits through the change log.

Moves made in a placed folder with Finder, `git mv`, an editor or an agent are never
healed. The daemon's healer, `WorkspaceEditor.scheduleLinkHealing`
(`packages/arborsync/src/workspace-editor.ts`), only runs when a document is
projected through `WorkspaceEditor.snapshot`/`children`. Nothing but tests has
called those since the daemon's editor path was deleted on 2026-09-09
(`8e4ae386`). It also depends on the old write path this plan removes:
`WorkspaceFS.writeMarkdown`, `ArborBlock` parse and re-serialize (not
byte-preserving), and a 750 ms timer per page.

## Target

When the daemon's watcher sees a Markdown page with a unique `id:` land at a new
path, the daemon rewrites the stale readable paths in the folder's Markdown files
that link to it by stable key, and in the moved page's own relative links. It
writes each file only if the file is unchanged since it was read, and changes
nothing but those link paths. Each rewrite is an ordinary external edit, so the
update machine publishes it like any other change to the folder.

## What exists

- **Move events.** `FsEvent` carries `previousPath`, and
  `Workspace.handleFsEvent` already refreshes the ID maps
  (`discovery.pagePathsByID`, `pageIDOwners`) after a batch.
- **Shared link primitives.** `resolveLogicalURL` and `rewriteLocalLinkPath` in
  `packages/protocol/src/model/logical-url.ts` have Swift twins in
  `CanopyAppKit/LogicalURL.swift`, pinned by shared fixtures.
- **A source-level healer, Swift only.** `healedLinkPaths` in
  `CanopyEditorWorkspace` rewrites link paths in source text, which preserves every
  other byte. TypeScript has only the block-level rewrite in
  `packages/protocol/src/documents/child-links.ts`.
- **No backlink index in the daemon.** It was deleted with the editor path. Swift's
  `WorkingTree` keeps one (`inboundByStableKey`).

## Work

1. **One source-level healer in `@overstory/protocol`.** Add
   `healLinkPaths(source, base, targets) -> string`. It rewrites the readable path
   of every link whose stable key names a moved page, preserves the key, query,
   fragment and every other byte, and leaves links without a key alone. Give it
   language-neutral fixtures, and make Swift's `healedLinkPaths` pass the same
   fixtures. Nested-tree boundaries and cross-tree links are never rewritten.
2. **Inbound links in the daemon.** At discovery, record for each Markdown file the
   stable keys its links carry; update the record for files the watcher reports
   changed. Keep it in memory next to the ID maps, since it is rebuilt from the
   folder anyway. Measure on the largest placed tree.
3. **Heal after a settled move.** When a watcher batch moves an `id:` page (the ID
   map's owner path changed, or `previousPath` names it), collect the files linking
   to that key plus the moved page (and its subtree). For each file: read its bytes
   and hash, heal, then write atomically only if the hash still matches, through the
   folder's ordinary write (not `WorkspaceFS.writeMarkdown`). Skip healing while the
   tree is held or has a conflicted file, when the page's `id:` is duplicated, and
   in read-only placements. Debounce across one watcher batch, not with a timer
   per page.
4. **Delete the old healer and the dead write path.** Once step 3 replaces it:
   - `WorkspaceEditor.scheduleLinkHealing`, `healingTimers`, `cancelPendingHealing`
     and its call in `workspace.ts`, the private `write`, and `RevisionConflictError`
     if nothing else uses it;
   - `WorkspaceFS.writeMarkdown`, `mutate`, the fs-transaction recovery and
     `takeRecoveredMutationResults`, `FsMutationRequest` and `MarkdownWriteRequest`,
     and the `tests/unit/fs.test.ts` cases that only cover them;
   - the `ContentWorkspaceOperation`/`StructuralWorkspaceOperation`/`MutationRequest`
     family in `packages/protocol/src/model/protocol.ts`, and `NodeWriteRequest` if
     nothing else uses it (canopy-web imports it; it is unmounted and Web 025
     rebuilds it, so delete the import);
   - the `idOwners`/`pathPageIDs` maps in `WorkspaceEditor` if healing no longer
     reads them there.
   Check every symbol with `git grep` first; keep anything a production path
   still reaches, and say why in the commit.
5. **Decide about the node projection.** `WorkspaceEditor.snapshot`/`children`
   (`FilesystemNodeSurface` through `NodeProviderRouter`) are also test-only now,
   but `tests/integration/generic-node-query.test.ts` uses them as the node
   provider for the apps runtime's generic node queries, which
   [Apps 005](../apps/005-source-resolution-and-sidecar.md) may need. Either keep them
   and document them as the apps runtime's folder provider, or delete them and
   leave Apps 005 to build its provider over the working tree. Recommended: keep
   them until Apps 005 decides, but take them out of `WorkspaceEditor`'s name and
   doc comment so it no longer claims to be an editor.
6. **Docs.** `docs/architecture/arborsync/README.md` (it says the editor does
   "link healing"), `packages/fs/README.md`, and `status.md` once the new healing
   runs in the installed daemon.

## Verification

- Healer fixtures pass in TypeScript and Swift (`bun run test:protocol`,
  `swift test --package-path swift/Packages/CanopyAppKit`).
- Daemon integration tests:
  - Finder-style rename and move of an `id:` page heal its backlinks and its own
    relative links, and the edits are published.
  - A file edited between read and write is not overwritten.
  - Duplicate IDs, held trees, read-only placements, nested trees and cross-tree
    links are left alone.
  - A page without `id:` is not healed.
  - A move arriving from Canopy and materialized into the folder is not healed a
    second time when the mover already healed it.
- `bun run typecheck`, `bun run test` (rerun known parallel flakes alone),
  `bun run check:links`, `git diff --check`.
- Hands-on, after Joe installs the daemon build: rename a page in Finder and
  confirm the linking pages update on the Mac and on the iPhone.

## Out of scope

Healing links by path alone (without a stable key); rewriting links in non-Markdown
files; healing inside Canopy for moves from other devices (the mover heals); a
persistent backlink index.

## STOP conditions

- The heal cannot be made byte-preserving outside the rewritten link paths.
- A heal write could race a concurrent edit without being detected.
- Healing would need a new arborsync route.
