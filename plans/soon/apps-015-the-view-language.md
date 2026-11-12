# Apps 015: Beetle views and mutations

**Why and when:** Joe decided on 2026-11-11 that views and mutations are written in a
declarative language, now Beetle, in `.beetle` files, and TypeScript support for both is dropped. The spec
describes the target ([reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views),
syntax in [the grammar](../../docs/overstory-spec/1.5-beetle.md#8-grammar)). The
reasons, from the thread "Review the Overstory spec with Joe":

- A view's plan comes from its source, so tracing, stand-in rows, dual evaluation and
  plan widening (`missed`) all go away.
- Hosting someone else's view needs no sandbox for arbitrary code.
- Mutations are sets of row operations, so Story can apply them optimistically with the
  same evaluator, and consent can name the rows they write.
- Real code comes back later as [USL plugins](../later/apps-014-usl-plugins.md), which
  extend the data rather than the language.

The explorations that led here are in project files `view-notations/language/`
(`for-where.view`, `for-where-widgets.view`, `games.view`, `mutations.view`). All 13 Supplies
mutations were written in the language there.

This replaces [Apps 013](../../status.md#views-on-the-host-and-declared-views--2026-11-08)
(one plan per view): with static plans, a view has one plan whatever its input.

## Status

**PLANNED · L effort · medium risk.** Before [Apps 011](apps-011-widgets-in-story.md) steps 2
onward, which now draw `.view` widgets instead of running TSX.

## What exists now

- Apps 005's host side runs TypeScript views by tracing: `packages/apps-runtime`
  (`view`, facts, `mutation`, the JSX runtime, `declaredView`), the execution sidecar
  (`packages/overstoryd-exec`, `packages/exec-protocol`), and the SQLite plan engine they share.
- The `QUERY …/views` route takes `form: "value" | "rows" | "tree"` and `missed`, and the
  host is off unless `OVERSTORYD_ACTIVATIONS` is set.
- Supplies' views and mutations are TypeScript (`examples/supplies/views`, `List.tsx` etc.).

## 1. Parser and checker

- `packages/beetle` (`@ovst/beetle`), beside `packages/usl`: parser, formatter, and a checker that
  resolves every table, field and path against the bound schemas, types parameters,
  finds each element's names, and reports source spans.
- The checker rejects a `limit` whose conditions or ordering read state.
- The checker produces the **plan** of each view (its `for`, `where`, paths, `orderBy`,
  `limit`, per element, nested) in the form the existing SQLite plan engine runs, and the
  write set of each mutation.
- Conformance fixtures shared with Swift: source → plan, source → diagnostics.

**Verify:** the Profile, List and Home views and all 13 Supplies mutations from the
exploration check; their plans match what tracing produces today for the same pages.

**Done (2026-11-11):** `packages/beetle` (`@ovst/beetle`; first built as `packages/uvl` for
`.view` files, then reworked when USL and UVL merged into Beetle) parses, formats (`beetle fmt`,
comments kept) and checks `.beetle` files, a collection's `schema.beetle` and pages' view
blocks, with pick-list `use`. A `schema.beetle`'s tables check through `@ovst/usl`
(`compileSchema`), so its layout and fingerprint are USL's: Supplies' `schema.beetle` matches
its `schema.usl`. State tables (`my`/`session`), enum values by name, `if`/`group`, rule
lines and mutation facts are checked. Supplies' Home, Profile, List, Practices, Timer,
Today, cards and all 13 mutations are in `packages/beetle/examples/supplies` and check clean;
`examples/invalid` holds the errors. Plans are Beetle's own nested `ElementPlan`s (rules
expanded, state-reading conditions split off for the client, `expandsBy`), and mutations
report writes, `let` names and public errors. Vectors:
`docs/overstory-spec/conformance/beetle.json`.

**Left in this step:** (lowering an `ElementPlan` to the SQLite engine's `QueryPlan` was
dropped with that engine in step 4.) Then Overstory's own
readers of `schema.usl` (apps-runtime, collection-schema, overstoryd, overstoryd-exec,
story-sync, the Swift readers) switch to `schema.beetle`; external users (cranberries,
excellences, supplies-remake) stay on npm `@ovst/usl` (Joe, 2026-11-11). Existing trees'
`schema.usl` files get a one-off conversion that Joe runs.

## 2. Evaluator, on the host

- Evaluate a view over a plan's rows into a view tree, with expansion, fallbacks, state
  values and the built-ins of spec §15.6.
- Run a mutation: resolve model parameters, check guards, compute the operations against
  the snapshot, and submit one guarded row-only update. No sidecar: overstoryd runs the
  evaluator in process, since no general-purpose code runs.
- The views route answers `rows` and `tree`; `value` and `missed` go. Requests carry no
  state: the checker splits each read into the host's plan and the conditions that read
  state, which the client evaluates (spec §4.5).
  `GET` of a `.view` file renders HTML.

**Verify:** `tests/integration/host-collections.test.ts` ported to `.view` sources, plus
the no-gap and retry tests unchanged.

**Done (2026-11-11, branch `claude/project-thread-kn7ley`, off the Protocol 003 branch):**
`packages/beetle` has a row store over a collection's database layout (`store.ts`), an
evaluator for view trees and data views (`eval.ts`) and a mutation runner (`mutate.ts`);
see its README. overstoryd runs them in process for the trees `OVERSTORYD_BEETLE` names
(`beetle-host.ts`): the views route streams a `.beetle` file's, page's or schema's view
over the accepted rows and answers again on each accepted update to the tree (or to a
profile it drew); the mutate route checks the file at the head, runs the mutation as its
caller, diffs the rows into row operations and submits one update guarded on that head,
with receipts (`rows`, `affected`) kept in `<dataRoot>/beetle/receipts.sqlite3`, retries
and a rerun when the head moved. Public errors answer 401/403/404/422/409. Tests:
`tests/unit/beetle-eval.test.ts` (Supplies' views and all 13 mutations) and
`tests/integration/beetle-host.test.ts`.

**Left in this step:** the `rows` answer form (refused for now with
`unsupported-operation`), HTML for a browser `GET`, finer live dependencies than "the
tree changed", collections in another tree than the view's, and a row created and
edited in the same millisecond (its `modified` can't move, so the diff refuses it).

## 3. Evaluator, in Story

- A Swift port of the checker's plan and of the evaluator, sharing the conformance fixtures.
- Story evaluates views over Story Sync's local rows on a placed tree, or over a `rows`
  answer from the host, and applies mutations optimistically with the same evaluator.
- `state` and `keep` per spec §4.5; session models in memory.

**Verify:** the fixtures pass in both stacks; a state change redraws without a request.

## 4. Port Supplies and remove the TypeScript path

**Done** (2026-11-11, branch `claude/project-thread-kn7ley`). Supplies is one Beetle tree,
`packages/beetle/examples/supplies` (its store and `scripts/seed-fixture.ts` moved there;
`examples/` is gone). Removed: the TSX/MDX Supplies, `packages/overstoryd-exec`,
`packages/exec-protocol`, overstoryd's sidecar process, activations and SQLite
materializations (`collections.ts`), `OVERSTORYD_ACTIVATIONS`, and every part of
`packages/apps-runtime` except Story Sync's projection-provider types and SQLite
introspection. `serveHost({ beetle })` replaces `serveHost({ collections })`.

The TypeScript SQLite plan engine went too. Joe wants reads in SQL (2026-11-12, and chose
the host's SQLite copies first), so Beetle reads SQLite itself instead: `@ovst/beetle/sqlite`
(`SQLiteStore`, with `introspectStoreSchema` moved in) answers the evaluator's reads with
SQL, narrowing a `for` over a table by its conditions on the table's own columns, with
`orderBy` and `limit` when all of it can be stated (`RowQuery`). The host keeps a SQLite
copy per collection (`beetle-materialized.ts`), caught up to the head before a view
reads it from only the chunks that changed. Mutations run over the same copies: writes go
into an `OverlayStore`, and row operations come from the touched rows (`editedLogical`). The in-memory store stays, for collections not in SQLite and as the
reference (`beetle-eval.test.ts` checks both answer every Supplies view the same).
`apps-runtime` is gone: the projection-provider types live in story-sync. Left: idle copies
are never evicted. Reads are one statement per table a view ranges over, with every
relationship it follows nested as JSON (read shapes); folding a view's several tables into
one statement is possible but not done. Joe noted the overstoryd/Beetle
interface should differ from the first cut; the row-store contract is that change. Host
declared views (`~views` served by the sidecar's built-in list view) went with it: a
`view` in `schema.beetle` replaces them (`data/schema.beetle?view=ByOwner`), and Story's
own `~views` presentation is unchanged. `host-collections.test.ts`'s cases that still
apply (a device's edit reaching a view, a schema's view, a profile edit) are in
`beetle-host.test.ts`.

## 5. Views as nodes, and view blocks in pages

Joe decided on 2026-11-11 that a `.view` file is a node's body, like a `.md` file, so
`List.view` answers at `List`, and that pages may hold fenced `view` blocks
([locators §7](../../docs/overstory-spec/1.6-locators.md#7-view-addresses),
[§3.7](../../docs/overstory-spec/1.5-beetle.md#37-view-blocks-in-pages)).

- Node mapping in both stacks (`packages/protocol` pages and path reads, Swift
  `ProtocolPage`/`ProtocolPathRead`): `x.view` and `x/_index.view` supply node `x`;
  `x.md` beside `x.view` reports `duplicate-node-representation` and reads the Markdown.
  Conformance vectors for the new spellings.
- A page's view blocks as one source: code version over the blocks' text only, `page`
  (properties, `name`, `children`), unnamed views addressed internally as `#n`, named ones
  as `Page?view=Name`.
- Story draws view blocks in place, and shows the source while editing.

## 6. Editor support

- **Done:** `packages/beetle/editors`: a tree-sitter grammar with highlight, outline and
  bracket queries, a Zed extension built from it, and a VS Code extension (TextMate)
  that also colors ` ```view ` and ` ```beetle ` blocks in Markdown. The `beetle` CLI
  already checks and formats.
- **Left:** highlighting in Story's code blocks and view blocks (Quagmire's code row is
  plain text today), with step 3's Swift work on Joe's Mac; a language server later.

## Open questions

- The UI language's vocabulary (element types, controls, `Canvas` drawing) is
  [Apps 011](apps-011-widgets-in-story.md)'s package; the language only fixes how elements
  are written.
- Where kept page and personal rows are stored (spec §4.5 leaves it open), decided in
  Apps 011 step 4.
- Durable workflows and combined author/user authority
  ([Apps 006](../later/apps-006-durable-authoring.md)) need a design in the language.

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md` and delete the plan.
