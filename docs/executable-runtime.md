# Arbor executable runtime reference

This document records replaceable compiler, store-driver, hosting, and live-evaluation choices in the current implementation. Portable authored source and observable behavior are specified by [executable documents](../spec/07-executable-documents.md), [stores](../spec/06-stores.md), and [the wire](../spec/04-wire.md).

## Compilation and isolation

The reference direction uses isolated JavaScript workers, with QuickJS/Wasm available for deterministic schema and handle evaluation. Only reviewed libraries such as Zod enter a schema realm. Time, stack, and memory limits and the absence of ambient filesystem, network, process, clock, randomness, and credential authority enforce the authored capability contract.

Generated TypeScript declarations live in private workspace state. Arbor-owned compiler and language-service hosts include them as extra root files, so authored trees do not name machine-local paths or require generated content. Bundles, code hashes, validators, manifests, caches, and generated database declarations are reproducible output. If a schema or connection is temporarily invalid, the reference tooling retains the last valid declarations, marks them stale, and reports a diagnostic.

The compiler currently normalizes callable relations, predicates, selections, and aggregates into a backing-independent relational IR, produces SQLite plans, and derives change-sensitivity plans. A Postgres driver is intended to consume the same IR. Concrete bundlers, worker topology, IR representation, generated-file paths, and compiler package structure are replaceable.

## Store observation

The initial runtime builds a sensitivity plan over base and virtual relations, projected and predicate fields, correlation and join keys, existence tests, group membership, aggregates, ordering, result windows, and shaped-result keys. It uses that plan to decide whether a committed change may affect a query, reruns the complete database query when needed, and publishes a complete replacement only when its canonical output hash changes. During a rerun it intersects invalidations with the union of the old and newly collected dependencies. These are implementation techniques for satisfying the portable no-gap and no-known-stale-result requirements.

SQLite observation may combine connection-local hooks for Arbor-owned writes with filesystem notifications and database revision checks for external writers. Consistent snapshots use SQLite backup/checkpoint facilities rather than unrelated copies of the main file and WAL. A Canopy-hosted SQLite tree serializes store writes with accepted updates and journals mutation intent before acknowledgement.

Postgres observation may use reviewed triggers, notifications, polling, or another database-supported changefeed. Notifications are wakeups rather than data authority; uncertainty widens invalidation and reestablishes a snapshot boundary. Exact locking, trigger, polling, and reconnect strategies may vary.

## Hosting and clients

The current runtime may compile eagerly or on demand and keeps the last usable document version when a new compilation fails. It server-renders React, embeds validated initial query results, hydrates against the same handles, and maintains the portable wire stream described by the specification.

Native Arbor presents executable documents in a constrained platform web surface rather than translating React into native components. It retains Arbor location, provenance, access, and source controls outside that surface. A client without a compatible runtime keeps source browsable and reports execution as unavailable.

Single-consumer handles normally live beside their document or component in the reference trees; shared modules are reserved for genuinely shared code. This is authoring guidance, not a portability requirement.

The reference store-migration tooling validates a destination before removing its source and reports transitions across independent store authorities as non-atomic. Those procedures do not alter the portable logical address or handle identity.
