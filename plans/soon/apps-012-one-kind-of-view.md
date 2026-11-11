# Apps 012: Story asks for declared views like any view

**Why and when:** Joe wants USL `~views` and views written in code to be one concept, both in
Story and in overstoryd. The host side is built
([status](../../status.md#views-on-the-host-and-declared-views--2026-11-08)): a `~views` entry
is the built-in list view, served through the same route as an authored view. What's left is
Story's side.

The spec describes the target:
- [VAD](../../docs/overstory-spec/1.5-vad.md#3-views)
  makes a `~views` entry a **declared view**.
- [reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views)
  names both kinds with one `HandleRef`: for a declared view, the collection's `schema.usl`,
  a label, and the schema file's hash.

## Status

**PLANNED · M effort · low risk.**
- Coordinates with
  [Schema language 007](../features/schema-language-007-editing-in-the-collection-view.md)
  (editing in the collection view) and
  [People 001](../features/people-001-groups-sharing-and-go-to.md), both of which draw
  declared views.

## What exists now

- `declaredView` (`packages/apps-runtime/src/declared.ts`) is the built-in list view: it
  reads the tables an entry reaches through plans and answers `presentView`'s lines and
  groups. It takes `{ query }` as input.
- overstoryd and the sidecar answer a `HandleRef` whose path is a `schema.usl`, with no
  activation (`tests/integration/host-collections.test.ts`).
- Story draws `presentView`'s result natively (`PresentedView.swift`), from rows Story Sync
  reads from the placed tree.
- `presentView` refuses a line that shows a model whose key has several columns, such as
  Supplies' default line (`items`).

## 1. Story Sync answers locally

- On a placed tree, Story Sync answers the same views request from its own SQLite stores,
  so Story asks for a declared view the same way it asks for an authored one.

**Verify:** a declared view streams the same lines from Story Sync as from the host, and
updates on the same row changes.

## 2. Story draws both the same way

- A page that presents a collection (the
  [pages that present other collections](../spec-extensions/pages-that-present-other-collections.md)
  extension, once settled) and a `.view` widget drawn from a view block share placement identity and menus.
- An authored view can draw a declared view as an element, for example an app's own
  page that shows its collection "By status".
- Row actions in the built-in list come from the app's row-action mutations
  (`mutation … for Model.op`, [VAD §4.1](../../docs/overstory-spec/1.5-vad.md#41-facts)) when it has
  them, and otherwise from plain row edits (Schema language 007).

**Verify:** the People directory and the games sandbox look and edit the same before and
after. When this step lands, a hand check on Joe's Mac goes to [Joe's to-do](../joe.md).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md`, trim steps as they land, and delete
the plan when only Joe's items are left.

Not here:
- Page-shared layouts for authored views. These were dropped from the first cut of
  [Apps 011](apps-011-widgets-in-story.md).
- An arrangement model.
