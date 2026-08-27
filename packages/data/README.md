# Arbor data runtime

`@arbor/data` is the reference implementation behind the authored `arbor/data` package surface. Its first delivered slice lowers and executes the checked-in Meaning Supplies queries against SQLite.

The authoring layer builds a closed relational plan by invoking each query callback once with symbolic relation, input, and Arbor-user values. The SQLite layer validates that plan against introspected schema metadata before executing parameterized projected reads. Named, through, and ProfileID-backed relationships come from the store-adjacent `relationships.json` declaration and participate in the schema fingerprint.

`SQLiteQueryEngine.execute` returns the shaped query result, the executed statement trace, SQLite query-plan details, the schema fingerprint, and exact database/profile dependencies. Every execution owns one read-only SQLite connection and transaction, so concurrent live queries cannot interleave statements across snapshots. Profile data enters through an injected batch resolver; raw profile trees and the backing database are never returned as query values unless the authored projection explicitly selects safe fields.

`SQLiteStoreBroker` owns Arbor writes and installs connection-local transactional triggers. It emits ordered row keys, changed fields, and before/after values only after the outer transaction commits; rolled-back writes emit nothing. A filesystem revision/WAL watcher uses SQLite's supported `data_version` signal to conservatively invalidate the whole store for writes made by another connection.

`LiveQueryBroker` derives relation/field/predicate/correlation sensitivity from normalized query plans and combines it with exact rows and profile refs observed during execution. Streams attach their listener before the initial snapshot, rerun across old and new dependencies when a change races execution, coalesce bursts, hash canonical output, and publish complete replacements only. `RegisteredQueryRuntime` validates a versioned document and complete mounted handle graph before serving the stateless stream.

Current limits follow the Supplies implementation plan:

- mutation transactions and durable receipts are Phase 3;
- generated schema-specific authoring types, source-located diagnostics, and document compilation are Phase 4;
- the reference driver is SQLite only.

Run the focused acceptance suite with:

```sh
bun test tests/unit/data-query.test.ts tests/integration/supplies-queries.test.ts tests/integration/data-live-query.test.ts tests/integration/query-stream-api.test.ts
```
