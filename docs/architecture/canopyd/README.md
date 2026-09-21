# Host: canopyd

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**The host** (canopyd) implements access and claims, public HTTP projection,
graph validation, authoritative reconciliation, and private storage. Update
handling separates decision, causal reconciliation, and transactional storage
from rule computation; the [merge sidecar](merge-tool.md) computes every
merge and returns retained state, and canopyd validates the result and owns
acceptance. Table definitions, the schema stamp, and the startup schema
assertion live in `schema.ts`; the [schema history](../../../packages/canopyd/migrations/README.md#schema-history)
lists every stamp.

## Durability and observation

canopyd runs SQLite in WAL mode with `synchronous = NORMAL`; objects are
fsynced before the commit that names them, so a lost commit leaves only
unreferenced objects ([deployment](../../../packages/canopyd/deploy/README.md#durability)). Each
update request logs one structured line (tree, status, batch size, total and
per-phase milliseconds, objects considered, files written, fsyncs, body
bytes, trace frames and operations, accepted update ids) and returns the
same phases in a `Server-Timing` header. The log is silent under the test
runner and never contains request content, subjects, or object identities.
The Canopy app's network log is its client-side counterpart
([local system](../canopy-browser/local-state.md#diagnostic-streams)).

## Sidecars

- [Merge tool](merge-tool.md)
- [Execution sidecar](execution-sidecar.md)
- [Deployment](../../../packages/canopyd/deploy/README.md)
- [Migrations](../../../packages/canopyd/migrations/README.md)
