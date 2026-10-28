# Schema language 009: change a collection's schema and keep its rows

**Timing:** Later.

**Why and when:** a collection's `schema.usl` will change while it holds rows people care
about, and consumers (Story, Story Sync's projections, sites reading through cranberries) may
still expect the older shape. Today nothing carries rows across a schema change. The People
directory shows the cost: until it has migrations, a seed bump replaces Joe's directory and
empties it ([People 001](people-001-groups-sharing-and-go-to.md), phase 1's loose ends). This
was open question 6 in [candidates](../candidates.md); Joe made it a feature in later on 2026-10-28.

## Status

- **Effort:** M to L.
- **Risk:** MEDIUM. A migration rewrites rows in a tree, and mounted consumers may read either
  shape for a while.
- **State:** TODO, not designed.

## What USL meant

USL ([spec 11](../../docs/overstory-spec/11-schema-language.md)) meant migrations between
relation forms to be small edits to one declaration: change the storage, widen or narrow an
arity (`Episode.series` to many), promote a value array to a model and a connection, or grow
an `enum` into a `seed` model. None is built; Joe deferred a migration diff on 2026-10-14.

## Questions to settle first

- How a schema change carries its rows: a diff computed from the two schemas, a migration
  written by hand, or both.
- How mounted consumers keep working on the older shape while a tree or external database
  changes schema.
- The first customer: the directory's seed bumps, so a views-only or additive change stops
  emptying it.
