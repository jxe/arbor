# Arbor executable runtime reference

This document records replaceable compiler, backing-adapter, hosting, and live-evaluation choices in the current implementation. Portable authored source and observable behavior are specified by [executable documents](../spec/08-executable-documents.md), [child backings](../spec/07-child-backings.md), and [the model and Wire encoding](../spec/01-model-and-wire.md).

## Compilation and isolation

The reference direction uses isolated JavaScript workers, with QuickJS/Wasm available for deterministic schema and handle evaluation. Only reviewed libraries such as Zod enter a schema realm. Time, stack, and memory limits enforce the authored capability contract together with the spec's [no-ambient-authority rule](../spec/08-executable-documents.md#2-authored-component-forms).

Generated TypeScript declarations live in private workspace state. Arbor-owned compiler and language-service hosts include them as extra root files, so authored trees do not name machine-local paths or require generated content. Bundles, code hashes, validators, manifests, caches, and generated database declarations are reproducible output. If a schema or connection is temporarily invalid, the reference tooling retains the last valid declarations, marks them stale, and reports a diagnostic.

The runtime normalizes every source through `arbor(path)`. Its implemented
portable subset is ordinary child filtering, explicit field picking, shared
cardinality, and deterministic stable-key/path ordering over expanded and
SQLite providers. SQLite retains explicit relational extensions for callable
relations, aggregates, ordering, and correlated selections. Generated typing,
activation manifests, and editor language-service integration remain planned;
a Postgres driver is also future work. Concrete bundlers, worker topology, IR
representation, generated-file paths, and compiler package structure are
replaceable.

## Store observation

The initial runtime builds a sensitivity plan over base and virtual relations, projected and predicate fields, correlation and join keys, existence tests, group membership, aggregates, ordering, result windows, and shaped-result keys. It uses that plan to decide whether a committed change may affect a query, reruns the complete database query when needed, and publishes a complete replacement only when its canonical output hash changes. During a rerun it intersects invalidations with the union of the old and newly collected dependencies. These are implementation techniques for satisfying the portable no-gap and no-known-stale-result requirements.

Ordinary child queries use the same coordination rule with provider-neutral
dependencies: source membership/schema, sampled rows, and fields used by the
predicate or selection. Local property mutations publish exact changed fields;
external events without that precision invalidate conservatively. The listener
is attached before the first sample, and a relevant event racing that sample is
checked against both old and new dependencies and rerun before publication.

SQLite observation may combine connection-local hooks for Arbor-owned writes with filesystem notifications and database revision checks for external writers. Consistent snapshots use SQLite backup/checkpoint facilities rather than unrelated copies of the main file and WAL. A Canopy-hosted SQLite tree serializes store writes with accepted updates and journals mutation intent before acknowledgement.

Postgres observation may use reviewed triggers, notifications, polling, or another database-supported changefeed. Notifications are wakeups rather than data authority; uncertainty widens invalidation and reestablishes a snapshot boundary. Exact locking, trigger, polling, and reconnect strategies may vary.

## Hosting and clients

The current runtime may compile eagerly or on demand and keeps the last usable document version when a new compilation fails. It server-renders React, embeds validated initial query results, hydrates against the same handles, and maintains the portable wire stream described by the specification.

Native Arbor presents executable documents in a constrained platform web surface rather than translating React into native components. It retains Arbor location, provenance, access, and source controls outside that surface. A client without a compatible runtime keeps source browsable and reports execution as unavailable.

Single-consumer handles normally live beside their document or component in the reference trees; shared modules are reserved for genuinely shared code. This is authoring guidance, not a portability requirement.

The reference store-migration tooling validates a destination before removing its source and reports transitions across independent store authorities as non-atomic. Those procedures do not alter the portable logical address or handle identity.
