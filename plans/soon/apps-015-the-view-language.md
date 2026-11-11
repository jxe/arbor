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
- Real code comes back later as plugins ([client](../later/apps-014-client-plugins.md), [pure](../later/apps-016-pure-plugins.md), [host](../later/apps-017-host-plugins.md)), which
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

- `packages/vad` (`@ovst/vad`), beside `packages/usl`: parser, formatter, and a checker that
  resolves every table, field and path against the bound schemas, types parameters,
  finds each element's names, and reports source spans.
- The checker rejects a `limit` whose conditions or ordering read state.
- The checker produces the **plan** of each view (its `for`, `where`, paths, `orderBy`,
  `limit`, per element, nested) in the form the existing SQLite plan engine runs, and the
  write set of each mutation.
- Conformance fixtures shared with Swift: source → plan, source → diagnostics.

**Verify:** the Profile, List and Home views and all 13 Supplies mutations from the
exploration check; their plans match what tracing produces today for the same pages.

**Done (2026-11-11):** `packages/vad` (`@ovst/vad`; first built as `packages/uvl` for
`.view` files, then reworked when USL and UVL merged into Beetle) parses, formats (`beetle fmt`,
comments kept) and checks `.beetle` files, a collection's `schema.beetle` and pages' view
blocks, with pick-list `use`. A `schema.beetle`'s tables check through `@ovst/usl`
(`compileSchema`), so its layout and fingerprint are USL's: Supplies' `schema.beetle` matches
its `schema.usl`. State tables (`my`/`session`), enum values by name, `if`/`group`, rule
lines and mutation facts are checked. Supplies' Home, Profile, List, Practices, Timer,
Today, cards and all 13 mutations are in `packages/vad/examples/supplies` and check clean;
`examples/invalid` holds the errors. Plans are Beetle's own nested `ElementPlan`s (rules
expanded, state-reading conditions split off for the client, `expandsBy`), and mutations
report writes, `let` names and public errors. Vectors:
`docs/overstory-spec/conformance/vad.json`.

**Left in this step:** lowering an `ElementPlan` to the SQLite engine's `QueryPlan`, and
comparing those plans with what tracing produces for the TSX pages. Then Overstory's own
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

## 3. Evaluator, in Story

- A Swift port of the checker's plan and of the evaluator, sharing the conformance fixtures.
- Story evaluates views over Story Sync's local rows on a placed tree, or over a `rows`
  answer from the host, and applies mutations optimistically with the same evaluator.
- `state` and `keep` per spec §4.5; session models in memory.

**Verify:** the fixtures pass in both stacks; a state change redraws without a request.

## 4. Port Supplies and remove the TypeScript path

- Supplies' views and mutations become `.view` files.
- Delete TypeScript authoring: `view`, facts, `mutation` and the JSX runtime in
  `packages/apps-runtime`, tracing and widening, and the execution sidecar if nothing else
  uses it. Keep the plan engine.
- [Apps 010](../later/apps-010-activation-and-lending.md)'s execution tokens apply to
  the in-process evaluator instead of the sidecar.

**Verify:** `bun run typecheck`, `bun run test`, `bun run test:protocol`; nothing imports
the removed modules.

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

- Syntax highlighting for `.view` in Story's code blocks and for VS Code and Zed, and
  `story check <tree-or-path>` running the checker. A language server later.

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
