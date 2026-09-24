# @overstory/canopyd-merge

canopyd's merge sidecar and the `arbor-merge` command. It runs as a separate
Bun process with fixed object-store paths and a minimal environment, and it
has no database connection or credentials.

- `contract.ts`: the typed request and response contract, the source of
  truth for the API.
- `intent-engine.ts`, `intent-model.ts`: exact authored-operation execution
  over traces of frames, choices, and retained state.
- `merge-rules.ts`, `format-rules.ts`, `markdown-format.ts`, `web-formats.ts`:
  the format support rules (see the [format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)).
- `merge.ts`, `pieces.ts`, `state-map.ts`, `state-storage.ts`, `state-value.ts`,
  `history-view.ts`, `retention.ts`: retained state, shared history pages,
  lazy history, and retention closure.
- `checkpoint.ts`, `checkpoint-batch.ts`: reconstructing legacy semantic
  states.
- `account-v2.ts`: account-configuration merge rules.
- `cli.ts`, `worker-objects.ts`: the JSON-lines `serve` worker and staged
  objects.

The process contract, limits, and failure behavior are in
[the merge tool](../../docs/architecture/canopyd/merge-tool.md).
