# Data 009: `ifMatch` and merge rules on the wire

## Status

- **Priority:** P0
- **Effort:** L
- **State:** DONE on 2026-09-02: code, tests, and the live cutover through migrations/001. Spec:
  [synchronization §3](../../../spec/01-tree-operations.md#22-updating-a-tree), [model §4](../../../spec/01-tree-operations.md#14-change-and-equivalence).
  Remaining gap: `wire-endpoints.json` has no merged or conflict case; capture one from a real
  server when the endpoint vectors are next regenerated.
- **Depends on:** the `arbor://<TreeID>` locator change (landed 2026-09-02). Ships through
  [migrations/001](../../../migrations/001-if-match-and-model-hash/README.md) using [the migration procedure](../../../migrations/README.md).

## Target result

An update names which hash must still match at base, `ifMatch: "bytesHash" | "modelHash"`, and
what to do with a same-node conflict, `onConflict: "reject" | "merge"` (default merge). The
authority merges disjoint nodes itself, format-independently, from per-node model hashes;
the three format-specific mergers survive only as merge rules for two changes to one node.
`modelDigest` was renamed `modelHash` for complete logical-node comparisons.
Migration 001 also applied that spelling to the legacy collection-file
descriptor. The descriptor use is now recognized as too broad: it names only
the represented child set and Data 011 will replace it with `childSetHash` in a
separate post-001 migration. The update setting `ifMatch: "modelHash"` is not
part of that rename; it correctly means the full model hash of each touched
node and remains unchanged.

## Code changes, in order

1. **Wire types (TypeScript and Swift).** `UpdateRequest` gains `ifMatch` and optional
   `onConflict`; `AcceptedUpdate.merge` is present only when a merge rule ran. Files:
   `packages/wire/src/updates/types.ts`, `packages/wire/src/updates/json.ts`,
   `native/Packages/ArborWire/Sources/ArborWire/WireModels.swift`.
2. **Intent digest.** `updates-v1` becomes `{ version, tree, base, candidate, ifMatch, onConflict }`
   with `onConflict` at its effective value. `packages/wire/src/updates/intent.ts`,
   `canonicalUpdateIntent` in `ArborWireClient.swift`, and `conformance/wire-update-intent.json`.
3. **`modelDigest` → `modelHash`.** The implementation checkpoint renamed the
   legacy `RollupDescriptor` field in `packages/core/src/node-model.ts`, every
   provider that computes it (`file-provider.ts`, `sqlite-provider.ts`, `wire-file-rollup.ts`,
   `canopy/updates/merge.ts`), the Swift replica models, and the `wire-objects.json` and
   `node-model.json` vectors. This changes the bytes of every directory object carrying a rollup,
   so legacy collection-file trees need re-placement. This intermediate field
   is superseded by Data 011; migration 001 itself remains immutable.
4. **Per-node model hashes in Canopy.** A function that walks a wire directory graph and yields
   each node's model hash (schema, properties, content, children digests) so the authority can
   compare base, current, and candidate node by node. Reuse the CBOR
   canonicalizer; the legacy descriptor carries only its collection child-set
   contribution, not the enclosing node's complete model hash.
5. **Decision.** `packages/canopy/src/updates/decision.ts` grows from root comparison to:
   current/accepted as today; under `bytesHash`, anything else is a conflict; under `modelHash`,
   compute touched nodes (bytes differ base→candidate), check each node's model hash
   base→current, merge disjoint nodes, and hand conflicting nodes to `onConflict`.
6. **Merge module split.** `packages/canopy/src/updates/merge.ts` becomes `merge.ts` (assemble
   current plus the candidate's touched nodes) and `merge-rules/` (`markdown-additive-v1`,
   the then-current collection-file row rule, `account-config-v1`), each invoked
   only for a conflicting node. Data 011 owns the public rule rename.
7. **Reconcile and host.** `reconcile.ts` and `canopy/src/host.ts` return `merged` for both
   disjoint merges and rule merges; conflict details name each conflicting node. The result's
   `snapshot` becomes `reconciliation`, the transition from the candidate root to the accepted
   root, built by the transition builder with an arbitrary `from`; a conflict's `draft` is
   likewise a transition from the candidate. `TransitionPayload` is the one named payload type
   for requests, results, and watch frames.
8. **Clients.** arborsync's submit path (`packages/arborsync/src/tree-sync.ts`) and the Swift
   replica send `ifMatch: "modelHash"` and apply a result's `reconciliation` with their watch
   transition code, deleting the snapshot apply path; activation and the configuration tree send what
   [accounts §5](../../../spec/05-accounts-and-devices.md#5-declaring-and-activating-a-tree) and
   [configuration §3](../../../spec/05-accounts-and-devices.md#6-governed-account-tree) say.
9. **Stamp-triggered re-place in arborsync.** The daemon records the schema version it last
   ran against in `.state`; on start, a stamp older than its own discards the rebuildable state
   (`sync`, `refs`, `replicas`, indexes) and re-places every placement from a snapshot,
   comparing authored bytes before writing. Canopy already refuses a stale stamp; this is the
   client half, and it is what makes the Mac step of a migration "install and start".
10. **Vectors and tests.** `wire-endpoints.json` gains a case per outcome; unit tests for the
   decision matrix (bytes/reject, model/disjoint, model/same-node reformat, model/conflict with
   each `onConflict`); `bun test`, the Swift suites, and `tests/protocol/conformance.ts`.

## Do not

- Reintroduce a merge that understands a file format for disjoint nodes.
- Change the object encoding beyond the field rename in migration 001. Data 011
  owns the later directory-level collection-file encoding and migration 002.
- Add a third `ifMatch` value; an explicit-value form is a later extension.
