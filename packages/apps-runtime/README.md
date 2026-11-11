# @ovst/apps-runtime

What is left of the TypeScript executable-document runtime after Beetle replaced it
(Apps 015): the pieces Story Sync's collection projections use.

- `@ovst/apps-runtime/collections`: the projection-provider contract types
  (`ProjectionDefinition`, `ProjectionProviderError`, and the records a provider reads
  and writes).
- `@ovst/apps-runtime`: SQLite store introspection (`introspectSQLiteDatabase`,
  `introspectStoreSchema`), which reads a `_store.sqlite3`'s tables and checks them
  against the collection's `schema.beetle`.

Views and mutations are Beetle files now ([packages/beetle](../beetle/README.md)), run
in process by overstoryd's Beetle host.
