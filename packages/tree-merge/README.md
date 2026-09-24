# @overstory/tree-merge

The three-way snapshot tree merge: `mergeProtocolTrees(base, candidate, current,
load)` combines two directory trees against their common base, node by node,
and reports the merged root, the objects it generated, the conflicts it could
not reconcile and the folders a coupled rule failure leaves whole. It has no
engine, cache or process of its own.

- `merge.ts`: the tree walk, stable-page renames and directory reconciliation.
- `merge-rules.ts`: the representation rules it applies to one node changed on
  both sides: Markdown additive merging with frontmatter and fence checks, and
  keyed collection-file rows decoded and re-encoded through the declarative
  schema of [`@overstory/collection-schema`](../collection-schema/README.md);
  a retired version-1 (`schema.ts`) side is a schema conflict.
- `model-hash.ts`: the model hashes that let a node reformatted on one side
  take the other side's bytes without conflict.

The [merge sidecar](../canopyd-merge/README.md) merges snapshot candidates
with it, and the [Arbor Sync tree recovery](../arborsync/recovery/README.md)
tool merges recovery candidates with it.
