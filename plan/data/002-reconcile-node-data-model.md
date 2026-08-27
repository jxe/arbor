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
- **State:** IN PROGRESS
- **Depends on:** accepted specification in `spec/01-data-model.md`,
  `spec/02-directory-format.md`, `spec/03-locators.md`, `spec/04-wire.md`, and
  `spec/06-stores.md`
- **Blocks:** Data 001 and the Supplies compiler/runtime binding

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
- **Locator integration still open:** migrate the remaining native presentation
  references, `ArborReplica`'s private Markdown-link parser, PageID-shaped
  search/event payloads, and Canopy boundary resolution/redirects to the
  stable-key slot. Remove the temporary stable-key-to-PageID bridges only with
  that coordinated node-model cutover. These items remain owned by Phases 3–6
  below rather than being mistaken for completed codec work.
- **2026-08-27 — node sampling contract complete:**
  `conformance/node-model.json` freezes the three-part ref, identity rules,
  capabilities, exact-source content, summaries, snapshots, children pages,
  fail-closed forward compatibility, and all four Wire rollup descriptors.
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
  `ChildrenPage`; physical `TreeNode`/`TreeChild` and collection backing records
  are provider-internal. Local, managed, system, mounted, and remote adapters
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
  and their deletion conditions are recorded in the hardening backlog.
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
  hardening debt are aligned. The obsolete authored `database()`/`.relations`
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
  exact content writes accept the same stable row reference. The remaining
  provider-probe and activation-manifest retrofits, plus portable query semantic
  equivalence not completed in this slice, are explicit hardening debt.
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
  JSONL, and SQLite children. Private physical `TreeNode`/`TreeChild` and store
  loading records remain implementation details pending the broader filesystem
  and observation phases.
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
- **Next checkpoint:** generate typed source declarations and the activation
  manifest for ordinary and rolled-up paths, including empty child sets and
  schema fingerprints. Then build the provider-neutral live broker that can
  route those activated handles through Wire `/queries`. No authored query
  syntax change is assumed by this checkpoint; discuss one before adopting it.

## Target result

Arbor exposes one logical node model across files, Markdown documents,
directories, collections, database containers, tables, and rows:

- `TreeID` is the primary global tree identity and canonical URL resolution is
  a secondary index to tree plus path;
- identity, location, properties, content, children, schema, and capabilities
  are independent dimensions;
- `document` and `collection` are capabilities/projections, while file,
  Markdown, CSV, JSON, JSONL, SQLite, and Postgres are representations/providers;
- every table or record is browsed through ordinary `node` and paginated
  `children` operations;
- frontmatter and row columns project through the same node-properties field;
- a separate `/v1/collection`, `CollectionPage`, `CollectionRow`, and public
  `NodeKind` taxonomy no longer exist;
- every reference carries tree, current path, and one nullable stable-key slot;
  PageIDs and collection-scoped row keys populate that same slot;
- rolled-up children participate in tree snapshots, accepted updates,
  semantic merge, watch, search, derived references/backlinks, and directory
  placement; and
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
- `Workspace.directoryDocumentOptions`, `WorkspaceFS`'s
  `includeDirectoryChild`, and remote `isCollectionDirectory` filtering remove
  rows from the otherwise uniform directory-document contract.
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
- Children cursors are revision-bound keyset cursors. Positional/offset cursors
  are allowed only for explicitly read-only, identity-less sources.
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

Implement one provider interface for logical child sets:

```ts
interface ChildProvider {
  describe(node: ResolvedNodeRef, snapshot: ProviderSnapshot): Promise<ChildrenCapability>;
  page(node: ResolvedNodeRef, cursor: string | null, projection: Projection): Promise<ChildrenPage>;
  resolve(ref: NodeRef, snapshot: ProviderSnapshot): Promise<NodeSnapshot | null>;
  prepare(candidate: LogicalTransaction, base: ProviderSnapshot): Promise<PreparedProviderCommit>;
  observe(after: ProviderCursor): AsyncIterable<ProviderChange>;
}
```

Provider variants:

- expanded filesystem children;
- Markdown-record children;
- `_store.csv`, `_store.json`, and `_store.jsonl` immediate-child rollups;
- `_store.sqlite3` provider-owned table/row subtree rollup;
- `_store.yaml` driver-dispatched external providers, initially Postgres; and
- later Data 001 replicated materializations using the same logical objects.

The exact rollup bytes/source revision and schema-normalized, store-scoped model
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

Delete collection-specific child filtering rather than adapting it:

- `Workspace.directoryDocumentOptions`
- `WorkspaceFS` `includeDirectoryChild` parameters
- remote `isCollectionDirectory`/`operationalChildren`
- tests asserting rows are excluded.

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

Make this statically useful in the authored TypeScript workflow. The development
compiler resolves literal Arbor locators against the checked source/tree graph,
loads declared node/child/property/content/edge schemas, and emits private
generated declarations for each source handle. Homogeneous children get one
item type; heterogeneous children get a declared discriminated union and narrow
only through proved schema predicates. Computed paths require an explicit
schema/capability bound. The compiled manifest pins every contributing tree
root and schema fingerprint; activation and execution reject a stale binding
or retain the last-known-good compiled version. Runtime data never determines
TypeScript types and the compiler never guesses a property type from samples.

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
versioned rollup descriptor referencing:

- codec/format version;
- exact source object hash;
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

SQLite may initially conflict as one physical database when semantic merge
cannot be proved, but it must still expose row nodes and logical changes. Never
byte-merge SQLite pages. Add semantic SQLite merging only from consistent
snapshots/transactions and language-neutral vectors.

## Implementation phases

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
- Freeze development-type fixtures for homogeneous children, discriminated
  unions, optional content, references, relational capability refinement, computed
  path declarations, and stale schema fingerprints.
- Replace pre-release REST v1 atomically across the daemon, TypeScript client,
  Swift client, fixtures, and docs. Do not add REST v2, a compatibility adapter,
  or support two ontologies indefinitely.

### Phase 1 — core types and pure identity/codec helpers

- Replace public `NodeKind`, `ProtocolNodeKind`, `TreeChild`, collection page
  types, and duplicated ref fields in `packages/core`.
- Add canonical schema-key encoding, child path generation, path-attached
  `arbor-key` parsing/emission, application-query/content-fragment preservation,
  the Markdown relative-link alias, schema-scoped row/subtree digesting, and
  revision-bound cursor helpers.
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
- Remove Postgres virtual-node and virtual-table special cases.
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

- Delete obsolete enums, adapters, collection endpoints/methods, fixtures,
  special directory filtering, and stale generated declarations.
- Update README, local-system/CLI/API/reference docs, active plans, historical
  implementation notes where they describe current behavior, and hardening
  backlog items superseded by this work.
- Keep historical outcome evidence truthful: describe its old POST/collection
  implementation as historical rather than rewriting what previously shipped.
- Add an architecture decision note explaining capabilities versus provider
  representations and rollup semantics.

## Verification matrix

At minimum, prove:

- one logical fixture has identical refs, properties, children, schema,
  model-state equivalence, and scoped store digests through Markdown, CSV, JSON,
  JSONL, SQLite, and a fake Postgres
  provider;
- primary and compound schema identity survive reorder, formatting, restart,
  paging, representation migration, and readable-path healing;
- duplicate/missing keys disable mutation and durable references;
- generic children render tables without `/v1/collection` or N+1 reads;
- content-only, property-only, children-only, combined Markdown+children,
  row-only, row+content, binary-content, executable, placeholder, historical,
  mounted, and diagnostic nodes decode in TypeScript and Swift;
- bounded marker absence/presence/order/duplicates/promotion/demotion and over
  100k virtual children without O(n) Markdown source;
- exact JSON/CSV formatting-only edits round-trip and avoid false query reruns;
- one provider-neutral query returns the same public value and dependency
  meaning across expanded nodes and each rollup/database representation;
- non-database queries stream through `/queries`, react to content, properties,
  membership, extracted references, mounted roots, and access changes, and never expose raw
  provider details;
- file patches and complete rollup objects produce the same candidate intent;
- disjoint row merge, same-row conflict, key change, schema conflict, foreign-key
  race, and constraint validation;
- local filesystem, managed tree, offline replica, remote Canopy, public HTTP,
  browser, and native presentations agree;
- renamed Markdown, row, and executable-document links resolve identically in
  native and authority HTTP; server rendering receives the stable key;
  application query parameters survive redirects and authored-link healing;
  ordinary Markdown tools still open the relative target path; content
  fragments remain distinct from stable-key aliases;
- snapshot-then-follow has no read/watch gap, expired cursors resync, and a
  matching mutation/update digest is a causal acknowledgement;
- malformed rollup/source/schema/model-digest inputs are rejected under quotas;
  and
- search/backlinks/recovery never lose tree scope or confuse stable-key scopes.

Run focused tests after every phase, then `bun run typecheck`, `bun run build`,
the complete Bun suite, `bun run test:protocol`, Swift package suites, required
macOS/iOS builds, browser E2E for incremental collection presentation, and
`git diff --check`.

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

One fixture tree containing ordinary files, Markdown with frontmatter and
children, CSV/JSON/JSONL/SQLite rollups, tables, rows, an executable document,
and a mounted boundary is navigated and edited through only generic node,
children, content/property mutation, query, and mutate contracts. Local web,
remote Canopy, offline replica, TypeScript client, and native clients agree on
identity, revisions, properties, capabilities, pagination, and placement.
There is no public collection endpoint or kind-based ontology, accepted updates
understand rolled-up children, and every retained conformance and end-to-end
test passes.
