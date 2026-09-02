# Data 011: Separate logical child sets, child backings, and collection-file Wire encoding

## Status

- **Priority:** P0
- **Effort:** L
- **Risk:** HIGH — every collection-file directory object and ancestor receives
  a new hash, and TypeScript, Swift, Canopy, Arbor Sync, replicas, conformance,
  and deployment state must change together.
- **State:** IN PROGRESS — the normative specification, collection-file
  TypeScript and Swift cutover, collection-file conformance vectors,
  child-name rule, transition-payload code and conformance normalization, and
  local tests are complete. Migration 002, its rehearsal/cutover gates, and
  eventual removal of temporary decoder tolerance remain.
- **Depends on:** the completed Data 002 common node contract and Data 009
  update reconciliation; migration 001 must remain unchanged and its cutover
  must be verified complete on every relevant client before migration 002 runs.
- **Unblocks:** Data 003 representation equivalence and
  [Data 006](006-native-offline-collection-file-projection.md) native offline
  collection-file child projection.

## Remaining work

1. Restore a fresh live-volume archive into local `before` and `migrated`
   copies and run migration 002 against the latter.
2. Prove logical root equivalence, serve and verify the migrated copy, and
   record the results in the migration rehearsal report.
3. Complete the quiesced live cutover and Mac/iPhone re-placement checks.
4. After every deployed sender emits both transition arrays and the
   compatibility window closes, remove the temporary input-only tolerance for
   an omitted legacy `deltas` field from TypeScript and Swift decoders.
5. After the two-week backup window, remove migration 002 and move this plan
   to history. The tree-operations spec has its intended four-part structure,
   but its explanatory prose remains a separate follow-up editing task.

## Target result

The implementation uses the same three layers as the specification:

1. A logical `ChildSet` owns members and their shared child schema.
2. A `ChildBackingSummary` describes expanded files, a collection file, a
   database, or an external store without becoming identity.
3. The Wire's `CollectionFileDescriptor` interprets ordinary physical
   `_store.*` and `schema.ts` entries as one exact-source
   logical child set.

The word `rollup` leaves the public TypeScript, Swift, Local Arbor, Wire,
conformance, diagnostic, merge, and documentation surfaces. SQLite is a
database backing and never shares the collection-file descriptor. Existing
CSV/JSON/JSONL authored bytes, logical rows, stable keys, paths, access, and
tree identity survive the migration; Wire roots change where the encoding
changes.

## Settled terminology and hash semantics

- `RollupDescriptor` becomes `CollectionFileDescriptor`.
- `codec` becomes `format`; `schema` becomes `schemaFingerprint`.
- The descriptor's `modelHash` becomes `childSetHash`. It hashes the normalized
  `{ key, name, properties }` members supplied by the collection file and is
  not the enclosing node's model hash.
- `ifMatch: "modelHash"` remains unchanged. It correctly selects comparison of
  the complete model hash of every touched logical node. Update decision,
  request identity, access grants, and the `updates-v1` spelling retain it.
- `rollup-rows-v1` becomes `collection-file-rows-v1`; the three conflict reasons
  become `collection-file-row-conflict`,
  `collection-file-schema-conflict`, and
  `collection-file-constraint-conflict`.
- Database backing summaries lose any whole-table or whole-store `modelHash`.
  Database equality and freshness use row CAS values, schema fingerprints,
  transaction snapshots, and committed observation cursors under Data 005.

## Canonical Wire change

The old directory entry union embeds interpretation in one physical entry:

```ts
{ name: "_store.json", rollup: { source: Hash, schemaSource: Hash, ... } }
```

The new directory object keeps physical reachability and interpretation
separate:

```ts
{
  type: "directory",
  entries: [
    { name: "_store.json", hash: sourceHash },
    { name: "schema.ts", hash: schemaSourceHash }
  ],
  childrenSource: {
    version: 1,
    type: "collection-file",
    format: "json",
    source: "_store.json",
    schemaSource: "schema.ts",
    schemaFingerprint,
    childSetHash
  }
}
```

The schema's optional `childName` rule controls readable names; omission
preserves today's primary-key-derived names. A directory carrying
`childrenSource` rejects another immediate-child backing,
missing or conflicting source entries, and non-file declared sources.

## Implementation sequence

### 1. Core logical and capability types

- Add the explicit logical `ChildSet`/child-schema terminology without creating
  a stored duplicate tree model.
- Replace `ChildRepresentationSummary` with `ChildBackingSummary` and distinct
  `expanded-files`, `collection-file`, `database`, and `external-store`
  variants.
- Give only the collection-file variant a `childSetHash`; database variants
  expose schema and observation facts instead.
- Update TypeScript and Swift decoders together and reject the old public
  `type: "rollup"` capability after the migration boundary.

### 2. Wire objects and graph traversal

- Change `WireDirectoryEntry` to hash or nested-tree entries only and add the
  optional directory-level `childrenSource` descriptor.
- Make object reachability, snapshot transfer, deltas, materialization, public
  resolution, and offline replica preservation follow the ordinary source
  entries.
- Ensure materialization writes byte-identical `_store.*` and `schema.ts` files
  and never expands collection-file rows into Markdown.
- Update the per-node model-hash walker to hash the decoded logical child set,
  schema, properties, and content independently of physical reserved filenames.

### 3. Logical child names

- Extend the restricted `schema.ts` result with optional
  `childName: { from: "primaryKey" } | { from: "property", property: string }`;
  omission remains primary-key-derived.
- Reject duplicate resulting names, invalid or non-NFC names, and property
  rules that do not produce a valid name.
- Keep stable key and current readable name distinct in node references,
  locator healing, paging, search, backlinks, and mutations.

### 4. Collection-file validation and merge

- Rename and adapt the file decoder/encoder and provider APIs around
  collection files and `childSetHash`.
- Decode base, candidate, and current through their physical entries, validate
  the schema and child-name rule, and merge by stable member identity.
- Rename the merge summary and conflict reasons on both language surfaces.
- Preserve `ifMatch: "modelHash"`: only the descriptor contribution changes
  name. Add tests proving that a formatting-only collection-file change keeps
  `childSetHash` and the enclosing node's model hash stable while changing the
  Wire root.
- Test that a logical row/name change changes `childSetHash`, and that changing
  schema, parent content, or another child changes the appropriate enclosing
  node model hash rather than being mislabeled as a child-set hash.

### 5. Local providers and clients

- Rename file-provider, router, REST, browser, and native presentation terms.
- Keep SQLite behind the database variant and remove computed whole-table/store
  hashes from public backing summaries and cursor identity; retain internal
  recomputation only where a bounded operation explicitly requires an equality
  proof, then remove it under Data 005.
- Make remote browsing, public HTML/Markdown projection, query dependencies,
  row property writes, receipts, and restart recovery consume the same logical
  child paths and stable keys.

### 6. Conformance and documentation

- Replace the Wire object, node-model, endpoint, update-merge, and Swift
  fixtures in one checkpoint. Include positive CSV, JSON, JSONL, and child-name
  cases plus every invalid source/descriptor collision.
- Update reference docs and active plans. Historical plans remain evidence and
  may retain the old word when explicitly describing the pre-migration shape.
- Run all TypeScript protocol/unit/integration suites, both Swift Wire/client
  suites, native builds, and `git diff --check` before preparing migration 002.

## Migration 002

Migration 001 has already run against the live Canopy and Mac according to its
repository runbook and must not be amended or reused; its remaining client
closeout is a gate, not an invitation to fold in another Wire change. Once its
completion and resulting live schema stamp are verified, implementation creates
`migrations/002-collection-file-wire/` from the template required by
[`migrations/README.md`](../../migrations/README.md). It contains `README.md`,
an idempotent `run.ts`, `migrate.test.ts`, and the eventual rehearsal report.
Do not create or deploy an incomplete migration directory.

Expected source is the post-001 Canopy schema stamp (currently expected to be
3, matching the current `CANOPY_SCHEMA_VERSION`); expected target is the next
unused stamp (currently 4). The implementer
must inspect the live/post-001 state and current `CANOPY_SCHEMA_VERSION` before
freezing either number. Stop rather than migrating from an unexpected stamp.

### Rewrite

For every reachable old directory object:

1. Recursively rewrite ordinary hash children first.
2. For each old `{ name, rollup }` entry, add ordinary `{ name, hash: source }`
   and `{ name: "schema.ts", hash: schemaSource }` entries. An already present
   identical schema entry is reused; a different one is a fatal ambiguity.
3. Add directory-level `childrenSource` using `format: codec`, the physical
   source names, `schemaFingerprint: schema`, and
   `childSetHash: modelHash`. Old descriptors are children-only, so no `scope`
   survives. Old collection-file rows already use the primary-key-derived
   default, so no additional naming state is synthesized.
4. Canonically encode the new directory and recursively re-root every ancestor.
5. Write all new objects before changing SQLite refs. In one database
   transaction, replace affected refs, rebuild derived profile facts, reset
   accepted history to one `restored` update per tree, reset observation/reflog
   state, and advance the schema stamp.
6. Verify every new graph and its decoded logical equivalence before pruning
   unreachable old objects. Reports contain tree IDs and roots only.

The migration owns a narrowly scoped legacy decoder/materializer for the old
directory entry shape. Production decoders reject that shape at schema stamp 4;
the compatibility code exists only so the rewrite and before/after comparison
can read schema-3 objects without weakening the new runtime.

### Rehearsal and cutover

- Follow the repository migration procedure exactly: fresh live-volume archive,
  local restore, migration of the copy, root comparison, served verification,
  and a recorded rehearsal report before deployment.
- Include a synthetic old collection-file tree even if the live snapshot again
  contains zero such trees. Prove CSV, JSON, JSONL, ancestor re-rooting,
  identical schema-entry reuse, ambiguity refusal, and idempotent refusal to run
  twice.
- `compare-canopy-roots` must report model-equivalent decoded trees. An authored
  manifest before/after materialization must prove byte-identical source and
  schema files and no invented naming metadata.
- Quiesce Mac and iPhone writers, but keep Canopy reads available as the common
  procedure requires. The new server refuses the old stamp until migration 002
  completes.
- The Mac schema-stamp change discards only rebuildable sync/ref/replica state
  and re-places every tree after byte comparison. iPhone replicas using the old
  directory codec are deleted and re-placed on launch.
- Verify health, every public ref against the migration report, idle local
  placements, one Mac edit visible at its canonical URL, remote collection-file
  row browsing, and one row merge/conflict case.
- Rollback before clients re-place restores the migration-002 archive and the
  previous image. After client re-placement it also restores the pre-cutover
  local data-home copy. Keep both backups for two weeks, then delete them and
  the migration directory.

## Completion gate

- No active public/spec/reference surface uses `rollup` for a child backing or
  collection file.
- Exact authored files and logical children round-trip through TypeScript,
  Swift, Canopy, Arbor Sync, public projection, and native replicas.
- `childSetHash`, enclosing-node `modelHash`, Wire root, and observation cursor
  each change only for the level they identify.
- Child-name fixtures preserve stable identity and readable names where the
  schema can derive them; conversion dry-runs make any rename explicit.
- Migration 002 has a green rehearsal report and verified live cutover; only
  then may this plan move to history.
- Every deployed transition sender emits both arrays; the temporary decoder
  tolerance for an omitted `deltas` field has been removed.

## STOP conditions

- Migration 001 has not completed cleanly or the actual source stamp is not the
  one migration 002 was rehearsed against.
- Rewriting a directory would require guessing which physical source or schema
  an old descriptor meant.
- A conversion would drop Markdown content/children or change a stable key or
  logical name without an explicit reviewed schema rule or reported rename.
- A database change would reintroduce hashing live storage bytes or treating a
  whole-database hash as an ordinary read revision.
- TypeScript and Swift cannot accept the same canonical object and hash vectors
  at one checkpoint.
