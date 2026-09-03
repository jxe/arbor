# Smaller project 003: Project synchronized collection-file rows in native offline replicas

## Status

- **Priority:** P2
- **Effort:** UNKNOWN
- **State:** DEFERRED — specification and implementation begin only when native
  offline browsing of collection-file children becomes a product requirement.
- **Depends on:** historical
  [Data 002](../_done/data/002-reconcile-node-data-model.md), the
  historical [Data 011](../_done/data/011-collection-file-wire.md) exact-source Wire shape, and the
  shared authored-code execution decisions made by Apps 003.

## Target result

A native offline replica that already contains a synchronized CSV, JSON, or
JSONL collection file and its exact `schema.ts` presents the same logical row
`NodeSnapshot`s and `ChildrenPage`s as local
Arbor Sync and Canopy, without a network connection and without changing the
synchronized tree.

The logical results must agree on stable identity, readable path, properties,
schema, capabilities, pagination, diagnostics, and backing metadata. Reserved
source and schema files remain representation details rather than visible row
children.

## Required invariants

- Offline projection never changes the accepted Wire root or the exact stored
  collection-file and schema objects.
- The native result uses the same authored schema meaning and validation rules
  as other Arbor placements; it does not introduce a second schema language.
- Invalid, duplicate, missing, or ambiguous stable keys fail closed and produce
  compatible diagnostics.
- Resource bounds and forward-compatibility behavior are explicit and covered
  by language-neutral fixtures.
- A replica that cannot perform the projection preserves the Wire objects
  losslessly and reports the capability as unavailable rather than inventing a
  partial row model.

## Completion gate

Use the shared Data 002 corpus, updated to the Data 011 encoding, to prove that
native offline snapshots and child pages match local Arbor Sync and Canopy for
CSV, JSON, and JSONL, including child-name rules, invalid inputs, pagination,
stale readable paths, and stable-key reopening. Then remove the temporary
native capability limitation recorded by this plan and the
[remove-later inventory](../cleanups/README.md).

This plan deliberately does not choose an implementation mechanism.
