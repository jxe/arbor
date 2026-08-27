# Arbor data runtime

`@arbor/data` is the reference implementation behind the authored `arbor/data` package surface. It lowers the checked-in Meaning Supplies handles and executes the portable child-query subset across ordinary Arbor providers as well as SQLite.

The authoring layer builds a closed plan by invoking each query callback once with symbolic node properties, input, and Arbor-user values. One query-core module defines portable input validation, user requirements, filtering, picking, cardinality, and canonical stable-key ordering. `NodeQueryEngine` samples a resolved parent before paging and returns membership/schema/observation plus row dependencies. Activation binds each literal `arbor(path)` to its complete logical tree/path and schema fingerprint; SQLite rejects an unbound, stale, cross-tree, wrong-root, or wrong-relation source before data access. Its additional named, through, and ProfileID-backed relationships come from the store-adjacent `relationships.json` declaration and participate in the schema fingerprint.

`SQLiteQueryEngine.execute` returns the shaped query result, the executed statement trace, SQLite query-plan details, the schema fingerprint, and exact database/profile dependencies. Every execution owns one read-only SQLite connection and transaction, so concurrent live queries cannot interleave statements across snapshots. Profile data enters through an injected batch resolver; raw profile trees and the backing database are never returned as query values unless the authored projection explicitly selects safe fields.

`SQLiteStoreBroker` owns Arbor writes and installs connection-local transactional triggers. It emits ordered row keys, changed fields, and before/after values only after the outer transaction commits; rolled-back writes emit nothing. A filesystem revision/WAL watcher uses SQLite's supported `data_version` signal to conservatively invalidate the whole store for writes made by another connection.

`LiveQueryBroker` derives relation/field/predicate/correlation sensitivity from normalized query plans and combines it with exact rows and profile refs observed during execution. Streams attach their listener before the initial snapshot, rerun across old and new dependencies when a change races execution, coalesce bursts, hash canonical output, and publish complete replacements only. `RegisteredQueryRuntime` validates a versioned document and complete mounted handle graph before serving the stateless stream.

`SQLiteMutationBroker` validates the activated root and every relation source, validates and transforms Standard Schema input before opening the store, resolves a reviewed versioned handle, and invokes it inside one runner-owned transaction with an injected Arbor user, logical time, deterministic ID namespace, and `SQLiteMutationTransaction`. The transaction rechecks each relation binding and exposes validated point and collection reads, inserts, updates, upserts, deletes, and serialized ordered append/replace/remove operations. Authorization reads and writes therefore share one snapshot, and temporary position rewrites coalesce to final post-commit row changes.

Each mutation durably commits its data, store cursor, and subject-scoped retry receipt together. Exact ambiguous retries return the original result; reusing a mutation identity for different semantic intent conflicts. Receipts use the same canonical semantic-digest primitive, include the resolved source bindings in intent, and use the same `observedThrough` vocabulary as accepted tree updates while remaining in the SQLite transaction domain. `RegisteredMutationRuntime` is transport-neutral; the current explicit binding arrays are the seam the generated manifest/compiler activation will replace.

Current limits follow the Supplies implementation plan:

- generated schema-specific authoring types, source-located diagnostics, and document compilation are Phase 4;
- React Action and named-call transport adapters are Phase 5;
- the reference driver is SQLite only.

Run the focused acceptance suite with:

```sh
bun test tests/unit/data-query.test.ts tests/unit/events.test.ts tests/unit/wire/update-intent.test.ts tests/integration/supplies-queries.test.ts tests/integration/data-live-query.test.ts tests/integration/query-stream-api.test.ts tests/integration/supplies-mutations.test.ts
```
