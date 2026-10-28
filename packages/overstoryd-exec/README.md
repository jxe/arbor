# @ovst/overstoryd-exec

overstoryd's execution sidecar. It runs named queries and mutations: queries on the
SQLite materializations overstoryd keeps, and mutations as a rolled-back trial there,
committed as a guarded, row-only update through the standard Overstory API with an
execution token overstoryd issues for the one question. It keeps the mutation receipts.

overstoryd starts it as `bun packages/overstoryd-exec/src/cli.ts --handles <module>
--materialized <dir> --state <dir> --host <origin>` and asks it questions one JSON line
at a time. [The execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md)
is the whole API; the types are in `@ovst/exec-protocol`.

A handles module exports `queries` and `mutations`, each a list of
`{ ref: { module, export, version }, handle, collection, authoredRoot }`: the handle,
the collection directory's path in its tree, and the `node()` path its code names
that collection by.
