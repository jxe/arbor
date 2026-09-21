# @overstory/canopyd

The reference Overstory host and the `canopyd` command. It depends on
`protocol`, `object-store`, `apps-runtime`, and `canopyd-merge`; nothing
depends on it except tests and the deployment tooling.

- `canopy.ts`: validation, object durability, bounded race coordination, and
  the host's other features; `host.ts`: HTTP authentication, decoding, and
  response mapping, with no update policy; `cli.ts`: `canopyd`.
- `schema.ts`: the SQLite table definitions, the schema version stamp, the
  startup schema assertion, and `openCanopyDatabase`. The stamps are listed in
  the [schema history](../../packages/canopyd/migrations/README.md#schema-history).
- `updates/`: `decision.ts` (the identity-only current, accept, and merge
  table), `reconcile.ts` (invokes the merge sidecar only when both sides
  changed), `transition.ts`, `store.ts` (private accepted history and the
  ref, reflog, and accepted-row transaction), `observations.ts` (the ordered
  observation log per tree, the only source of cursor order), `watch-frames.ts`
  (net catch-up), `graph-validation.ts`, `source-edits.ts` (exact source
  execution and `composeFrames`), `conflict-store.ts`, `merge-state-store.ts`,
  `source-intent-store.ts`, `entry-ambiguity.ts`, `semantic-merge.ts`.
- `merge-tool.ts`, `merge-worker.ts`: the sidecar adapter, staging, and the
  worker supervisor ([merge tool](../../docs/architecture/canopyd/merge-tool.md)).
- `access.ts`, `accounts.ts`, `account-policy-v2.ts`, `profile.ts`,
  `boundaries.ts`, `resource-effects.ts`, `execution-authority.ts`: claims,
  accounts, governed configuration, and resource policy.
- `public-page.ts`, `projection.ts`: public HTML and Markdown projection and
  collection-file projection.

Accepted roots and reachable objects are retained indefinitely as private
operational state. A caller with read access may fetch any retained accepted
root from `GET /.arbor/trees/{TreeID}/snapshots/{root}` as a canonical CBOR
bundle; the route exposes no history listing, and unknown, wrong-tree,
pruned, and unauthorized roots are indistinguishable. Operating the host is
described in [the deployment guide](../../packages/canopyd/deploy/README.md).
