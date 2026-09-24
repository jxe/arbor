# @overstory/canopyd-merge

canopyd's merge sidecar and the `arbor-merge` command. It runs as a separate
Bun process with fixed object-store paths and a minimal environment, and it
has no database connection or credentials.

- `sidecar.ts`: the question loop: the in-memory cache of engine states per
  log entry, replay from each chain's start and alignment to recorded
  entries, and the answer. The question, answer and log entry shapes are in
  [`@overstory/merge-protocol`](../merge-protocol/README.md), the only
  contract canopyd sees.
- `snapshot.ts`, `trees.ts`: a snapshot's choices (one per conflicting entry
  or folder, continuing a hidden alternative) and path-copying tree edits.
- `log-decisions.ts`, `reports.ts`: the engine's decisions as log decisions,
  with node identities resolved to logical paths.
- `engine-contract.ts`, `contract.ts`: the engine's own request and result
  shapes (authored evaluation, checkpoint, snapshot tree merge) and checks.
- `intent-engine.ts`, `intent-model.ts`: exact authored-operation execution
  over traces of frames, choices, and retained state.
- `merge-rules.ts`, `format-rules.ts`, `markdown-format.ts`, `web-formats.ts`:
  the format support rules (see the [format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)).
- `merge.ts`, `pieces.ts`, `state-map.ts`, `state-storage.ts`, `state-value.ts`,
  `history-view.ts`: retained state, shared history pages and lazy history.
- `checkpoint.ts`: the checkpoint request, which records an accepted root
  (and its choices) onto a retained state; replay aligns with it.
- `cli.ts`: the JSON-lines `serve` process.

It has no account-configuration rule: canopyd merges its own policy files.

The API is [writing a sidecar](../../docs/architecture/canopyd/writing-a-sidecar.md);
the process, cache, limits and failure behavior are in
[the merge sidecar](../../docs/architecture/canopyd/merge-tool.md).
