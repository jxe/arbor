# Apps 012: One kind of view

**Why and when:** soon (Joe moved it from later on 2026-11-07), after [Apps 005](../soon/apps-005-views-on-the-host.md). Joe wants USL
`~views` and views written in code to be one concept, both in Story and in overstoryd. He
agreed on 2026-11-06 that this isn't needed now.

The spec already describes the target:
- [Executable documents §4.1](../../docs/overstory-spec/07-executable-documents.md#41-views)
  makes a `~views` entry a **declared view**: the built-in list view with that entry's
  settings.
- [§12.1](../../docs/overstory-spec/07-executable-documents.md#121-evaluate-and-stream-views)
  names both kinds with one `HandleRef` (tree, path, name, version).
- [Schema language §8](../../docs/overstory-spec/11-schema-language.md#8-views) points there.

## Status

**PLANNED · M effort · low risk.**
- Needs Apps 005's views and route.
- Coordinates with
  [Schema language 007](../features/schema-language-007-editing-in-the-collection-view.md)
  (editing in the collection view) and
  [People 001](../features/people-001-groups-sharing-and-go-to.md), both of which draw
  declared views.

## What exists now

- `packages/usl/src/present.ts` (`presentView`) and StoryKit's `PresentedView.swift` turn a
  collection's rows and one `~views` entry into lines and groups.
- Story draws that result natively. Story Sync supplies the rows from the placed tree.
- overstoryd doesn't serve declared views at all.

## 1. The built-in list view

- Write the built-in list view as a view over the model (Apps 005's runtime), so it has a
  plan like any other view.
  - Its plan is the model's rows plus the fields and connections that the entry's line,
    group, sort and paths reach.
  - Its result is `presentView`'s.
- Story's native list stays the renderer for it. Only where the rows and the presentation
  come from changes.

**Verify:** `tests/unit/presented-views.test.ts` vectors give the same presentations through
the built-in view as through `presentView` directly. The plan reads no field the entry
doesn't use.

## 2. Served like any view

- The sidecar and the query route answer a `HandleRef` whose path is a schema.
- They use the same authority, live replacement stream and output hash as an authored view.
- No code activation is needed, because the built-in view is host code. Reads follow the
  caller's access now, and the tree's rules once Apps 010 lands.
- On a placed tree, Story Sync answers the same request locally, so Story asks for a
  declared view the same way it asks for an authored one.

**Verify:** a declared view and an equivalent authored view stream the same rows and
update on the same row changes. A reader without access to a row doesn't receive it in
either.

## 3. Story draws both the same way

- A page that presents a collection (the
  [pages that present other collections](../spec-extensions/pages-that-present-other-collections.md)
  extension, once settled) and a `.tsx` widget embed share placement identity and menus.
- An authored view can include a declared view as a component, for example an app's own
  page that shows its collection "By status".
- Row actions in the built-in list come from the app's `mutation.for(Model, op)` when it has
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
