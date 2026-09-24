# @overstory/canopyd

The reference Overstory host and the `canopyd` command. It depends on
`protocol`, `object-store`, `apps-runtime`, and `merge-protocol` (the JSON
contract with its merge sidecar, whose code it never imports); nothing
depends on it except tests and the deployment tooling.

- `canopy.ts`: validation, object durability, bounded race coordination, and
  the host's other features; `host.ts`: HTTP authentication, decoding, and
  response mapping, with no update policy; `cli.ts`: `canopyd`.
- `schema.ts`: the SQLite table definitions, the schema version stamp, the
  startup schema assertion (`SchemaMismatchError`), the row invariants the
  integrity audit checks, and `openCanopyDatabase`. The stamps are listed in
  the [schema history](../../packages/canopyd/migrations/README.md#schema-history).
- `updates/`: `reconcile.ts` (the identity-only current, accept, and merge
  table; invokes the merge sidecar only when both sides changed),
  `transition.ts`, `store.ts` (private accepted history, the
  accepted-row transaction, and the only writer of `trees.ref`),
  `observations.ts` (cursor order over accepted updates, the only source of
  watch order), `watch-frames.ts`
  (net catch-up), `tree-diff.ts` (the one paired walk over two roots, and
  the per-update object reader), `entry-metadata.ts` (entry dates and
  document versions), `graph-validation.ts`, `merge-history.ts` (each
  accepted update's log entry in the object store, the only conflict record;
  public decision ids, guards and bindings derived from it).
- `merge-tool.ts`, `merge-worker.ts`: the sidecar adapter (one question,
  staging, answer checks) and the process supervisor ([merge tool](../../docs/architecture/canopyd/merge-tool.md)).
- `access.ts`, `accounts.ts`, `account-policy.ts`, `profile.ts`,
  `boundaries.ts`, `resource-effects.ts`, `execution-authority.ts`: claims,
  accounts, governed configuration (including its three-way merge), and
  resource policy.
- `public-page.ts`, `projection.ts`: public HTML and Markdown projection and
  collection-file projection.

Accepted roots and reachable objects are retained indefinitely as private
operational state. A caller with read access may fetch any retained accepted
root from `GET /.arbor/trees/{TreeID}/snapshots/{root}` as a canonical CBOR
bundle; the route exposes no history listing, and unknown, wrong-tree,
pruned, and unauthorized roots are indistinguishable. Operating the host is
described in [the deployment guide](../../packages/canopyd/deploy/README.md).
