# Arbor data runtime

`@arbor/data` is the reference implementation behind the authored `arbor/data` package surface. Its first delivered slice lowers and executes the checked-in Meaning Supplies queries against SQLite.

The authoring layer builds a closed relational plan by invoking each query callback once with symbolic relation, input, and Arbor-user values. The SQLite layer validates that plan against introspected schema metadata before executing parameterized projected reads. Named, through, and ProfileID-backed relationships come from the store-adjacent `relationships.json` declaration and participate in the schema fingerprint.

`SQLiteQueryEngine.execute` returns the shaped query result, the executed statement trace, SQLite query-plan details, the schema fingerprint, and exact profile tree/ref dependencies. Profile data enters through an injected batch resolver; raw profile trees and the backing database are never returned as query values unless the authored projection explicitly selects safe fields.

Current limits follow the Supplies implementation plan:

- query observation and streaming are Phase 2;
- mutation transactions and durable receipts are Phase 3;
- generated schema-specific authoring types, source-located diagnostics, and document compilation are Phase 4;
- the reference driver is SQLite only.

Run the focused acceptance suite with:

```sh
bun test tests/unit/data-query.test.ts tests/integration/supplies-queries.test.ts
```
