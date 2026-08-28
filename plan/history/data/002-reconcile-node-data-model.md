# Data 002: Reconcile the logical node data model everywhere

> **Executor instructions:** This is a coordinated protocol and ontology
> migration, not a sequence of local enum renames. Read the accepted format,
> stores, locators, executable-document, and wire specifications first. Keep
> TypeScript, Swift, local filesystem, offline replica, remote wire, render,
> fixtures, and documentation aligned at every green checkpoint. Do not retain
> the old collection page as a hidden compatibility ontology.

## Status

- **Priority:** P1
- **Effort:** XL
- **Risk:** HIGH — node identity, editing, paging, sync, rendering, and native
  protocol parity all change together.
- **State:** COMPLETE — the common local/Wire node, locator, rollup, query,
  mutation, and presentation contracts are implemented. Representation
  conversion, Postgres, durable database observation/synchronization, native
  offline rollup-row projection, and compiler/editor tooling continue in their
  dedicated plans.
- **Depends on:** accepted specification in `spec/01-data-model.md`,
  `spec/02-directory-format.md`, `spec/03-locators.md`, `spec/04-wire.md`, and
  `spec/06-stores.md`
- **Unblocks:** Data 001, Data 003 representation migration, Data 004 Postgres,
  Data 005 database observation/synchronization, Data 006 native offline row
  projection, and Application 003 compiler/runtime binding

### Implementation checkpoints

- **2026-08-27 — locator codec complete:** `conformance/url-resolution.json`
  now drives independent TypeScript and Swift parsing for stable-key path
  suffixes, the Markdown relative-link alias, raw application queries, ordinary
  content fragments, immutable raw-TreeID revisions, literal encoded suffixes,
  decode-once paths, invalid/duplicate keys, and bounded legacy-fragment
  candidates. Both implementations emit the Markdown and network forms.
  Directory link healing preserves the key and application query, and Canopy
  rewrites the Markdown alias to the server-visible suffix. The owner index,
  rather than the locator parser, remains responsible for proving that a legacy
  bare fragment uniquely names an old PageID.
- **2026-08-27 — node sampling contract complete:**
  `conformance/node-model.json` freezes the three-part ref, identity rules,
  capabilities, exact-source content, summaries, snapshots, children pages,
  fail-closed forward compatibility, and all three exact-source Wire file-rollup descriptors.
  Independent TypeScript and Swift decoders accept the shared positive vectors
  and reject missing nullable keys, the old PageID union, duplicated location,
  public kinds, and write authority inferred from omission. Wire endpoint
  vectors now freeze tree-scoped `QUERY .../queries` and `POST .../mutate`.
- **2026-08-27 — TypeScript and Swift node-reference cutover complete:** the
  public core and ArborClient references, local REST query and JSON decoders,
  managed/untracked filesystem dispatch, client encoding, browser navigation,
  native provider adaptation, backlinks, recovery, transfer metadata, and
  protocol fixtures now use required
  `{ tree, path, stableKey: string | null }`. Stable-key resolution survives a
  stale readable path, while a path-only request remains explicit with
  `stableKey: null`. Local REST rejects omitted identity state and the removed
  PageID/path-hint union. Markdown `id`, ArborKit's presentation-facing
  `WorkspaceReference`, legacy event effects, search results, and private
  physical child records still use PageID internally; they are not an alternate
  wire reference.
- **2026-08-27 — snapshot, children, and collection protocol cutover complete:**
  core exposes the frozen capability-based `NodeSnapshot`, `NodeSummary`, and
  `ChildrenPage`; collection backing records remain provider-internal and the
  temporary private `TreeNode`/`TreeChild` ontology is deleted. Local, managed,
  system, mounted, and remote adapters
  emit properties, exact-source content, capabilities, and generic paginated
  summaries. `/v1/collection` and its TypeScript/Swift clients are removed, the
  browser renders tables from `NodeSummary.properties`, and neither client
  hydrates children during `node()` or observed-view admission. Swift rejects
  the same legacy snapshot fields as TypeScript, native surfaces derive from
  capabilities, and the macOS app builds against the new protocol.
- **2026-08-27 — file-rollup identity and read path complete:** `schema.ts`
  primary-key declarations are sandboxed and checked against required schema
  properties; CSV, JSON, and JSONL derive canonical keys from the identity rule
  declared by their parent and deterministic row segments after validation.
  `_store.json` is a recognized
  rollup in managed, untracked, remote-detection, filesystem-reserved, and
  offline-native surfaces. File children use exact-revision-bound keyset
  cursors when every declared key is valid, while identity-less or invalid
  read-only projections use explicit revision-bound positional cursors.
  Exact representation/schema revisions are separate from the normalized
  scoped model digest, so formatting-only JSON changes invalidate paging
  without changing logical equivalence.
  Duplicate, missing, nullable, and invalid keys produce diagnostics and never
  fall back to durable positional identity. Rolled-up rows resolve through
  ordinary node reads by path or stable key, including stale readable paths in
  managed and untracked scopes. The deliberate compatibility/retrofit layers
  and their deletion conditions are recorded in
  [remove-later](../../remove-later/README.md).
- **2026-08-27 — SQLite node read path complete:** `_store.sqlite3` detection,
  executable-store validation, and standalone SQLite introspection now share
  the relational metadata in `@arbor/data`. A SQLite-backed directory samples
  as a subtree rollup whose user tables are ordinary child nodes; each table
  pages database-consistent row snapshots with primary-key stable identity,
  deterministic row paths, revision-bound keyset cursors, normalized booleans,
  and stale-path key resolution. Managed and untracked filesystem adapters use
  the same database/table/row behavior. Generic capabilities remain read-only,
  while the existing authored query and named mutation APIs are unchanged.
- **2026-08-27 — portable query and direct-edit design accepted:** authored
  queries use `arbor(path).children` for every provider. The initial universal
  algebra is predicate filtering plus explicit field selection and cardinality;
  it has automatic stable-key/path ordering and does not promise joins,
  relationships, aggregates, or authored ordering. Generic direct editing uses
  `writeProperties` with complete candidate properties, property-revision CAS,
  and immutable identity. Named `mutate` remains the transaction/authorization/
  cascade surface.
- **2026-08-27 — portable query and direct property-edit checkpoint complete:**
  authored queries now start at `arbor(path).children`, and one provider-neutral
  evaluator applies the accepted filter, field-selection, cardinality, and
  deterministic-order baseline to expanded Markdown children and SQLite rows.
  Unsupported relational extensions fail before provider reads. Generic
  `writeProperties` uses a complete property map, property-revision CAS, and
  immutable stable identity. Markdown preserves the exact body while replacing
  frontmatter; stable-key SQLite rows update in a foreign-key-checked
  transaction with a durable same-transaction retry receipt. CSV, JSON, and
  JSONL remain explicitly read-only. TypeScript and Swift protocol fixtures,
  local and managed adapters, the client, Supplies authored handles, specs, and
  cross-cutting follow-ups are aligned. The obsolete authored `database()`/`.relations`
  namespace was removed without an adapter. Identity rules now contain only
  `properties`; the declaration site supplies the tree or sibling keyspace, and
  decoders reject the temporary scoped form introduced at the first checkpoint.
- **2026-08-27 — authoritative source binding and Markdown-record write path
  complete:** SQLite query activation now binds each authored `arbor(path)` to
  its complete logical tree/path and schema fingerprint. Execution rejects an
  unbound handle, a stale schema, another tree/store root, or a relation leaf
  that does not match the resolved path before opening the query database.
  Named mutation activation supplies the complete source set, validates every
  relation again inside the transaction API, and includes the resolved sources
  in the semantic retry digest. Managed and untracked schema-governed Markdown
  records now resolve as the same ordinary node whether addressed by current
  path or stable key: snapshots include projected properties and exact Markdown
  content, `writeProperties` schema-validates complete frontmatter while
  preserving the body, path-only writes cannot change declared identity, and
  exact content writes accept the same stable row reference. Later checkpoints
  remove the remaining provider probes and complete portable query semantics;
  generated activation manifests remain Application 003 work.
- **2026-08-27 — shared child-provider adapter cutover complete:** expanded
  directories, schema-governed Markdown records, CSV/JSON/JSONL rollups, and
  SQLite table/row subtrees now cross the managed and untracked adapter boundary
  as `NodeSnapshot`, `NodeSummary`, and `ChildrenPage`. One `ChildProvider`
  owns collection/table location, stable-key healing, diagnostics, access
  ceilings, row capabilities, write targets, and Markdown property preparation.
  `Workspace` and `FilesystemService` no longer contain separate collection-row,
  SQLite-grandparent, or virtual-table probes; the internal `CollectionPage`
  type and adapter translation helper are deleted. Provider conformance tests
  freeze the same snapshot/children contract for expanded, Markdown, CSV, JSON,
  JSONL, and SQLite children. Store loading records remain provider details;
  adapters no longer translate through a second private node ontology.
- **2026-08-27 — exact-source file-rollup property writes complete:** CSV,
  JSON, and JSONL rows with declared stable keys now expose writable properties
  through the same `ChildProvider` transaction boundary as Markdown and
  SQLite. Preparation compares both the sampled row revision and the complete
  source revision, validates the candidate and the complete rewritten
  collection, preserves every untouched source span, and creates an fsynced
  replacement without publishing it. Commit rechecks the exact source and
  atomically renames the prepared file. Managed mutations record their expected
  logical row effect before publication and recover that effect after a crash;
  concurrent preparations conflict rather than losing an update. Provider,
  managed, and untracked conformance tests cover JSON formatting, JSONL line
  endings, CSV multiline records and unknown fields, no-op byte identity,
  invalid-neighbor fail-closed behavior, retry, conflict, and post-rename crash
  recovery. Collection membership remains read-only through this operation.
- **2026-08-27 — portable query-core and membership checkpoint complete:**
  SQLite and ordinary child execution now consume one provider-neutral module
  for input validation, required-user checks, predicate meaning, field shaping,
  cardinality, and value comparison. The portable subset orders both providers
  by canonical stable-key bytes rather than SQLite's raw primary-key order;
  compound, numeric, and Unicode keys plus `one`/`maybe` share conformance
  fixtures. `NodeQueryEngine` samples the resolved source before paging and
  returns its children revision, schema revision, and observation cursor as a
  membership dependency alongside row revisions. Expanded-directory cursors
  are revision-bound, and a racing membership event is replayable from the
  sampled boundary. SQLite-only relationships, aggregates, authored ordering,
  and SQL planning remain explicit capability extensions rather than leaking
  back into the common engine.
- **2026-08-28 — bounded child placement complete:** directory source is now
  exact authored Markdown. One shared projection recognizes the first authored
  standalone link for each physical child, places all remaining children at a
  single explicit `<!-- arbor:children -->` marker or implicit end marker, and
  blocks ambiguous multiple markers. Generated child blocks are visible and
  reorderable in the editor but never serialized. Managed, untracked, remote,
  and native reads no longer synthesize literal child lists or apply
  collection-specific exclusions, and the shared fixture freezes marker,
  stable-key healing, sorting, and diagnostics.
- **2026-08-28 — locator authority and private-ontology cleanup:** search
  results now carry one `ResolvedNodeRef`; ArborKit's stored presentation
  reference is the generic `{ tree, path, stableKey }` triple; ArborReplica
  consumes the shared Swift locator codec instead of parsing fragments; and
  Canopy parses the identity suffix before boundary routing, proves Markdown
  keys against the accepted Wire snapshot, and permanently redirects stale
  readable paths while preserving the key and application query. The private
  `collection`/`postgres` node kinds and `CollectionSummary`/`CollectionRow`
  records are removed: expanded directories always remain physical
  directories and carry provider child-set metadata separately. The retained
  PageID owner index is a Markdown representation codec and bounded legacy-link
  reader, not a presentation or locator reference type.
- **2026-08-28 — provider-neutral live queries and final execution routes:**
  `NodeLiveQueryBroker` runs the portable filter/field/cardinality algebra over
  any ordinary `NodeQueryProvider`, subscribes before sampling, queues racing
  tree events, and conservatively reruns without a snapshot/watch gap. The
  registered runtime accepts either that broker or the relational broker. Wire
  now serves only `QUERY /.arbor/trees/{TreeID}/queries` and
  `POST /.arbor/trees/{TreeID}/mutate`, validates that route/document/handle
  tree scopes agree, authorizes the Canopy tree, and preserves local
  `/v1/query-stream` as the explicitly local adapter. The old unscoped Wire
  alias is removed; route tests cover queries, named mutation receipts, user
  context, and scope rejection.
- **2026-08-28 — generic mutation and observation references:** TypeScript and
  Swift mutation effects and workspace changes now carry the same complete
  `ref` triple as snapshots, children, search, and navigation. Browser/native
  consumers match stable keys directly rather than reconstructing PageIDs, and
  identity materialization returns the resulting ref. New journals and Wire
  fixtures contain no duplicated tree/path/PageID fields; a bounded legacy
  journal reader preserves crash recovery and has an explicit deletion
  condition in [remove-later](../../remove-later/README.md).
- **2026-08-28 — native presentation reference cleanup:** ArborKit now exposes
  only `WorkspaceReference { tree, path, stableKey }`; its `PageID` wrapper,
  `pageID` initializer/property, and `pathHint` alias are deleted. App,
  Quagmire, provider, replica, and synchronization callers use stable keys
  directly, including voice destinations and stale-path recovery. Internal
  editor document references keep the readable path in the URL path and carry
  the optional stable key as a query parameter, so they no longer invent a
  PageID route namespace. Physical Markdown/replica `id` handling remains a
  representation codec behind the generic reference.
- **2026-08-28 — database revision correction:** exact revision-keyed snapshots
  remain valid for expanded/file rollups, while SQLite/Postgres use short-lived
  transaction snapshots, schema fingerprints, row CAS tokens, and committed
  observation cursors. Schema validation and SQLite row sampling now share one
  read transaction. The unresolved durable observation/checkpoint and semantic
  synchronization design moved intact to
  [Data 005](../../data/005-database-observation-and-semantic-sync.md); Data 002 will not
  invent whole-database hashes or merge database storage bytes.
- **2026-08-28 — exact-source Wire boundary correction:** the frozen
  `RollupDescriptor` and independent TypeScript/Swift conformance now admit
  only CSV, JSON, and JSONL exact-source placements. SQLite remains a valid
  child-representation summary but must use Data 005 observations/checkpoints,
  not a file hash. Swift Wire locator resolutions now require the same explicit
  `{ tree, path, stableKey }` shape as every other node boundary, and both
  languages recognize the reserved `rollup-rows-v1` merge summary.
- **2026-08-28 — Wire file-rollup synchronization and merge:** canonical
  TypeScript and Swift directory objects now carry CSV/JSON/JSONL descriptors
  whose exact source and exact `schema.ts` are reachable objects. Arbor Sync
  emits descriptors from coherent provider snapshots; Canopy executes the
  synchronized schema, recomputes schema/model digests under explicit byte/row
  bounds, rejects malformed graphs, and merges disjoint changes by stable row
  identity. The local daemon's unplaced remote-tree adapter pages the same row summaries without a
  physical-child cache and reopens them by stable key. Swift replicas preserve
  descriptors and their reachable objects exactly across materialization and
  unrelated offline edits. Server-grade application-code containment is one
  deferred [security boundary](../../insecure/README.md) shared with
  SSR/query/mutation execution. Native
  offline row projection is deliberately deferred to
  [Data 006](../../data/006-native-offline-rollup-row-projection.md). The reference
  merge currently writes one canonical encoding after semantic reconciliation;
  preserving untouched source formatting is tracked as explicit continuation
  debt rather than weakening the logical merge contract.
- **2026-08-28 — final common-model closure:** `@arbor/core/internal` and the
  private `TreeNode`/`TreeChild` adapter graph are deleted; expanded children
  are sampled directly into the public node contract. Canopy's ordinary public
  resolver lists, opens, and stable-key-heals Wire CSV/JSON/JSONL rows as HTML
  or Markdown while keeping representation files hidden. Ordinary live queries
  now derive source, membership, row, schema, and property-field sensitivities,
  subscribe before sampling, check racing changes against old and new
  dependencies, and publish the first result only after any relevant race has
  been rerun. Direct property writes carry exact changed-field metadata when
  the provider can prove it; imprecise external events remain conservative.
  Typed source declarations, activation-manifest generation, and editor
  integration continue in
  [Application 003](../../applications/003-development-compiler-and-editor-tooling.md);
  representation-path conversion, including cross-representation search and
  backlink proof, continues in [Data 003](../../data/003-representation-equivalence.md);
  Postgres continues in [Data 004](../../data/004-postgres-child-provider.md); database
  observation/synchronization continues in
  [Data 005](../../data/005-database-observation-and-semantic-sync.md); and native offline
  rollup-row projection is deliberately deferred to
  [Data 006](../../data/006-native-offline-rollup-row-projection.md). The closure gate
  passed TypeScript checking, the production build, 313 Bun tests, the live
  TypeScript/Swift protocol harness, all seven Swift package suites, and the
  macOS 27 Arbor application build.

## Target result

Arbor exposes one logical node model across files, Markdown documents,
directories, collections, database containers, tables, and rows:

- `TreeID` is the primary global tree identity and canonical URL resolution is
  a secondary index to tree plus path;
- identity, location, properties, content, children, schema, and capabilities
  are independent dimensions;
- `document` and `collection` are capabilities/projections, while file,
  Markdown, CSV, JSON, and JSONL are exact-source representations in this plan;
  SQLite is a database provider, while Postgres uses the same frozen contract
  in Data 004 and database observation/synchronization belongs to Data 005;
- every table or record is browsed through ordinary `node` and paginated
  `children` operations;
- frontmatter and row columns project through the same node-properties field;
- a separate `/v1/collection`, `CollectionPage`, `CollectionRow`, and public
  `NodeKind` taxonomy no longer exist;
- every reference carries tree, current path, and one nullable stable-key slot;
  PageIDs and collection-scoped row keys populate that same slot;
- rolled-up children participate in tree snapshots, accepted updates,
  semantic merge, watch invalidation, queries, public resolution, and directory
  placement; cross-representation search/backlink equivalence belongs to Data
  003; and
- TypeScript, Swift, local, managed, offline, and remote providers consume the
  same conformance fixtures.

## Baseline split being removed

This was the live implementation inventory when the plan was accepted. The
checkpoint log above records which parts have since been removed; the remaining
items continue to define migration scope rather than current public contracts:

- `packages/core/src/types.ts` defines `NodeKind` as Markdown/directory/
  collection/file/Postgres and separately defines `CollectionSummary`,
  `CollectionRow`, and `CollectionPage`.
- `packages/core/src/protocol.ts` defines a different `ProtocolNodeKind`, keeps
  `kind`, `document`, and `collection` optionals on `NodeSnapshot`, duplicates
  tree/path fields in children, and exposes `CollectionResultPage`.
- `packages/fs/src/types.ts` has a physical `FsNodeKind`; that provider detail
  leaks outward through adapters.
- `packages/stores/src/collections.ts` pages CSV/JSONL/Markdown/Postgres rows
  with positional keys and offset cursors, but does not implement the SQLite
  engine used by executable documents.
- `packages/data` has a richer SQLite schema/query/mutation/observer model with
  real primary and foreign keys, but it is not the browser node provider.
- `Workspace.node`, `FilesystemService.node`, and remote snapshot code classify
  directories as collections and synthesize Postgres table children through
  special cases.
- Directory reads formerly synthesized every unmatched child link into authored
  Markdown and filtered collection rows through provider-specific exceptions;
  bounded editor projection has removed those paths.
- `packages/client` drains every children page for directory/collection nodes
  and separately calls `/v1/collection`.
- `packages/render/CollectionView.tsx` renders/edit rows through the separate
  page, while `App.tsx` branches on string kinds.
- `ArborClient/Protocol.swift` duplicates all old enums/shapes, and ArborKit's
  `WorkspaceSurface.collection` encodes ontology into presentation.
- wire `WireObject` knows only byte files and physical directories; `_store.*`
  files are opaque binary conflicts, and remote resolution cannot expose row
  nodes.
- Before the first checkpoint, `packages/core/src/logical-url.ts` and Swift
  `LogicalURL.swift` reinterpreted every fragment as `PageID`, emitted that
  fragment, and discarded application query data. The shared locator codec now
  fixes that split; remaining PageID-shaped protocol references and consumer
  owner indexes are migrated in the later phases below.
- Native and `Workspace` maintain useful PageID owner indexes and link-healing
  machinery, but their reference union omits the readable path whenever identity
  is primary. Preserve the indexes/healing behavior behind the uniform
  tree/path/key reference and new locator codecs rather than deleting it.
- fixtures and tests canonize the split in `node.json`, `children.json`,
  `collection.json`, provider contracts, integration tests, and Swift decoders.

Before editing, refresh this inventory with `rg` and record newly added call
sites. Preserve unrelated dirty work and separately authorized native sync
changes.

## Target protocol model

Freeze exact language-neutral JSON/CBOR fixtures before implementation. The
target information model should be equivalent to:

```ts
type NodeRef = {
  tree: TreeRef;
  path: LogicalPath;
  stableKey: string | null;
};

type IdentityRule = {
  properties: string[];
};

type ChildRepresentationSummary =
  | { type: "expanded" }
  | {
      type: "rollup";
      codec: "csv" | "json" | "jsonl" | "sqlite";
      scope: "children" | "subtree";
      modelDigest: Hash;
    }
  | { type: "external"; driver: string };

type NodeCapabilities = {
  properties?: {
    revision: string;
    schema?: Hash;
    writable: boolean;
  };
  content?: {
    revision: string;
    mediaType: string;
    format?: "markdown" | "mdx" | "tsx" | "json";
    writable: boolean;
  };
  children?: {
    revision: string;
    schema?: Hash;
    representation?: ChildRepresentationSummary;
    total?: number;
    writable: boolean;
  };
  executable?: {
    version: Hash;
    state: "runnable" | "diagnostic" | "inactive";
  };
};

type NodeContent = {
  source: string;
  representation?: {
    state: "stored" | "implicit";
    origin?: "sibling" | "index";
  };
};

type NodeSnapshot = {
  ref: ResolvedNodeRef;
  name: string;
  revision: string;
  properties: Record<string, unknown>;
  capabilities: NodeCapabilities;
  content?: NodeContent;
  diagnostics: Diagnostic[];
  materialization: "available" | "placeholder";
  observedThrough: EventCursor;
};

type NodeSummary = {
  ref: ResolvedNodeRef;
  name: string;
  revision: string;
  properties: Record<string, unknown>;
  capabilities: NodeCapabilities;
  materialization: "available" | "placeholder";
  diagnostics: Diagnostic[];
};

type ChildrenPage = {
  parent: ResolvedNodeRef;
  items: NodeSummary[];
  nextCursor: string | null;
  observedThrough: EventCursor;
};

type WritePropertiesOperation = {
  op: "writeProperties";
  ref: NodeRef;
  basePropertiesRevision: string;
  // Complete candidate map. Omission deletes; JSON null remains a value.
  properties: Record<string, JSONValue>;
};
```

The precise serialized form is decided in Phase 0. Preserve these invariants:

- `ref` is the sole scope/location/identity carrier; do not duplicate top-level
  `tree` and `path` conveniences on the wire.
- Physical provider kinds are internal dispatch facts, never public identity.
- Capabilities, not kind strings, decide whether clients can edit content,
  enumerate children, render properties, run an executable, or fetch bytes.
- A Markdown provider may map property and content revisions to the same exact
  source byte revision, but clients address the two capabilities separately.
- `writeProperties` is provider-neutral. It replaces the complete property map
  under `basePropertiesRevision`; it never changes the logical content value,
  children, or stable identity as an implicit side effect. A Markdown provider
  may advance the shared exact-source/content revision because frontmatter and
  body occupy the same authored byte stream, while preserving the body exactly.
- A row's columns are `properties`; optional Markdown body is `content`; nested
  relations/materialized subcollections may be `children`.
- `children` returns enough projected properties and schema metadata for table
  rendering without N+1 node fetches.
- Children cursors are provider-bound keyset cursors. File cursors bind to an
  exact source revision; database cursors bind to schema and a committed
  observation boundary without claiming a whole-database revision.
  Positional/offset cursors are allowed only for explicitly read-only,
  identity-less sources.
- `revision` represents the coherent node state; capability revisions provide
  narrower concurrency/invalidation boundaries where the provider can prove
  them.

## Stable identity and paths

- Make every public and internal node reference the uniform triple `(tree,
  current path, stable key or null)`. Never replace or omit the path merely
  because a stable key exists.
- Derive the third component through one schema `IdentityRule`; do not expose a
  `page | row` identity union or another public node taxonomy. The rule's
  declaration site supplies its keyspace: a tree declaration indexes that tree,
  while a children declaration indexes that parent's child set. Do not repeat
  that fact as a public `scope` discriminator.
- Preserve PageID behavior across Markdown rename/move.
- Add the canonical collection-scoped row identity from `spec/06-stores.md` to
  TypeScript, Swift, locators, fixtures, search results, backlinks, mutation
  effects, and recovery records.
- Generate row child path components deterministically from the primary key;
  readable link labels remain independent.
- Changing a primary key is delete/create. Ordinary row mutation cannot mutate
  identity.
- A stale path may be checked or healed through a non-null key only within the
  keyspace implied by the addressed schema declaration site.
- Duplicate/invalid keys disable durable references and mutation. Never fall
  back to row position.

## Child representations and rollups

Implement one provider boundary for logical child sets. The completed local
boundary is equivalent to:

```ts
interface ChildProvider {
  snapshot(ref: NodeRef, observedThrough: EventCursor): Promise<NodeSnapshot>;
  children(ref: NodeRef, cursor: string | null, observedThrough: EventCursor): Promise<ChildrenPage>;
  writeTarget(ref: NodeRef): Promise<PropertyWriteTarget | null>;
}
```

The boundary also owns provider-specific preparation/commit helpers behind
`writeTarget`; those helpers are not a second public mutation API. Filesystem
observation is supplied separately. Data 005 owns the database read-session and
committed-observation interface rather than forcing an exact-revision-shaped
`observe` method into this file-provider boundary.

Provider variants:

- expanded filesystem children;
- Markdown-record children;
- `_store.csv`, `_store.json`, and `_store.jsonl` immediate-child rollups;
- `_store.sqlite3` provider-owned database table/row subtree;
- `_store.yaml` driver-dispatched external providers supplied later by Data 004;
  and
- later Data 001 replicated materializations using the same logical objects.

For file rollups, the exact bytes/source revision and schema-normalized, store-scoped model
digest are separate. The digest is not a universal serialization/hash of the
Arbor data model. A formatting-only JSON/CSV change advances authored tree state
but does not change row identities or query dependencies. A backing migration
can change representation while retaining model-state equivalence and the same
scoped digest.

## Directory documents and the bounded marker

Replace literal unmatched-child expansion with the specified standalone
`<!-- arbor:children -->` marker for every provider:

- first standalone links still claim explicit authored positions;
- one explicit marker places all otherwise-unmentioned children;
- absence means one implicit marker after authored source;
- multiple markers are a blocking diagnostic;
- removing an explicit link returns the child to the marker;
- reads never serialize every virtual row into Markdown;
- parent placement revision combines exact source with stable child generation;
  and
- local filesystem, managed tree, offline replica, remote wire, collection,
  table, and public rendering use the same conformance corpus.

Collection-specific child filtering is deleted. Directory source remains exact;
the editor projects physical children through the shared bounded-placement
contract without serializing generated links.

## Mutations and constraints

Keep three operations distinct while using one node model:

- generic `writeProperties`, exact-content writes, and structural node
  operations for direct authored editing;
- named executable `mutate` intent for transactions, authorization, foreign
  keys, cascades, and exactly-once receipts; and
- tree `updates` for complete candidate-state synchronization and direct
  external rollup edits.

`writeProperties` is a single-node compare-and-swap, not an escape hatch for
business logic. Omitted properties are deleted, explicit JSON `null` remains a
value, identity properties cannot change, and providers validate the complete
candidate against their schema and local constraints. A primary-key change is
delete/create. SQLite applies the write with foreign-key checking and a durable
provider receipt in the same transaction. Markdown rewrites only frontmatter
and preserves the body exact. CSV/JSON/JSONL compare both logical row and exact
source revisions, validate the complete collection, prepare and fsync a whole
replacement while preserving untouched source spans, then publish it by atomic
rename. This direct operation cannot add, remove, or reorder rows.

A named transaction produces one indivisible accepted logical update containing
all direct and cascading row effects. Candidate-state merge is row-identity
aware but validates the complete resulting schema, uniqueness, foreign keys,
and ordered relationships. It conflicts rather than inventing unseen cascade
intent.

CSV/JSON/JSONL mutation is whole-rollup atomic. Multi-collection foreign keys
require one SQLite/Postgres transaction domain or a future coordinated rollup;
do not claim cross-file atomicity. Direct file edits are decoded into candidate
logical state only after exact-source revision checking.

## Portable query algebra over node children

The executable query API entering this slice was structurally SQLite-specific:

- `QueryHandle` owns exactly one `DatabaseHandle`;
- every `QueryPlan` starts from a relation name;
- `compileQuery` requires `StoreSchema` and the executor emits SQL;
- selection values are fields, relationship selections, and counts only; and
- live dependencies are partitioned into `database` rows plus a special profile
  resolver.

Replace that authored source model with `arbor(path)` everywhere. The first
portable node-set source is `.children`; it has the same meaning for expanded
directories, Markdown records, file rollups, SQLite tables, and later external
or replicated providers. Exact-node, descendant, reference, and backlink
sources can be added to `arbor()` later without introducing a database-specific
root namespace.

The initial universal algebra is deliberately small:

- predicate filtering over schema-known properties using the same comparison
  and logical operators;
- explicit field picking/aliasing from schema-declared node properties;
- `query.one`, `query.maybe`, and `query.many` cardinality assertions; and
- automatic deterministic result order by canonical stable key, falling back
  to canonical path when a source lacks durable child identity.

Joins, relationship expansion, grouping, aggregates, authored ordering,
pagination operators, and unbounded descendant traversal are not part of this
portable baseline. A capable relational provider may retain them as explicit
extensions while migration proceeds, but application code that uses an
extension is not representation-isomorphic until every allowed placement can
prove the same capability. Calling a non-portable operator is a development-time
or activation diagnostic; the runtime never silently emulates an unbounded
database query by loading a whole tree.

The accepted small typed authoring surface uses these names:

```ts
const practices = arbor("./practices").children

export const matchingPractices = query.many(
  practices,
  inputSchema,
  (node, { input }) => ({
    where: node.name.contains(input.text),
    select: node.pick("id", "name", "description"),
  }),
)
```

Properties require a schema before typed comparison. Unschemaed
properties may be selected as validated JSON but do not acquire guessed types.
Generic children preserve node identity. A future relational driver's named
relationship must be an optimized/proved edge over those same nodes, not a
second result ontology or a separately authored node facet.

Application 003 makes this contract statically useful in authored TypeScript and
MDX. Data 002 supplies the provider-neutral schema, source, selection,
sensitivity, and activation inputs it consumes; Data 002 does not choose an
editor adapter or generated declaration layout.

Replace database-only dependency tracking with scoped logical dependencies:
exact node revisions, child-membership generations, property/content fields,
edge/schema fingerprints, mounted tree roots, and authenticated access/profile
facts. Providers translate this sensitivity plan into SQL observation, file
watching, tree watch, or conservative subtree invalidation. Optimization may
change rerun cost but never results or disclosure.

An ordinary-child execution samples its resolved source before reading any
page. Its dependency set includes that source's child-membership revision,
schema revision, and `observedThrough` cursor as well as sampled row revisions.
Every continuation cursor is bound to one membership revision. A live consumer
attaches or replays from the pre-read observation cursor, so an insertion or
removal racing the page reads causes a conservative rerun rather than a gap.

The Wire `QUERY /.arbor/trees/{SourceTreeID}/queries` route executes reviewed
handles from the source-tree manifest regardless of which node providers those
handles read. Its request and event shapes contain no database path, table,
driver, or collection-only concept. The host binds every addressed data tree
and model-state revisions into one coherent execution state before `ready`.

## Wire representation and semantic merge

Evolve the wire directory/object graph so an enclosing node can carry a
versioned file-rollup descriptor referencing:

- codec/format version;
- exact source object hash;
- exact `schema.ts` source object hash;
- schema fingerprint;
- derived schema/codec-scoped model digest; and
- declared provider scope (immediate children versus codec-defined subtree).

The authority recomputes schema and scoped model digests under resource bounds. A
client cannot assert them. `filePatches` remain transport-only compact delivery
for exact rollup bytes.

Extend three-way merge:

1. decode base, candidate, and current rollups with the schema at each coherent
   tree root;
2. compare logical rows by durable key;
3. retain exact current representation formatting where possible while applying
   disjoint candidate semantic changes;
4. validate constraints and the complete scoped model digest;
5. encode the authority's accepted representation; and
6. report row/schema/constraint conflicts with stable node references.

SQLite must still expose row nodes and logical changes, but it does not enter
this exact-source merge. Never byte-merge SQLite pages or hash every row to
manufacture an ordinary read revision. Data 005 owns the reviewed transaction,
observation, checkpoint, and semantic synchronization protocol.

## Original implementation phases — completed or reassigned

The phase list records the migration decomposition used during implementation.
The checkpoint log and closure matrix above are authoritative about delivered
behavior. Compiler/editor activation, representation conversion, Postgres,
database observation/synchronization, and native offline rollup rows were
reassigned intact to the linked follow-on plans rather than silently omitted
from this plan's completion gate.

### Phase 0 — freeze protocol and conformance

- Define the canonical three-part NodeRef/ResolvedNodeRef, schema identity rule,
  node snapshot, summary, capabilities, rollup descriptor, child page, and
  revision forms.
- Add JSON fixtures decoded independently by TypeScript and Swift.
- Add canonical CBOR/hash vectors for rollup descriptors and scoped row-model
  digests.
- Add a provider-neutral fixture corpus covering one logical tree represented
  as Markdown rows, CSV, JSON, JSONL, and SQLite.
- Add identity/resolution fixtures showing the same TreeID in disconnected,
  replicated, and canonically indexed views, including longest-boundary URL
  resolution through a DNS-placed Canopy without treating Canopy placement,
  boundary placement, or URL as tree identity.
- Freeze shared TypeScript/Swift locator vectors for
  `path;arbor-key=<base64url>?application-query#content-fragment`, including
  relative and canonical URLs, percent-encoded literal suffixes, stale-path
  repair, duplicate keys, and legacy PageID-fragment input.
- Freeze Markdown projection vectors for
  `relative/path?application-query#arbor-key=<base64url>`. Prove ordinary
  Markdown navigation still addresses the readable path, native healing retains
  the alias/query, and Arbor HTML rendering converts it to the path suffix.
- Freeze method/path migration: `node` and `children` replace collection paging;
  tree-scoped `queries` and `mutate` use the Wire routes in the spec.
- Freeze generic node-source, selection-graph, edge, value-query, capability,
  and sensitivity-plan fixtures. Prove the same handle over expanded Markdown
  children, CSV/JSON/JSONL rollups, SQLite, and a fake remote provider.
- Freeze the language-neutral schema/source/capability fixtures consumed by
  Application 003. TypeScript declaration and editor fixtures live in that plan.
- Replace pre-release REST v1 atomically across the daemon, TypeScript client,
  Swift client, fixtures, and docs. Do not add REST v2, a compatibility adapter,
  or support two ontologies indefinitely.

### Phase 1 — core types and pure identity/codec helpers

- Replace public `NodeKind`, `ProtocolNodeKind`, `TreeChild`, collection page
  types, and duplicated ref fields in `packages/core`.
- Add canonical schema-key encoding, child path generation, path-attached
  `arbor-key` parsing/emission, application-query/content-fragment preservation,
  the Markdown relative-link alias, schema-scoped row/subtree digesting, and
  file-revision and provider-observation-bound cursor helpers.
- Keep physical `FsNodeKind` private to `@arbor/fs`.
- Port the new types and decoders to `ArborClient/Protocol.swift` before server
  adapters emit them.
- Make malformed/unknown capability fixtures forward-compatible without
  silently granting write or executable capability.

### Phase 2 — unify store schema and providers

- Extract backing-independent schema metadata from `packages/data/src/schema.ts`.
- Reconcile `packages/stores` detection/paging with the SQLite query/mutation
  engine instead of maintaining two store stacks.
- Add `_store.json` array rollups and declared primary keys for CSV/JSON/JSONL.
- Implement stable keys and keyset paging for every mutable backing.
- Make tables and rows resolve through ordinary node/children calls.
- Return projected row properties through `NodeSummary`; remove
  `CollectionPage` generation.
- Preserve actionable invalid-row diagnostics and last usable schema.

### Phase 3 — filesystem and managed-workspace adapters

- Refactor `WorkspaceFS.read/list/write` around properties/content/children
  capabilities while retaining exact Markdown source and physical dispatch.
- Implement the marker placement model and remove child exclusion hooks.
- Refactor `Workspace.node`, `Workspace.children`, `FilesystemService`, and
  `ArborService` to delegate row/table resolution to `ChildProvider`.
- Keep the shared provider boundary free of new Postgres special cases. Removal
  of the existing Postgres virtual-node bridge is Data 004's deletion gate.
- Ensure structural actions, search, backlinks, recovery, Trash, assets,
  placeholders, mounted boundaries, and historical reads consume generic refs.
- Keep local path-only nodes identity-less until promoted/materialized exactly as
  before.

### Phase 4 — REST, clients, and web rendering

- Replace the REST/client `path | { pageID, pathHint }` reference union with
  required `{ tree, path, stableKey }` fields and make `stableKey` explicitly
  nullable.
- Remove `/v1/collection`; add any projection arguments to `/v1/children` in a
  bounded, schema-checked form.
- Stop `packages/client` from eagerly draining every child page during `node()`.
- Replace collection-specific client methods with generic incremental children.
- Rebuild `CollectionView` as one presentation of node properties plus child
  schema, not a separate data API.
- Derive sidebar glyphs, editor admission, file preview, executable rendering,
  and table presentation from capabilities.
- Parse the identity suffix before Canopy canonical-boundary/node routing. On a
  valid stale path, redirect to the current canonical path while preserving the
  suffix and the complete application query. Never expose the suffix through
  executable-document `URLSearchParams`, and never require a fragment for
  server-side identity resolution.
- Translate the Markdown relative-link key alias to the server-visible suffix
  during public and executable Markdown rendering; never emit the alias as the
  final hosted href.
- Update CLI structured output, docs, and external-agent commands so
  `children` is sufficient; remove `collection` as a required operation.

### Phase 5 — Swift and native surfaces

- Update `ArborClient`, `ArborProviders`, `ArborReplica`, `ArborSync`, and
  `ArborKit` together from shared fixtures.
- Let `WorkspaceSurface` remain a presentation choice, but derive it from node
  capabilities; it must not own identity or protocol truth.
- Support paginated row/table navigation and properties without eagerly loading
  an entire collection.
- Preserve document-session admission only when the content capability supports
  exact Markdown editing.
- Replace native `pageID`-as-fragment navigation and healing with the same
  stable-key slot and codecs as TypeScript. Authored Markdown retains the
  `#arbor-key=` compatibility alias; network locators use `;arbor-key=`. Link
  healing rewrites only the readable path and preserves key and application
  query exactly.
- Exercise placeholder, read-only, historical, row, table, rollup, and ordinary
  file surfaces in provider contract tests.

### Phase 6 — wire objects, sync, remote browsing, and merge

- Version/decode rollup descriptors in `@arbor/wire` and independent Swift
  ArborWire.
- Snapshot/materialize rollup sources without exposing reserved files as
  children; validate exact and logical hashes.
- Teach Canopy validation/reachability/object authorization about rollup objects.
- Add stable-row semantic merge and conflict details in Canopy updates.
- Resolve and page remote row nodes without downloading/materializing the whole
  backing when the host can provide a proved projection.
- Apply the same marker placement/public rendering rules remotely.
- Preserve update semantic digest, patch equivalence, request replay,
  `observedThrough`, watch gap recovery, and editor causal acknowledgement.

### Phase 7 — executable data routes and accepted transactions

- Rename/nest Wire routes to
  `QUERY /.arbor/trees/{SourceTreeID}/queries` and
  `POST /.arbor/trees/{SourceTreeID}/mutate`.
- Validate route tree against document/handle tree and name the affected data
  tree/root/update in mutation receipts.
- Make local named mutations durable provisional intents when offline-capable;
  authority execution produces one accepted data-tree transaction update.
- Bind query dependencies to logical node revisions, schema fingerprints, and
  scoped model digests rather than raw SQLite path identity.
- Replace `QueryHandle.database`, relation-root-only `QueryPlan`, SQLite-only
  compilation, and `dependencies.database` with provider-neutral sources,
  selections, and sensitivities. Author every source as `arbor(path)`; do not
  retain a `database()` or `.relations` compatibility namespace.
- Add portable query fixtures for expanded children, Markdown records, file
  rollups, and SQLite rows using the same filters and field picks. Add separate
  capability-extension fixtures for any retained relational joins/aggregates,
  and verify unsupported operators fail before reading data.
- Ensure React Actions, named Wire calls, local runtime, and Canopy use the same
  compiled handles and transaction semantics.

### Phase 8 — delete the old ontology and reconcile documentation

- Delete obsolete enums, adapters, collection endpoints/methods, fixtures, and
  special directory filtering. Application 003 owns generated declarations.
- Update README, local-system/CLI/API/reference docs, active plans, historical
  implementation notes where they describe current behavior, and cross-cutting
  backlog items superseded by this work.
- Keep historical outcome evidence truthful: describe its old POST/collection
  implementation as historical rather than rewriting what previously shipped.
- Use the normative `spec/01-data-model.md` projection/equivalence sections as
  the architecture decision for capabilities versus provider representations
  and rollup semantics; do not create a competing implementation-only model.

## Verification matrix

Data 002 closure proves the common contract rather than claiming the deferred
placement work:

- primary and compound schema identity survive formatting, restart, paging,
  and stale readable-path healing within each implemented representation;
- duplicate, missing, nullable, and invalid keys fail closed for durable
  identity and mutation;
- generic snapshots and children cover expanded directories, Markdown records,
  CSV/JSON/JSONL rollups, SQLite database/table/rows, remote Wire rows,
  placeholders, ordinary files, and diagnostics without `/v1/collection` or
  an N+1 hydration contract;
- TypeScript and Swift independently decode the same capability, locator,
  reference, rollup-descriptor, update, merge, and SSE fixtures;
- bounded directory placement has one shared authored-link/marker meaning and
  never serializes generated virtual children;
- one portable query has the same filtering, field-picking, cardinality,
  ordering, and dependency meaning over expanded and SQLite children;
- an ordinary live query attaches before sampling, narrows exact property
  changes, reruns a racing membership change before the first result, and
  widens safely when observation precision is absent;
- exact file patches and complete rollup objects name the same candidate state;
  Canopy validates bounded rollups and handles disjoint merge, row conflict,
  schema conflict, and malformed graphs;
- local managed/untracked providers, the remote Arbor Sync adapter, Canopy
  public HTTP, browser integration, TypeScript clients, and native clients use
  the same node and locator contracts; and
- accepted tree watch remains replayable and gap-free, with a matching update
  digest as causal acknowledgement distinct from stateless query streaming.

The larger cross-representation corpus and link/search/backlink proof belongs
to Data 003; Postgres conformance belongs to Data 004; restart-safe database
observation, foreign-key races, cascades, and semantic checkpoints belong to
Data 005; native offline row pages belong to Data 006; generated typing and
editor/compiler checks belong to Application 003. Formatting-preserving
semantic merge and very-large placement performance remain explicit
cross-cutting items rather than hidden completion claims.

Closure runs focused tests after every checkpoint, then `bun run typecheck`,
`bun run build`, the complete Bun suite, `bun run test:protocol`, all Swift
package suites, a macOS application build, and `git diff --check`.

## Migration and compatibility rules

- Preserve on-disk authored files byte-for-byte until an authored or provider
  mutation changes them.
- Preserve PageIDs, primary-key row identities, TreeIDs, accepted roots, and
  pending native sync attempts wherever their semantics are unchanged.
- Accept legacy `#<PageID>` and `#row=<key>` locators during a bounded migration,
  but emit only the Markdown-relative `#arbor-key=<base64url>` alias or the
  network `;arbor-key=<base64url>` suffix. Rewrite an unprefixed legacy fragment
  only when it uniquely resolves through the old PageID index; ambiguous cases
  remain diagnostics rather than being guessed.
- If wire object encoding changes, provide an explicit old-object reader and
  new-object writer or a rehearsed one-way authority migration with exact
  object/ref verification. Never make old hashes decode as different content.
- Coordinate TypeScript and Swift protocol changes in one green tranche.
- Do not retain `kind: "collection"` or `CollectionPage` merely to avoid a UI
  migration; presentation adapters may use private enums.
- Do not materialize virtual rows as Markdown files or literal child links.

## STOP conditions

Stop and ask for design review if:

- a provider cannot express rows as stable identity-bearing node children;
- generic children cannot carry the bounded projection needed for tables;
- a proposed public kind enum is required for behavior rather than presentation;
- exact authored representation and model-state equivalence cannot both be
  preserved;
- a rollup candidate cannot be validated without executing untrusted code or
  unbounded loading;
- SQLite would need byte-page merging;
- mutation/merge semantics would silently cascade over unseen concurrent rows;
- remote and local providers would retain different directory placement rules;
- protocol compatibility would require maintaining both collection and node
  ontologies indefinitely; or
- unrelated dirty native/sync work would be overwritten.

## Completion gate

The implemented fixtures containing ordinary files, Markdown with frontmatter
and children, CSV/JSON/JSONL/SQLite child sets, tables, rows, executable query
and mutation handles, and mounted boundaries are navigated and edited through
only generic node, children, content/property mutation, query, and mutate
contracts. Local web, remote Arbor Sync, Canopy, TypeScript clients, and native
clients agree on the common identity, locator, capability, pagination,
placement, Wire-object, and exact-update shapes. Native replicas preserve every
rollup object losslessly; presenting those rows while fully offline is the
explicit Data 006 capability extension rather than a Data 002 claim.

There is no public or private collection-page ontology, no public physical kind
taxonomy, accepted updates understand and semantically merge file-rollup
children, Canopy publicly resolves those rows, and provider-neutral ordinary
queries have selective gap-free snapshot-then-follow behavior. Every retained
Data 002 conformance and integration test passes; the follow-on plans above own
their separate completion gates.
