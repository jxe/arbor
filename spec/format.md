# On-disk format
*Part of the [Arbor spec](../spec.md): what lives in a workspace — files, directories, databases, scripts, links, and sidecars.*

## 1. Nodes and stores

A node is a logical workspace address with an optional body path and directory path. `x.md` supplies `/x`'s body, while a sibling `x/` supplies `/x`'s children. If `x.md` is absent, `x/_index.md` is the fallback directory body. Browser routes, API paths, search results, links, generated tree types, breadcrumbs, and visible names always use the extensionless logical path `/x`.

- A **Markdown document** has YAML frontmatter for props and a Markdown body. Each materialized document carries an opaque durable `id` in its frontmatter, minted at creation (or when identity is first required for existing content) — the document's stable identity across renames. REST v1 calls this a `PageID`. Existing Arbor and Clamshell documents use six-character IDs, but the format does not require a fixed length or alphabet.
- A **directory document** has children in `x/`; its stored body and props come from sibling `x.md`, falling back to `x/_index.md`, or from an empty implicit body when neither exists. TreeHopper projects that body together with every immediate child into one complete editable document (§4).
- A **collection** is a folder of records. Its backing is declared *inside* the folder — `_store.csv`, `_store.jsonl`, multiple Markdown row files, a known-name `_store.sqlite3` database, or a known-name `_store.postgres` connection reference — and can change without the folder's path, page, schema, or views changing. A folder whose store holds several tables is a database container: each table appears as a child collection.
- A **script** is a `.tsx` file that may colocate React components, queries, and mutations.

The filesystem driver is the default store, not a universal storage requirement. Arbor presents one tree API over heterogeneous stores. A store driver supplies schema inspection, reads, transactions, change observation, consistent snapshots, and materialization where meaningful. Data should remain inspectable with ordinary tools appropriate to its store: `cat` for Markdown, SQLite tools for `.sqlite3`, and a SQL client for Postgres.

`x.md` and `x/` may and normally do coexist: together they are one logical node, and directory listings collapse them into one child. Giving `/x` its first child creates `x/` and leaves `x.md` in place. Merely browsing a bodyless directory does not create `x/_index.md`; the first authored body/property edit, authored ordering that needs storage, or operation that must establish durable document identity materializes it. Only `x.md` plus `x/_index.md` is ambiguous; Arbor reports a blocking `duplicate-body-representation` diagnostic and refuses content or structural mutations until one body is explicitly retained. Rename, move, copy, trash, and restore treat a sibling body plus directory as one logical unit, and occupied destinations reject without overwrite, merging, or suffixing.

## 2. SQLite by placement

Putting `_store.sqlite3` inside a folder makes that folder database-backed. Arbord opens it through the SQLite driver, introspects its tables for type generation, watches committed changes, and supplies built-in table views. If the folder has a `schema.ts`, the folder *is* a collection: the store supplies its rows from the table matching the folder's name (or the sole table), and no Arbor-specific database manifest is required. Otherwise the folder is a database container: `tracker/_store.sqlite3` with tables `tasks` and `tags` yields the child collections `/tracker/tasks` and `/tracker/tags`.

Because the backing is a detail of the folder rather than a node of its own, migration is transparent: replace a collection's row files with `_store.sqlite3` (or the reverse) and the folder keeps its path, `_index.md`, `schema.ts`, views, and every query and mutation pointed at it.

The file remains canonical. It can be opened by ordinary SQLite software and materialized on another machine. Arbor must take consistent snapshots through SQLite's backup/checkpoint facilities rather than copying live database and WAL files naïvely. A `.sqlite3` file under any other name is still recognized and browsable as a database node under its filename; the `_store` convention is what lets a folder absorb a database as its backing.

## 3. External database references

An external database backs a folder the same way, through a small, non-secret known-name reference:

```yaml
# reports/_store.postgres
driver: postgres
connection: system:connections/production
schema: public
```

The referenced `system:connections` record holds a friendly label and safe metadata; its connection string or password lives in the platform credential store. Typegen introspects the database through that record. The Postgres server remains the data authority, so Arbor synchronizes the reference—not a redundant copy of the database. Offline Postgres snapshots or mirrors are not specified. Graduating a collection from `_store.sqlite3` to `_store.postgres` is one file swap; nothing pointed at the folder changes.

## 4. Projected directory documents and links

TreeHopper presents every directory as one complete document even when no Markdown body exists on disk. The projection is:

1. the stored body blocks and frontmatter, or an empty implicit body;
2. each immediate physical child exactly once;
3. the first eligible authored standalone link to each immediate child in its authored position;
4. synthetic managed child rows for otherwise unmentioned children, appended in stable directory order.

Additional links to the same child remain ordinary authored links; only one row owns structural placement. The projection is a client/session view over arbord's authoritative node snapshot plus its complete paginated child listing. It is not a second canonical Markdown serialization. Managed rows retain out-of-band identity — block ID, target `NodeRef` (including `PageID` when present), child kind, authored/synthetic origin, and materialization state — so an editor cannot accidentally turn a structural child into anonymous prose. Web may use its internal `standaloneLink` block while native may render Hunch's existing subpage row; neither requires a new visible Markdown link syntax.

Authored prose and properties write the stored Markdown body. Reordering, moving, renaming, copying, trashing, or restoring managed rows invokes structural operations with directory preconditions and anchors. A document session must split those intentions before persistence; arbord never infers a filesystem mutation from an undifferentiated write of the projected block array. Source view shows the actual stored Markdown and clearly labels projected rows rather than pretending synthetic bytes exist.

Markdown links themselves remain ordinary destinations using Arbor [locators](locators.md). Local links use logical relative paths (`notes`, `../roadmap`) or tree-rooted paths (`/people/alice`); cross-tree links use absolute `arbor://library.example/…` or `arbor://tree/<TreeID>/…` names, optionally with an immutable revision suffix. A link may carry the target document's durable `id` as a fragment (`[Roadmap](../roadmap#x7f3q2)`), and the ID is authoritative when path and ID disagree, so moves do not break identity-bearing inbound links. Arbor's link-insertion and Copy Link surfaces include this fragment for Markdown targets; hand-authored fragment-less links remain valid path-only references. A bodyless directory is minimally materialized when such identity is first required. Stale destinations heal lazily to the target's current readable path plus ID through the normal commit path. Ordinary files remain path-only. Arbor accepts authored `.md`, `/_index.md`, bare public-name, and legacy `tree:` destinations as input aliases but heals them to canonical locator forms.

## 5. Collections, schemas, and generated tree types

A collection has a schema supplied by its backing store:

- A **file-backed collection** is a folder with a `schema.ts` exporting exactly `export const schema = z.object(...)`. It contains exactly one backing shape: one `_store.csv`, one `_store.jsonl`, or multiple Markdown files other than `_index.md`. `_store.csv` uses its header as field names; `_store.jsonl` contains one JSON object per nonblank line; each Markdown file is one record whose user frontmatter conforms. `id`, path, and body are Arbor metadata rather than schema fields. Mixing shapes produces a diagnostic and no collection-level row interpretation, while the source files remain individually browsable.
- A **SQLite-backed folder** contains `_store.sqlite3`; table schemas come from `sqlite_schema`.
- A **Postgres-backed folder** contains a `_store.postgres` reference; table schemas come from catalog introspection.

Database-backed collections retain relational operations—joins, SQL transactions, constraints, and database-wide schema inspection—that do not apply to every collection. This is a specialized interface on the collection, not a separate workspace-node category.

For a file-backed collection, Zod describes rows over the same ordinary files:

```ts
// essays/schema.ts
import { z } from "zod";

export const schema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  tag: z.string(),
  status: z.enum(["draft", "published"]).default("draft"),
});

export type Essay = z.infer<typeof schema>;
```

Arbord validates file-backed collections on change and sync; violations become diagnostics rather than crashes. The specified SQLite and Postgres drivers introspect their child collections. Arbord generates TypeScript declarations mapping workspace paths visible to a script to collection types and, for database-backed collections, their additional relational interface:

`schema.ts` is bundled and evaluated in an isolated QuickJS/Wasm worker. Only `zod` may be imported; filesystem, network, process, and other ambient host capabilities are absent, and execution has explicit time, stack, and memory bounds. A temporary invalid schema leaves the last valid generated declarations in place and adds a diagnostic.

```ts
// .arbor/tree.gen.d.ts — maintained by arbord and wired in through the
// workspace tsconfig; scripts import nothing to get it.
import type { Collection, Database } from "arbor/runtime";
import type { Essay } from "../essays/schema";
import type { Submission } from "../submissions/schema";
import type { TrackerDatabase, ReportsDatabase } from "./database-schema.gen";

declare module "arbor/runtime" {
  interface TreeRegistry {
    "/essays": Collection<Essay>;
    "/tracker": Database<TrackerDatabase>;
    "/tracker/tasks": Collection<TrackerDatabase["tasks"]>;
    "/reports": Database<ReportsDatabase>;
    "arbor://paxmachina.org/inbox": Collection<Submission>;
  }
}

export {};
```

Registry keys are **canonical tree-rooted paths** — the same URL-shaped names Arbor uses everywhere else, rooted at the enclosing shared tree. That is what keeps scripts portable across placements: the whole tree moves together. Because rooted keys are unambiguous tree-wide, one generated file types everything and there is no per-file ceremony: `tree("/essays")` is a `Collection<Essay>` and `tree("/tracker/tasks")` is the collection for the inferred `tasks` table, in any script, with no type imports at all. Relative forms (`tree("./essays")`) remain legal — the compiler resolves them against the script's location — but rooted paths are the blessed, autocompleted form. Ordinary TypeScript inference supplies query arguments, results, component props, and exported handle types; Arbor does not generate a bespoke context interface for each function.

Database schema changes regenerate these declarations just as `schema.ts` changes do. A connection that is unavailable leaves its previous generated types in place, marks them stale, and surfaces a diagnostic rather than destroying editor support.

## 6. Scripts on disk

A script is an ordinary TypeScript/React `.tsx` file that reads, renders, or changes the workspace. It can export components alongside the typed queries and mutations they need. Explicit `query`/`mutation` constructors mark execution boundaries (in the TanStack Start lineage) without introducing a second application language — but each takes a single plain async function rather than a builder chain. Input types are ordinary TypeScript parameter types; the compiler generates runtime boundary validators from them (as Encore.ts does), reusing a Zod schema directly when the parameter type originates from one. Read and write sets are inferred from literal tree paths in the handler body; an explicit `reads`/`writes` option is required only when a path is computed.

“Script” is the authored Arbor concept. Each script is technically an ES module, and the compiler uses normal ES-module imports and exports, but users create, open, link to, and run scripts. Arbor imports come from **one package, `arbor`, with two subpaths**: `arbor/runtime` (constructors and `tree`) and `arbor/react` (hooks). The compiler enforces realms either way — a hook in a handler is a compile error regardless of where it was imported from; the split just keeps the UI surface visually distinct.

```tsx
import { useState } from "react";
import { query, mutation, tree } from "arbor/runtime";
import { useQuery, useMutation } from "arbor/react";

import type { Submission } from "./submissions/schema";

export const recentEssays = query(async ({ tag }: { tag: string }) => {
  return tree("/essays")
    .filter(essay => essay.tag === tag && essay.status === "published")
    .sortBy(essay => essay.date, "desc")
    .take(20);
});

export const submitEssay = mutation(async (submission: Submission) => {
  return tree("arbor://paxmachina.org/inbox").append(submission);
});

export default function ReadingRoom() {
  const [tag, setTag] = useState("governance");
  const essays = useQuery(recentEssays, { tag });
  const submit = useMutation(submitEssay);
  return <EssayList essays={essays} tag={tag} onTagChange={setTag} onSubmit={submit} />;
}
```

`tree(path)` is the scoped data door, valid only inside a query or mutation body; using it elsewhere is a compile error — and it is the *only* door. The same collection surface works over file-, SQLite-, and Postgres-backed collections, so changing a folder's backing never rewrites its queries:

```ts
import { mutation, query, tree } from "arbor/runtime";

// Portable: identical whether /tracker/tasks is row files, SQLite, or Postgres.
export const openTasks = query(async ({ status }: { status: string }) => {
  return tree("/tracker/tasks").filter(task => task.status === status);
});

export const createTask = mutation(async (task: NewTask) => {
  return tree("/tracker/tasks").append(task);
});

// Backing-coupled: the relational escape hatch, only typed on database-backed
// folders and recorded in the manifest as tied to this backing.
export const taskCounts = query(async () => {
  return tree("/tracker").sql
    .selectFrom("tasks")
    .select(["status", eb => eb.fn.countAll().as("n")])
    .groupBy("status")
    .execute();
});
```

Collection predicates (`filter`, `sortBy`, …) are a compiled, analyzable subset of TypeScript, so drivers can push them down — as SQL on database-backed folders, as frontmatter scans on file-backed ones — and a query's cost profile survives a backing change ([scripts.md](scripts.md) §1). `tree(path).sql` exposes joins, transactions, and the rest of a Kysely-like relational builder, but only on database-backed folders: using it is a visible commitment to the backing, and the manifest records the query as backing-coupled.

Compilation and execution semantics — realms, validators, placement, reactivity — are specified in [scripts.md](scripts.md).

An **agent** is also just a markdown file: prompt as body, frontmatter carrying the model, `tools:` as references to mutations, and `context:` as references to queries. Its browser surface is specified in [browser.md](browser.md) §3.

## 7. Sidecars and generated state

A few names inside the tree are conventions rather than content, and a little state deliberately lives outside the tree:

- **`_index.md`** — the fallback stored body, props, and document ID for a directory that has no sibling `x.md` (see §§1, 4). A complete directory document is projected before this file exists; it is materialized only by the first body/property edit, stored ordering requirement, or durable-identity requirement ([browser.md](browser.md) §1).
- **`_store.sqlite3` / `_store.postgres`** — a folder's database backing (see §2–3). Swapping the store file migrates the folder between backings without moving anything else.
- **`_store.csv` / `_store.jsonl`** — the two single-file collection backings. Their fixed names make a later backing swap as explicit as replacing one `_store.*` file with another.
- **`Trash/`** — soft-deleted pages, mirroring the source structure; restore returns a page to its original path ([system.md](system.md) §3).
- **`Assets/`** — pasted images, visible by convention (Notion/Obsidian style) so pages stay portable to any markdown viewer.
- **`.arbor/`** — generated TypeScript declarations (`tree.gen.d.ts`), wired in through the workspace tsconfig; in-tree only because the TypeScript language service must see it.
- **Arbord-private state** — the index, caches, and the write journal live under `~/.arbor/workspaces/`, outside the tree, so they never appear in `grep`, git, sync, or deploys ([system.md](system.md) §3).
