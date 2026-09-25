# Cleanup 001: File-relative Markdown links, readable key tokens, and the PageID cutoff

Current identifier: **Cleanup 001**. Absorbs **Cleanup 005** (locator identity surfaces, formerly Smaller project 002 / Data model 002). The row child segment question from 005 moved to [Postgres 005](../postgres/005-representation-equivalence.md#provider-and-exact-source-continuations).

## Status

- **Priority:** P2 · **Effort:** L · **Risk:** HIGH (spec, both clients, and a live data rewrite)
- **Progress:** IN PROGRESS since 2026-09-25 on branch `file-relative-links`. Joe resumed it and chose the design below in session; the live steps still need his go-ahead one at a time.
- **Audit (Phase 0, 2026-09-25):** `~/.arbor/.state/migration/file-relative-links-audit-*/receipt.json`. The account owns two ordinary trees, both placed on the Mac. The profile tree has no relative links. todos has 69 bare `#<id>` links whose id has an owner, 2 whose id has none (`Untitled-4.md#cxua95`), 4 `#arbor-key=` aliases, 12 same-tree `arbor://` document rows, 68 keyless relative links (1 of which changes meaning under file-relative resolution, 20 already dangling), and 5 images. No `/node/?stableKey=` rows. The latest canopyd backup holds no base64url key tokens.

## Context

Two related cleanups, done together.

- **Cleanup 001.** A bare `#<PageID>` fragment is still read as page identity, through `legacyStableKeyCandidate` / `legacyPageID` in TypeScript and Swift. The generic `pageIDStableKey` helpers leak Markdown identity into the core.
- **Cleanup 005.** A stable key has too many spellings.

Joe's decisions, from this session:

1. **Links must work in Obsidian.**
   - A relative Markdown link resolves against the **directory that holds the source file**: the parent folder for `x.md`, and `x/` for `x/_index.md`.
   - Writers name the target's **physical file**: `Calendar.md`, `Picture-of-Life/Foo.md`, `x/_index.md`.
   - `#arbor-key=<token>` stays the only key spelling in Markdown; Obsidian ignores it.
   - `;arbor-key=` stays for `arbor://` links, HTTP, and the key-plus-heading or revision cases.
   - Every writer and saving pipeline changes, in both TS and Swift.
2. **Same-tree Swift document-link rows become relative links.** `arbor://` is used only across trees.
3. **The row child-segment question is deferred** to Postgres 005.
4. **The PageID bridge goes now.** A bare `#frag` becomes an ordinary content fragment. The `arbor://…/node/…?stableKey=` shim is deleted. This is a clean break with no shims.
5. **The two dangling `Untitled-4.md#cxua95` links get their fragment stripped.**
6. **The `x.md` ⇔ `x/_index.md` equivalence stays.**
   - Readers accept `x.md`, `x/_index.md`, `x/` and `x`.
   - Writers name whichever body exists.
   - A move, or a change of body form, heals the moved file's outbound links and the spellings that point in.
7. **No compatibility period.** Code lands first, and the data rewrite follows. Links may be broken for a while. Healing may write the new format into files that are still otherwise in the old format.
8. **Key tokens are readable and greppable on every surface.** Base64url is dropped, so `#arbor-key=id:h31mlm` replaces `#arbor-key=W1siaWQiLCJoMzFtbG0iXV0`. Grepping for a page ID then finds every link to that page.
9. **The migration's update is inspected before it is published.** This needs a new arborsync feature: pause a placement, show the pending update, then resume.

**Tree to migrate:** todos, at `~/Documents/arbor-rehearsals/todos-2026-08-25-f` (tree `tr_owozr6…`, arb.nxhx.org/~joe/todos). It contains:

- 71 bare `#id` links;
- 4 `#arbor-key=` links;
- 12 same-tree `arbor://` rows;
- 73 keyless relative references:
  - 56 root `_index.md` rows, of which 15 already dangle;
  - 11 leaf `.md` links;
  - 5 images;
  - 1 link whose meaning shifts.

The profile placement contains none of these forms.

**Facts verified in code:**

- **Link bases differ today.**
  - Swift `WorkingTreeSemantics.linkBase` uses the node path for a directory and the parent otherwise.
  - canopyd `public-page.ts:44` always uses the node path.
  - The resolver's arithmetic is unchanged; callers now pass a source *directory*.
- **arborsync's `scheduleLinkHealing` is dead in production.**
- **The Swift search index needs a format field** so that a stale index is rebuilt.
- **Two things are already gone:** the TS `target_page_id` index, and `#row=`, which has no code.

**Defaults adopted:**

- **The migration rewrites every same-tree link whose target it can prove** into exactly what the new writer emits, adding the key when the target has an `id`. Dangling keyless links are left alone and reported.
- **`.mdx`/`.tsx` stay literal paths in the parser.**
- **Copying a block to another document does not rebase its relative hrefs.** This is recorded as a limitation.

## Shared API (TS `packages/protocol/src/model/logical-url.ts` ⇔ Swift `CanopyAppKit/LogicalURL.swift`)

These functions replace the old ones outright; nothing old stays alongside.

| TS | Swift | Role |
|---|---|---|
| `MarkdownBodyOrigin = "sibling" \| "index"` | `enum MarkdownBodyOrigin` | A leaf `x.md` is `sibling` |
| `markdownSourceDirectory(nodePath, body)` | `markdownSourceDirectory(nodePath:body:)` | `sibling` → parent; `index` or no body → the node itself |
| `markdownLinkFile(nodePath, body)` | `markdownLinkFile(nodePath:body:)` | `/x.md`, `/x/_index.md`, or the logical path if there is no body |
| `relativeFileReference` | `relativeFileReference(from:toFile:)` | Replaces `relativeLogicalReference`; percent-encodes |
| `buildMarkdownLink(sourceDirectory, target)` | `buildMarkdownLink(from:to:)` | Replaces `buildCanonicalLink` |
| `rewriteLocalLinkPath(sourceDirectory, href, target)` | same | |
| `resolveLogicalURL(sourceDirectory, href)` | same | Parameter renamed |

**Which keys the Markdown link carries.** `#arbor-key=` (and `;arbor-key=`) encodes *any* canonical stable key, not just a document ID:

- a Markdown document's key is `[["id","h31mlm"]]`, from frontmatter;
- a collection row's key is its schema key, e.g. `[["slug","walking"]]` or a primary key such as `[["id",42]]`.

`buildMarkdownLink` always writes the target's own key and never assumes it is an `id` key.

- **Expanded Markdown records** get a physical file name, e.g. `Tasks/walking.md#arbor-key=slug:walking`.
- **Rows inside a collection file** (`_store.csv`, sqlite, postgres) have no file of their own, so they keep the extensionless row segment, e.g. `Tasks/walking#arbor-key=…`. Obsidian can't open those; Overstory resolves them.

Resolution and healing look keys up generically:
- canopyd: `projection.ts` row lookup and key search;
- Swift: backlinks by key.

The owner map in `workspace-editor.ts` becomes stable-key keyed but still holds only Markdown `id` keys, because that is all it discovers.

The vectors (`markdown-links.json`, `url-resolution.json`) include:
- an `id` key;
- a string row key;
- a numeric row key;
- a multi-pair key;
- an expanded-record target;
- a collection-file-row target.

The todos tree has no collections, so the migration only handles `id` keys.

**Readable key token.** This replaces base64url in `encodeStableKey` / `decodeStableKey` (`packages/protocol/src/model/node-key.ts:63-80`) and their Swift twins (`LogicalURL.swift:95-114`). It is the single definition, used by `;arbor-key=` and `#arbor-key=` alike.

```
token  = pair *( "," pair )            ; pairs in canonical-key order
pair   = name ":" pct-string           ; string value
       / name "=" ( "true" / "false" / json-number )   ; non-string scalar, RFC 8785 number text
name   = 1*pct-char                     ; percent-encoded property name
```

- **Percent-encoding is strict:** every byte outside the unreserved set `A-Z a-z 0-9 - . _ ~` is `%XX`, uppercase, over UTF-8.
- **Decoding is canonical-only:** decode → canonical key JSON → re-encode must reproduce the input exactly, otherwise the locator is invalid. This is the same round-trip rule as today.
- **Examples:**

  | Key | Token |
  |---|---|
  | `[["id","h31mlm"]]` | `id:h31mlm` |
  | `[["id","pg_2418e521-42b7-…"]]` | `id:pg_2418e521-42b7-…` |
  | `[["slug","walking"],["lang","en"]]` | `slug:walking,lang:en` |
  | `[["id",42]]` | `id=42` |
  | `[["t","a b"]]` | `t:a%20b` |

- **Minted page IDs need no escaping,** since `mintPageID` uses `[a-z0-9]` and the older IDs use `pg_` plus a UUID. So `rg h31mlm` finds every link to that page.
- **Callers that switch to `encodeStableKey`:**
  - `tree-merge/src/merge-rules.ts:299`, which hand-rolls base64url for row-conflict paths;
  - `docs/getting-started/intro.md` and every `W1s…` vector (`url-resolution.json`, `node-targets.json`, `directory-documents.json`, `logical-url.test.ts`, `LogicalURLTests.swift`).
- **Out of scope: `rowPathSegment`'s `~row-<token>`.** It is the deferred row-segment question, so it keeps base64url through a private helper in `node-key.ts`, and its row paths don't change. Postgres 005 gets a note that the row segment is the last base64url surface.
- **Vectors:** a new `docs/overstory-spec/conformance/stable-key-tokens.json` covers:
  - string, number, boolean, multi-pair, and empty-string keys;
  - non-ASCII values, and reserved characters `, : ; # ? % / =`;
  - rejections: lowercase hex, an unnecessary escape, non-canonical number text, a missing value.

  Both languages run it.
- **Spec:** 03 §2's "single definition of that encoding" paragraph is rewritten to this grammar.

**New modules:**

- `packages/protocol/src/documents/markdown-links.ts` ⇔ `CanopyAppKit/MarkdownLinks.swift`. They hold:
  - `markdownLinkDestinations(source)`;
  - `healMarkdownLinks(source, {resolveFrom, writeFrom, tree, target})`, which preserves bytes. This is Filesystem 025's planned `healLinkPaths`.
- `packages/protocol/src/documents/markdown-identity.ts`, with `markdownStableKey(id)` and `markdownIDFromStableKey(key)`. These mirror Swift's `WorkspaceModels.swift:120,126`.

**Where each caller learns a node's body form:**

- canopyd: `ResolvedProtocolLogicalNode.bodyOrigin` / `objectName`.
- Swift working tree: `WorkingTreeNode.directoryBodyPlacement`.
- Swift editor: a new optional `markdownBody` on `WorkspaceNode` / `WorkspaceSearchResult`.
- Web (outside the build): `content.representation.origin`.

**Where the work happens:** a worktree (`git worktree add ../arbor-file-links -b file-relative-links`). The daemon runs `~/src/arbor` on `main`, and pushing to `main` deploys canopyd.

## Phase 0: read-only audit and plan bookkeeping (1 commit)

- **Audit script.** Add `packages/canopyd/migrations/021-file-relative-links/` with a `README.md` runbook and `audit.ts`.
  - `audit.ts` reads the local placements through `:4317/v1/trees`.
  - It reads the host's `~joe` trees through `/.arbor/trees/{id}/snapshots/{root}`, keeping the credential in memory only.
  - It classifies every link destination.
  - It lists every persisted base64url key token outside authored trees, so none go stale. It checks:
    - `rg 'arbor-key=W1'` over `~/.arbor` (app state, placement JSON);
    - a read-only query of the newest `.backups/railway` copy of the canopyd DB (merge conflict paths, stored locators).

    Any hit gets a rewrite step in Phase 3 or a STOP.
  - It writes `~/.arbor/.state/migration/file-relative-links-audit-<stamp>/receipt.json`.
- **Plan bookkeeping:**
  - Move 005's row-segment question into `plans/postgres/005-representation-equivalence.md`.
  - Record the decisions in `plans/soon/001`, folding 005 into it.
  - Update `plans/catalog.md`.
- **STOP if:**
  - an unplaced host tree has legacy forms;
  - a tree can't be inspected;
  - the counts differ from the ones above.

## Phase 1: the code change (focused commits, landed together; no side-by-side period)

### 1a. Markdown identity and owner maps

- **Add `markdown-identity.ts`** and move every caller onto it:
  - `canopyd/src/projection.ts`
  - `arborsync/src/node-sampling.ts`
  - `filesystem-node-surface.ts`
  - `directory-document.ts`
  - the tests
- **Delete `pageIDStableKey` and `pageIDFromStableKey`** from `node-key.ts`.
- **Rework `workspace-editor.ts`:**
  - `idOwners` → `ownerByStableKey`
  - `idOwnerSets` → `ownersByStableKey`
  - `pathPageIDs` → `stableKeyByPath`
  - `resolveRef` looks up by key; an unknown key → 404, a duplicate → 409.
  - `childPageID` → `childStableKey`.
  - Delete the dead `scheduleLinkHealing`, `healingTimers` and `cancelPendingHealing`.
- **Unchanged and Markdown-private:** `packages/fs` discovery, minting and duplicate diagnostics.
- **Tests:** `tests/unit/markdown-identity.test.ts` and `tests/integration/workspace.test.ts`.

### 1a′. Readable key token, TS and Swift in one commit

- Switch `encodeStableKey` / `decodeStableKey` and their Swift twins to the grammar above.
- Keep base64url private to `rowPathSegment`.
- Fix `merge-rules.ts:299`.
- Add `stable-key-tokens.json` and rewrite every `W1s…` fixture.
- Update spec 03 §2 and `docs/getting-started/intro.md`.

### 1b. File-relative links and bridge removal, TS and Swift in one commit

- **Replace the link API** with the one in the table above.
- **Remove the legacy readers:**
  - `legacyStableKeyCandidate`
  - `ResolvedNodeTarget.legacyPageID`
  - `legacyNodeRoute`
  - `legacyPageIDCandidate`
- **Protocol callers:**
  - `placeDirectoryChildren(sourceDirectory, …)`: `DirectoryPlacementChild` gains `body` and loses `pageID`.
  - `reorderChildLinks`: `ChildLinkMove.newBody`.
- **canopyd:** `public-page.ts` gets `sourceDirectory`, wired from `host.ts:781,831`.
- **Shared vectors in `docs/overstory-spec/conformance/`**, run by `tests/unit/logical-url.test.ts` and `LogicalURLTests.swift`:
  - `url-resolution.json`:
    - `base` becomes `sourceFile`, and the legacy field is dropped;
    - `#x7f3q2` is now a content fragment only;
    - new alias cases: `x.md`, `x/_index.md`, `x/` and `x` all resolve to `/p/x`, and `x.tsx` stays literal.
  - `node-targets.json`: `/node/x?stableKey=` is now a literal path plus a query.
  - `directory-documents.json` gains `sourceFile` and child `body`.
  - New `markdown-source-directories.json`: leaf, sibling, index, contentless, root, and a shadowed sibling.
  - New `markdown-links.json`:
    - leaf; a sibling document to its child; `_index` to a child; a child to its parent;
    - a folder-only target; a target equal to the source directory;
    - a row; key plus heading; a revision;
    - percent-encoding.
  - New `markdown-link-healing.json`:
    - a moved leaf's outbound keyless link;
    - `x.md` → `x/_index.md`, both outbound and inbound;
    - `_index.md` materialization;
    - a same-tree `arbor://` row becomes relative; a cross-tree row stays;
    - a stale path healed by key;
    - CRLF, BOM and unrelated hrefs stay byte-identical.
  - New `markdown-link-destinations.json`.
- **New test:** `tests/unit/canopyd/public-page.test.ts`.
- **Spec:**
  - `03-locators.md` §2: one **surfaces table**:

    | Surface | Spelling |
    |---|---|
    | `NodeRef` | JSON |
    | network / `arbor://` | `;arbor-key=` |
    | Markdown relative link | `<physical file>#arbor-key=` |
    | frontmatter `id` | Markdown codec |
    | row segment | 06, still open |

    Plus a list of removed forms.
  - New §2.1: file-relative resolution, with the body-form table.
  - §3: `.md` spellings in Markdown; canonical URLs stay extensionless.
  - §4: the healing bullet.
  - Remove the legacy text.
  - `02-directory-format.md` §2 and §4: the healing rule when a body changes form.
  - `08-authoring-api.md`.
  - `conformance/README.md`.
  - `docs/implementing-editors/design.md`.

### 1c. Swift working tree

- `linkBase` becomes `sourceDirectory(for:)`.
- Remove `inboundByLegacyPageID` (`WorkingTree.swift:516–555`).
- `WorkingTreeSearchIndex` gains `format: Int = 2` (non-optional) and `Entry.markdownBody`, so an old index is rebuilt.
- Fill `markdownBody` in `WorkingTreeProvider` and `InMemoryWorkspaceProvider`.
- **Tests:**
  - an old-format index is rebuilt even when the generation matches;
  - sibling vs index bases;
  - backlinks by key.
- **Docs:** `docs/architecture/canopy-browser/local-state.md`.

### 1d. Swift editor and app

- **`MarkdownCodec.placeDirectoryChildren`** writes relative rows through `buildMarkdownLink`; cross-tree rows stay `arbor://`.
- **`CanopyEditorHost`:**
  - `sourceDirectory` replaces `relativeReferenceBase`.
  - `suggestDocuments`, `createDocument` and `resolveReference` produce the finished relative href, because `linkURL` is synchronous.
  - `CanopyDocumentReferenceCodec` is only for cross-tree and UI-only references.
- **`CanopyEditorWorkspace.healLinks`:**
  - captures `(reference, sourceDirectory)` before the move;
  - calls `healMarkdownLinks(resolveFrom: old, writeFrom: new)`, which also heals the moved document's own outbound links (missing today);
  - converts same-tree `arbor://` links to relative.
- **`CanopyAppModel.swift:~2063`.**
- **Tests:**
  - update `CanopyEditorTests` (413–422, 749–750, 836–849, 1034–1048, 1266–1276, 1783–1837), `LiveEditorAdmissionTests:72–77` and `CanopyAppTests`;
  - new: suggestions within the same tree vs across trees, sibling and index rows, outbound healing after a move.

### 1e. canopy-web (outside the build; minimal)

- `PageEditor.tsx` uses the source directory, and `navigate` passes `link.stableKey`. This fixes the bug where a key other than `id` is dropped.
- Update `ReadOnlyPage.tsx`.
- Note both in Web 025.

### 1f. arborsync sends object deltas (own commit, before 1g)

**What a delta is.** Updates already allow `deltas: ObjectDelta[]` (`packages/protocol/src/updates/types.ts:44-57`, spec `01-tree-operations.md` §2.5). Each is a byte-level `copy`/`insert` from a base object to the new object.

**Who sends them today:**
- Swift Native sends deltas (`CanopyWorkingTree/ChangeLog.swift:278-305`).
- canopyd builds them for accepted transitions (`canopyd/src/updates/transition.ts:43-77`, using `objectDelta` in `protocol/src/updates/delta.ts:77`).
- arborsync's `FolderSync.prepare` (`folder-sync.ts:313`) sends `deltas: []`.

**Changes:**
- **Lift the pairing and size rule into protocol.** Move `buildAcceptedTransitionPayload`'s pairing (a changed object against the object at the same path, via `walkTreeDiff`) and its "keep the delta only if its JSON is shorter" rule into `packages/protocol/src/updates/transition-payload.ts`, as `transitionPayload(basisRoot, candidateRoot, newObjects, read)`.
  - `walkTreeDiff` moves from `canopyd/src/updates/tree-diff.ts` along with it.
  - canopyd's `transition.ts` becomes a thin caller, and its tests stay green unchanged.
- **Use it in `FolderSync.prepare` when the basis is accepted.**
  - Base file bytes come through `host.objectBytes`; directory bases come from the spine that is already loaded.
  - A chained (authored) basis still sends whole objects, as Swift does (`ChangeLog.swift:280-283`), because canopyd preflight does not retain a chained basis.
- **Tests:**
  - a folder edit to a large Markdown file submits a delta that canopyd accepts (`tests/integration/arborsync-*` against an in-process canopyd);
  - a chained basis sends objects whole;
  - the canopyd transition tests still pass.
- **Spec:** none needed; §2.5 already leaves the diff algorithm to the sender.
- **Docs:** `docs/architecture/arborsync/README.md`.

### 1g. arborsync: pause, pending, resume (new feature, own commit)

Pausing lets a person see exactly what the daemon would POST before it does. The words are chosen so they don't collide with "held", which already means a change the host refused.

- **`FolderSync`** (`packages/arborsync/src/folder-sync.ts`):
  - a persisted `paused` flag in the folder state;
  - while paused, `scanOnce` does not `prepare`/`retain` and reports `sync: "paused"`.
- **`FolderSync.preview()`:**
  - runs `loadKnown` → `host.scan()` → `prepare()` with no side effects;
  - then assembles `{base, updates: [...unsettled chain, this change]}` the way `ChangeLog.request` does.
  - Factor the request assembly out of `ChangeLog.request` (`packages/working-tree/src/node/change-log.ts:109`) so the two can't drift.
- **Daemon methods** (`service.ts`): `pauseFolder(tree)`, `resumeFolder(tree)` and `pendingUpdate(tree)`. `resumeFolder` calls `scan()`.
- **Routes** in `sync-http.ts`, placed before the 405 catch-all:
  - `POST /v1/placements/pause {tree}`
  - `POST /v1/placements/resume {tree}`
  - `GET /v1/pending?tree=`
- **Client methods** in `packages/cli/src/daemon-client.ts`.
- **CLI:**
  - `arbor pause <path>`
  - `arbor resume <path>`
  - `arbor pending <path> [--json]`
- **Pending output.** Both views come from the update's own `objects` and `deltas`, so what you inspect is literally what will be sent.
  - `--json` prints the exact `UpdateRequestJSON`, deltas included.
  - The human view comes from `describeTransitionPayload(basisRead, update)` in `packages/protocol/src/updates/describe.ts`:
    - It shows the basis root and candidate root, and the counts of objects and deltas.
    - A **file delta** is shown against the base text. Each `copy` collapses to `… N unchanged bytes (lines a–b) …`, and each `insert` prints its text, with the base text it replaces shown as removed. For the migration this reads as href-only edits.
    - A **directory delta or directory object** is decoded from CBOR and shown as the entries added, removed or changed. Raw CBOR splices are never printed.
    - A **whole new object** prints its path, size, and text when it is UTF-8.
  - The describer is also exposed as a library function so tests and the migration can assert on it.
- **`arbor status`** shows `paused`.
- **Tests** (`tests/integration/arborsync-*`):
  - pause stops publishing across a restart;
  - `pending` equals the body that `resume` then submits;
  - resume publishes it;
  - `pending` is empty when there are no changes.
- **Docs:** `docs/architecture/arborsync/README.md` (routes, and drop "link healing"); the CLI usage text.

### Verify Phase 1

- `bun run typecheck`, `bun run test`, `bun run test:protocol`
- `swift/scripts/test-canopy-editor-local.sh` (never a standalone CanopyEditor build)
- `bun run test:performance` and the canopyd-merge suites
- `bun run build`, `bun run check:links`, `git diff --check`
- macOS then iOS `xcodebuild` builds, one after the other
- Closure grep, which must show no production callers: `rg -n 'legacyStableKeyCandidate|legacyPageID|pageIDStableKey|pageIDFromStableKey|stableKey=' packages swift tests docs/overstory-spec`

**STOP if:**
- TS and Swift disagree on a vector;
- Quagmire needs an API change;
- the index doesn't rebuild.

## Phase 2: release (each step needs Joe's go-ahead)

1. Merge and push to `main`. This deploys canopyd; there is no schema or wire change.
2. Fast-forward `~/src/arbor` and restart arborsync.
3. Install the Mac app.
4. Rebuild the iPhone app.

Until Phase 3 runs, links in todos are partly broken. That is accepted.

## Phase 3: todos migration

### Scripts

`021-file-relative-links/` holds `run.ts`, `legacy.ts` and `migrate.test.ts`. `legacy.ts` carries the old interpretation (bare `#id`, the old Swift base), since the product no longer has it.

### What `run.ts` does

1. **Index the tree.** Scan `.md` files and build `id → {path, body}`. STOP on duplicate ids.
2. **Choose each link's target:**
   - same-tree `arbor://` with a key, `/node/?stableKey=`, `#arbor-key=`, `;arbor-key=` → the key's owner. `legacy.ts` decodes the old base64url tokens, and the new link carries the readable token;
   - a cross-tree `arbor://` with a base64url token keeps its target but gets the readable token re-encoded;
   - a bare `#frag` that is an owned id → its owner, and the fragment is dropped;
   - the exact `#cxua95` list → strip the fragment;
   - any other bare fragment → STOP.
3. **Keyless links:**
   - resolves under the new rule → fix the spelling;
   - resolves only under the old rule → rewrite;
   - the two rules disagree → STOP;
   - dangling → report it.
4. **Images** are fixed only when their meaning shifts.
5. **Mixed files are fine.** A file that new-client healing has already partly rewritten goes through the same rules.
6. **Write** each href with `buildMarkdownLink`.
7. **Self-check:**
   - re-resolving a new href gives the same path and key;
   - substituting the old hrefs back reproduces the original bytes.
8. **Dry-run** prints counts per rule and compares them with `--expect`.
9. **Private receipt** holds, per file, the hashes before and after, plus `{line, before, after, rule}` for each link.
10. **`--apply`:**
    - requires the placement to be paused (checked through `/v1/trees`);
    - checks each file's hash again before writing;
    - writes a temp file, fsyncs, then renames.
11. **`--revert`** restores a file only while it still has its "after" hash.
12. **Idempotent:** a second dry-run reports 0.

**`migrate.test.ts`** covers every rule, CRLF/BOM, code fences, a concurrent edit, duplicate ids and idempotence. Run it with `bun run test:migration packages/canopyd/migrations/021-file-relative-links`.

### Live runbook (Joe confirms each step)

1. Rehearse on a scratchpad copy and save `counts.json`. Re-run the audit.
2. Quit Canopy on the Mac and iPhone. `arbor status` shows todos idle and not conflicted.
3. Back up: tar the placement into `~/src/arbor/.backups/file-relative-links/<UTC>/`, and run `authored-manifest.ts write authored-before.json`.
4. `arbor pause <todos>`.
5. `run.ts --expect counts.json` (dry run), review it, then `--apply`.
6. `arbor pending <todos>`. The basis is accepted, so every Markdown file arrives as a delta. Review the delta view with Joe:
   - only the receipt's files change;
   - every `insert` is a link href;
   - directory entries change only in their hashes.

   Save `--json` beside the backup, and diff the authored manifests.
7. `arbor resume <todos>`. The update number advances, the placement returns to idle, and the root matches the pending candidate.
8. Check that on the Mac, iPhone and canopyd pages, links, rows and backlinks resolve.
9. Fix by hand, with Joe, the links the rewrite reports as dangling (mostly root `_index.md` rows naming pages that moved deeper).

**Rollback:**
- before step 7: `--revert` (or restore the tar) while paused;
- after step 7: `--revert` publishes as an ordinary edit.

## Phase 4: close out

- Update `status.md`: a dated section recording the release, the receipt path and the counts.
- Delete `plans/soon/001` and `005`. Batch the `git rm` for Joe if auto mode blocks it.
- Update `plans/README.md`, `catalog.md`, `release-and-soak.md` and Filesystem 025.
- Once the rollback window closes, delete the migration directory and the backup.

## Critical files

- `packages/protocol/src/model/{logical-url,node-key}.ts`
- `packages/protocol/src/documents/{directory-document,child-links}.ts`, plus the new `markdown-identity.ts` and `markdown-links.ts`
- `packages/canopyd/src/{public-page,projection,host}.ts`
- `packages/arborsync/src/{workspace-editor,workspace,folder-sync,service,sync-http,node-sampling,filesystem-node-surface}.ts`
- `packages/working-tree/src/node/change-log.ts`
- `packages/protocol/src/updates/{delta,transition-payload,describe}.ts`, `packages/canopyd/src/updates/{transition,tree-diff}.ts`
- `packages/cli/src/{index,daemon-client}.ts`
- `swift/Packages/CanopyAppKit/Sources/CanopyAppKit/{LogicalURL,WorkspaceModels}.swift`, plus the new `MarkdownLinks.swift`
- `swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/{WorkingTree,WorkingTreeSemantics,WorkingTreeModels,WorkingTreeProvider}.swift`
- `swift/Packages/CanopyEditor/Sources/CanopyEditor/{CanopyEditorHost,CanopyEditorWorkspace,MarkdownCodec}.swift`
- `docs/overstory-spec/{02-directory-format,03-locators,08-authoring-api}.md` and `conformance/*.json`

## End-to-end verification

- **Shared vectors:** TS and Swift pass the same ones.
- **Pause/pending/resume:**
  - the `arbor pending` body equals what is submitted;
  - the live pending diff shows only link hrefs in the receipt's files;
  - the dry-run after the migration reports 0.
- **Mac and iPhone:**
  - sibling-document, `_index` and child-row links land correctly;
  - backlink counts match;
  - a rename heals inbound and outbound links;
  - a mention writes `Target.md#arbor-key=…`.
- **canopyd pages:** links render as network locators, and a stale keyed path returns a 308.
