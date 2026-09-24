# canopyd 007: Document history routes, restore, and the History view

Historical identifier: **Smaller project 007**, formerly "Surface accepted document
history from canopyd". Its storage half shipped with canopyd 013
([closeout](../../status.md#canopyd-011-012-and-013-closeout--2026-09-22)); this plan is
what remains.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH — an authenticated canopyd route that enumerates deleted
  source, and a visible restore action whose meaning changes
- **State:** PLANNED. Refreshed 2026-09-24 after migration 016 and the working-tree redesign.
- **Depends on:** nothing. Execute before [canopyd 006](006-line-provenance.md),
  which reuses the same index.

## Target result

**History** on a Markdown page lists that document's accepted versions, newest
first, from canopyd. **Restore as New Change** fetches one version's exact
source and submits it as an ordinary new edit through the change log, so every
later accepted version stays in history. Trash recovery is a separate repair
tool and never appears as History.

## What exists

- **The index.** `document_versions (tree_id, stable_key, update_id,
  entry_path, content_hash, accepted_at)` is written inside every accepted
  transaction by `EntryMetadataStore.apply`
  (`packages/canopyd/src/updates/entry-metadata.ts`) and was backfilled from all
  retained history. The row order (rowid) is accepted order. Keys are
  `id:<PageID>` when the frontmatter names exactly one `id:`, otherwise
  `path:<entry path>`, so an unidentified page's history stops at its first
  move. `update_id` is opaque: a version written before migration 016 names an
  update that migration squashed, so the routes must not resolve it as an
  accepted update. A row is written only when a key's content hash changes; a pure move is
  not a version, and deleted documents keep their rows. Duplicate IDs share one
  key: the routes must fail on them, not the index.
  Nothing reads it yet; the routes add the reader.
- **Objects.** The retention definition (`packages/canopyd/src/retention.ts`)
  keeps every `document_versions.content_hash`, so a version's body always
  resolves through the object store even though migration 016 squashed each
  tree's history to its head.
- **Clients.** `WorkspaceDocumentSession.history()` / `recover(revision:)` is the
  UI seam. `WorkingTreeProvider` throws "Canopy history is not available yet", and
  `CanopyDocumentBinding.history()` flushes and delegates to it, so History
  shows an empty state today (the editor recovery store that used to supply
  local copies is gone). `CanopyHistoryView` already says **History** and **Restore as New
  Change**. Every editor is a direct Canopy client with its own credential, so
  history comes from canopyd directly: no Arbor Sync proxy, no local copy.

## Decide first

1. **Local versions** (formerly open question 10). Working-tree sessions serve
   no document history. Either History waits for these routes and is
   Canopy-only, or the change log's settled records also serve recent local
   versions (for example unpublished edits made offline). Recommended: Canopy
   only, which keeps the "no second history store" STOP below; unpublished
   edits already survive in the change log and publish on reconnect.
2. **Retention bound.** `document_versions` holds most of what the object
   collector keeps (106 MB of 116 MB on 2026-09-24, nearly all versions of one
   60 KB `_index.md`; see [canopyd 017](017-collect-objects-live.md)). Choose
   the bound History promises, for example every version for N days and then
   one a day, and prune rows to it so the collector reclaims the bodies.

## Contract (freeze first)

```ts
type DocumentHistoryEntry = {
  update: string;          // accepted update id
  path: LogicalPath;       // the page's logical path at that update
  contentHash: ObjectHash;
  acceptedAt: number;      // Unix ms
};
type DocumentHistoryPage = { entries: DocumentHistoryEntry[]; nextCursor: string | null }; // newest first
type DocumentHistoryVersion = DocumentHistoryEntry & { source: string }; // exact UTF-8
```

```text
GET /.arbor/trees/{TreeID}/history?path={logical-path}&cursor={cursor}
GET /.arbor/trees/{TreeID}/history/{update}?path={logical-path}
```

The server resolves `path` in the current accepted root to its body entry and
key (the same `documentKey` rule), then reads the index. Freeze in
`docs/overstory-spec/01-tree-operations.md` and `05-access-control.md`:

1. Document-scoped, newest first, one entry per content change. Logical paths
   come from entry paths (`/a.md` → `/a`, `/d/_index.md` → `/d`, sibling body
   `/d.md` → `/d`).
2. **Access:** a currently valid, authenticated **write-capable device
   credential** for the tree. Public, access-link and read-only callers cannot
   enumerate deleted source. Unknown, wrong-tree, unauthorized and unretained
   entries are indistinguishable `404`s. Known-hash object reads (for example sparse placement, Native 006) are
   not enumeration and do not widen this.
3. Opaque cursor over the index's rowid, fixed maximum page size, bounded work;
   a limit returns a typed error, never a short page that looks complete.
4. `source` is exact UTF-8, line endings and final newline included.
   Non-Markdown, invalid UTF-8, missing and duplicate-ID cases fail explicitly.
5. Restore never rewinds canopyd: the client submits the fetched source as a new
   edit through the change log and the ordinary update and conflict handling.

Changing who may enumerate history is a STOP for an explicit threat-model
decision.

## Steps

1. **Contract.** Spec text, strict TS and Swift models/decoders, and
   language-neutral fixtures that both accept and reject identically.
2. **canopyd.** A history reader over `document_versions` (authorization, path
   → key, pagination, exact-source fetch) separate from HTTP, then the two host
   routes. Tests: initial history, identical re-saves, edits, identified and
   unidentified moves, delete/recreate, duplicate IDs, merged updates,
   pagination and bounds, wrong tree, revoked credential, read-only/public/link
   denial.
3. **Clients.** `ProtocolClient.history`/`historyVersion`;
   `WorkingTreeProvider` sessions return canopyd history. `recover` verifies
   tree, path and content hash, then appends the source to the change log as a
   new change. Cover
   stale/current races and a conflict that preserves live editor text.
4. **History view.** Loading, **No accepted history yet**, offline ("History
   needs a connection to Canopy"; never a local fallback), error, rows labelled
   by acceptance time, and the **Restore as New Change** confirmation saying later
   history is kept.

## Verification

- `bun run typecheck`, `bun run test`, `bun run test:protocol`,
  `swift test --package-path swift/Packages/Overstory` and
  `swift/Packages/CanopyWorkingTree`, `swift/scripts/test-canopy-editor-local.sh`,
  and macOS and iOS app builds through `swift/Canopy.local.xcworkspace`.
- Manual on Mac and iPhone: restore an older version online and see the previous
  latest version still listed after acceptance; offline, History reports that
  Canopy is unreachable.

## Out of scope

Generic tree history, historical checkout, diffs, branching, history editing,
federation, pack storage; Trash or crash recovery; any change to hashes, roots, accepted order or merge policy.

## STOP conditions

- History would become enumerable by read-only, public, access-link or
  unauthenticated callers.
- Restore cannot go through the change log without losing exact Markdown,
  bypassing conflict authority, or overwriting live text before acceptance.
- The work needs a second history store or cache on any client or daemon.
