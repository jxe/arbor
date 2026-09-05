# Security 001: Stop rendering search excerpts as raw HTML

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/stores/src/indexer.ts packages/render/src/App.tsx packages/core/src/protocol.ts`
> Note the working tree was already dirty when this plan was written, so also
> run `git status --short` on those paths. If the excerpts under "Current
> state" do not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

The workspace search index builds each result excerpt with SQLite FTS5's
`snippet()` function, which splices `<mark>` tags into raw document text and
escapes nothing. Arbor web then renders that string through
`dangerouslySetInnerHTML`. Any indexed Markdown file whose body contains HTML
therefore executes script inside the arborsync origin as soon as a search matches
it — and that origin has unauthenticated read and write access to the user's
filesystem through `/v1/node`, `/v1/file`, and `/v1/mutations`.

The dangerous case is not a user's own notes. Trees synced from a community are
written to disk by `materializeTree` and indexed like any other file, so a page
authored by someone else becomes script execution in the reader's local UI.
After this plan, excerpt text is inert data and the highlight is produced by
React elements rather than by an HTML string.

## Current state

Files involved:

- `packages/stores/src/indexer.ts` — SQLite FTS5 index; `search()` produces the excerpt.
- `packages/render/src/App.tsx` — Arbor web shell; renders the search results list.
- `packages/core/src/protocol.ts` — shared protocol types; `SearchResult` shape crosses the REST boundary.

The excerpt is produced at `packages/stores/src/indexer.ts:136-143`:

```ts
  search(query: string, limit = 30, offset = 0): SearchResult[] {
    const escaped = query.trim().split(/\s+/).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" ");
    if (!escaped) return [];
    const rows = this.database.query(
      "SELECT path, title, snippet(docs, 2, '<mark>', '</mark>', '…', 24) AS excerpt, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ? OFFSET ?",
    ).all(escaped, limit, offset) as Array<{ path: string; title: string; excerpt: string; rank: number }>;
    return rows.map((row) => ({ path: row.path, title: row.title, excerpt: row.excerpt, score: -row.rank }));
  }
```

It is consumed at `packages/render/src/App.tsx:951`, inside the search results
`.map(...)` — the relevant fragment is the final `<span>`:

```tsx
      {results.map((result) => <button key={result.url} onClick={() => { navigate(result.url); setSearchOpen(false); }}><strong>{result.title}</strong><small>{home && result.url.startsWith(home) ? `~${result.url.slice(home.length)}` : result.url}</small><span dangerouslySetInnerHTML={{ __html: result.excerpt }} /></button>)}
```

Repo conventions to match:

- Dense, single-statement-per-line TypeScript; no semicolon-free style; long
  lines are normal in this repo. Match the surrounding density rather than
  reformatting.
- Types shared across the REST boundary live in `packages/core/src/protocol.ts`.
  If you change the wire shape of a search result, change it there, not in a
  local interface.
- Unit tests live in `tests/unit/*.test.ts` and use `bun:test`. Use
  `tests/unit/journal.test.ts` as the structural exemplar: `describe`/`test`,
  `mkdtemp` into `tmpdir()` for on-disk fixtures, and an `afterEach` that
  removes created directories.
- `packages/stores/src/indexer.ts` already styles highlight markup with the
  `<mark>` element; the CSS for search results lives in
  `packages/render/src/styles.css` (search for `search` selectors). Preserve
  the visual result — highlighted match inside the excerpt.

## Commands you will need

| Purpose   | Command                                        | Expected on success            |
|-----------|------------------------------------------------|--------------------------------|
| Typecheck | `bun run typecheck`                            | exit 0, no output              |
| Tests     | `bun test`                                     | all pass (155 before this plan)|
| One file  | `bun test tests/unit/indexer.test.ts`          | all pass                       |
| Build web | `bun run build:web`                            | exit 0                         |

Do **not** run `bun install`, `bun run build`, or any command that starts a
long-lived server.

## Scope

**In scope** (the only files you should modify):

- `packages/stores/src/indexer.ts`
- `packages/render/src/App.tsx`
- `packages/core/src/protocol.ts` (only if you change the `SearchResult` shape)
- `tests/unit/indexer.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `packages/arborsync/src/service.ts` — the `searchPage` method only forwards
  results; it needs no change and touching it widens the diff.
- The FTS5 schema and the `rebuild`/`indexFile` methods — indexing behavior is
  the subject of a separate plan ([Speed 001](../speed/001-index-updates.md)). Changing the schema here will
  collide with it.
- `packages/render/src/PageEditor.tsx` and `blocks.tsx` — unrelated rendering
  surfaces.
- Any other `dangerouslySetInnerHTML` site you may find; if one exists outside
  `App.tsx:951`, report it rather than fixing it here.

## Git workflow

- Branch: `insecure/001-search-excerpts`
- Commit message style matches `git log`: a short imperative sentence with no
  prefix or scope, e.g. `Escape search excerpts before rendering them`.
- Do NOT push or open a PR.

## Steps

### Step 1: Return structured excerpt ranges instead of an HTML string

In `packages/stores/src/indexer.ts`, change the `snippet()` call to emit
sentinel delimiters that cannot occur in HTML-significant positions, then
convert them into structure before returning.

Use a sentinel pair that is vanishingly unlikely in document text and is not
HTML — for example `` (start of text) and `` (end of text):

```ts
const MARK_START = "";
const MARK_END = "";
```

Pass those to `snippet(docs, 2, ?, ?, '…', 24)` — bind them as parameters or
inline them; either is fine, but the two `<mark>`/`</mark>` literals must be
gone from the SQL.

Then split the returned excerpt into a `SearchExcerptSegment[]`:

```ts
export interface SearchExcerptSegment { text: string; match: boolean }
```

Write a small exported helper in the same file, e.g.
`export function splitExcerpt(raw: string): SearchExcerptSegment[]`, that walks
the string and produces alternating segments, marking the ones that sat between
`MARK_START` and `MARK_END`. Strip any stray unpaired sentinel characters from
the output text so they never reach the client.

Have `search()` return `excerpt` as the segment array. Update the
`SearchResult` type — it is declared in `packages/core/src/protocol.ts`; find it
with `grep -rn "SearchResult" packages/core/src/protocol.ts` and change the
`excerpt` field's type there, exporting `SearchExcerptSegment` alongside it.
If `SearchResult` turns out to be declared in `packages/stores/src/indexer.ts`
instead, declare `SearchExcerptSegment` in `packages/core/src/protocol.ts`
anyway, since the value crosses the REST boundary.

**Verify**: `bun run typecheck` → exits non-zero, with errors *only* at the
consumer in `packages/render/src/App.tsx` (and any other consumer of
`result.excerpt`). That is expected at this step; step 2 fixes it. Record which
files errored — if a file outside the In-scope list errors, that is a STOP
condition.

### Step 2: Render the excerpt as React elements

In `packages/render/src/App.tsx:951`, replace the
`<span dangerouslySetInnerHTML={{ __html: result.excerpt }} />` with a span
whose children are produced from the segment array:

```tsx
<span>{result.excerpt.map((segment, index) => segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</span>
```

Keep it on one line to match the surrounding style.

**Verify**: `bun run typecheck` → exit 0, no output.

**Verify**: `grep -rn "dangerouslySetInnerHTML" packages/` → no matches.

### Step 3: Add a regression test

Create `tests/unit/indexer.test.ts`, modeled structurally on
`tests/unit/journal.test.ts` (bun:test, `mkdtemp` fixture, `afterEach` cleanup).

Build a `WorkspaceIndex` against a temporary root and database path — check the
constructor signature at `packages/stores/src/indexer.ts:63`
(`constructor(private root: string, databasePath: string)`) and the export name
in `packages/stores/src/index.ts`. Write a Markdown file into the temp root
whose body contains angle-bracket markup alongside a searchable word, index it
(via `rebuild()` or `updateAbsolute()` — whichever the existing API makes
straightforward), then call `search()` for that word.

Assert:

1. The concatenation of all segment `text` values contains the literal
   angle-bracket characters from the source document (they survived as text).
2. No segment's `text` contains `` or ``.
3. At least one segment has `match: true` and its text contains the query term.
4. `splitExcerpt("plain text")` returns a single segment with `match: false`.

Call `index.close()` in a `finally` or `afterEach` so the SQLite handle is
released.

**Verify**: `bun test tests/unit/indexer.test.ts` → all tests pass.

### Step 4: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass, with at least 2 more tests than before.

**Verify**: `bun run build:web` → exit 0 (confirms the JSX change compiles in
the real Vite build).

## Test plan

- New file `tests/unit/indexer.test.ts` with the four assertions in step 3.
  The load-bearing one is assertion 1 + 2 together: markup in a document body
  reaches the client as inert text, and no sentinel leaks.
- Structural pattern: `tests/unit/journal.test.ts`.
- The existing e2e suite (`tests/e2e/browser.e2e.ts`) exercises search in a
  browser. You are not required to run Playwright (it needs a browser binary),
  but if `bun run test:e2e` is already available in your environment, run it
  and confirm no search test regressed.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0 and includes the new `tests/unit/indexer.test.ts` cases
- [ ] `bun run build:web` exits 0
- [ ] `grep -rn "dangerouslySetInnerHTML" packages/` returns no matches
- [ ] `grep -n "<mark>" packages/stores/src/indexer.ts` returns no matches
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `plans/README.md` entry for Security 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `packages/stores/src/indexer.ts:136-143` or
  `packages/render/src/App.tsx:951` does not match the excerpts above.
- `SearchResult` turns out to be consumed by the Swift client under `native/`
  (check with `grep -rn "excerpt" native/`). Changing a cross-language protocol
  shape requires updating the Swift client and the fixtures under
  `conformance/`, which is outside this plan's scope — report and
  stop, since a smaller fix (escape to an HTML string server-side) may be
  preferable in that case.
- Typecheck after step 2 reports errors in files outside the In-scope list.
- You find a second `dangerouslySetInnerHTML` site.

## Maintenance notes

- The sentinel characters are an internal detail of `search()`. If FTS5's
  `snippet()` is ever replaced with a hand-rolled excerpt builder, the
  segment-returning contract should survive — the point is that the boundary
  returns structure, not markup.
- A reviewer should check that no code path reintroduces string concatenation
  of excerpt text into HTML, and that the `<mark>` styling in
  `packages/render/src/styles.css` still applies (the element is now created by
  React rather than parsed from a string, but the selector is unchanged).
- Deliberately deferred: the broader question of whether synced community
  content should be indexed at all, and whether arborsync should send a
  `Content-Security-Policy`. Both are real, both are larger than this fix.
