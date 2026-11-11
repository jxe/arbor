# Projection providers and store introspection

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

`apps-runtime` was the TypeScript executable-document runtime: query plans, live
results and transactional mutations for views written in TSX. Beetle replaced it
([Apps 015](../../../plans/soon/apps-015-the-view-language.md)): views and mutations are
`.beetle` files, checked and interpreted by [`@ovst/beetle`](../../../packages/beetle/README.md),
and overstoryd runs them in process over a tree's accepted rows.

What is left is what Story Sync's collection projections use:

- `collections/`: the projection-provider contract types.
- `src/schema.ts`: `introspectStoreSchema` reads a SQLite store, checks it against its
  `schema.beetle`'s database layout, and derives its relationships from the schema's
  connections, with people as the virtual `Person` relation.

Collection schemas are not executed here or anywhere: they are declarative
`schema.beetle` files interpreted by [`collection-schema`](../collection-schema/README.md).
