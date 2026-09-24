# @overstory/canopyd-merge

canopyd's merge sidecar and the `arbor-merge` command. It runs as a separate
Bun process with fixed object-store paths and a minimal environment, and it
has no database connection or credentials.

- `contract.ts`: the worker's own request check. The request and response
  shapes are in [`@overstory/merge-protocol`](../merge-protocol/README.md),
  the only contract canopyd sees.
- `intent-engine.ts`, `intent-model.ts`: exact authored-operation execution
  over traces of frames, choices, and retained state.
- `reports.ts`: the decision reports sent in place of retained decision
  records, with node identities resolved to logical paths.
- `merge-rules.ts`, `format-rules.ts`, `markdown-format.ts`, `web-formats.ts`:
  the format support rules (see the [format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)).
- `merge.ts`, `pieces.ts`, `state-map.ts`, `state-storage.ts`, `state-value.ts`,
  `history-view.ts`, `retention.ts`: retained state, shared history pages,
  lazy history, and retention closure.
- `checkpoint.ts`: the checkpoint request, which records an accepted root
  (and its choices) onto a tree's retained state.
- `cli.ts`, `worker-objects.ts`: the JSON-lines `serve` worker, its wire
  translation, and staged objects.

It has no account-configuration rule: canopyd merges its own policy files.

The process contract, limits, and failure behavior are in
[the merge tool](../../docs/architecture/canopyd/merge-tool.md).
