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
- **Locator integration still open:** migrate protocol `NodeRef`, REST request
  decoding, browser/native navigation, `ArborReplica`'s private Markdown-link
  parser, search/backlink records, and Canopy boundary resolution/redirects to
  the stable-key slot. Remove the temporary stable-key-to-PageID bridges only
  with that coordinated node-model cutover. These items remain owned by Phases
  3–6 below rather than being mistaken for completed codec work.
- **Next checkpoint:** freeze the shared node-reference, identity-rule,
  capability, snapshot/summary, children-page, and rollup-descriptor fixtures;
  then replace the core TypeScript and Swift protocol shapes in one green
  tranche.

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

## Current split to remove

The live tree currently has several incompatible models:

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
  scope: "tree" | "parent";
  properties: string[];
};

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
```

The precise serialized form is decided in Phase 0. Preserve these invariants:

- `ref` is the sole scope/location/identity carrier; do not duplicate top-level
  `tree` and `path` conveniences on the wire.
- Physical provider kinds are internal dispatch facts, never public identity.
- Capabilities, not kind strings, decide whether clients can edit content,
  enumerate children, render properties, run an executable, or fetch bytes.
- A Markdown node's frontmatter and body share the exact-source concurrency
  boundary even though they project as properties and content.
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
  `page | row` identity union or another public node taxonomy.
- Preserve PageID behavior across Markdown rename/move.
- Add the canonical collection-scoped row identity from `spec/06-stores.md` to
  TypeScript, Swift, locators, fixtures, search results, backlinks, mutation
  effects, and recovery records.
- Generate row child path components deterministically from the primary key;
  readable link labels remain independent.
- Changing a primary key is delete/create. Ordinary row mutation cannot mutate
  identity.
- A stale path may be checked or healed through a non-null key only within the
  key scope declared by the addressed schema.
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

- generic property/content/structural node mutations for authored editing;
- named executable `mutate` intent for transactions, authorization, foreign
  keys, cascades, and exactly-once receipts; and
- tree `updates` for complete candidate-state synchronization and direct
  external rollup edits.

A named transaction produces one indivisible accepted logical update containing
all direct and cascading row effects. Candidate-state merge is row-identity
aware but validates the complete resulting schema, uniqueness, foreign keys,
and ordered relationships. It conflicts rather than inventing unseen cascade
intent.

CSV/JSON/JSONL mutation is whole-rollup atomic. Multi-collection foreign keys
require one SQLite/Postgres transaction domain or a future coordinated rollup;
do not claim cross-file atomicity. Direct file edits are decoded into candidate
logical state only after exact-source revision checking.

## Query algebra over the whole node graph

The current executable query API is structurally SQLite-specific:

- `QueryHandle` owns exactly one `DatabaseHandle`;
- every `QueryPlan` starts from a relation name;
- `compileQuery` requires `StoreSchema` and the executor emits SQL;
- selection values are fields, relationship selections, and counts only; and
- live dependencies are partitioned into `database` rows plus a special profile
  resolver.

Replace that model with one finite declarative node-selection graph. A query
may root at any authorized logical node or node set and may traverse explicit
edges. The portable universal surface includes:

- exact node refs and path-resolved nodes;
- immediate children and explicitly bounded descendants;
- intrinsic identity, name, location, revision, capabilities, and diagnostics;
- typed authored properties and content projections;
- references extracted from typed properties or authored content, plus derived
  backlinks with tree provenance; and
- schema-declared named relationships.

`query.one`, `query.maybe`, and `query.many` remain cardinality assertions over
an arbitrary source, not synonyms for SQL row cardinality. Add a value/object
form that can compose several independent selections in one finite result.
Database relations, file-backed collections, and rollup children implement the
same typed node-set interface. They may additionally advertise relational
capabilities such as joins, correlated relationships, grouping, and aggregates.
Calling an operator that the resolved source cannot preserve is a compile-time
or activation diagnostic; the runtime never emulates an unbounded database
query by silently loading a whole tree.

Freeze a small typed authoring surface in Phase 0. Its information model should
be equivalent to this illustrative form; the exact names remain a Phase 0
fixture/API decision:

```ts
const practices = arbor("./practices").children

export const matchingPractices = query.many(
  practices,
  inputSchema,
  (node, { input }) => ({
    where: node.properties.name.contains(input.text),
    orderBy: node.properties.name,
    select: {
      ref: node.ref,
      name: node.properties.name,
      about: node.content.markdown,
      authors: node.relationship("authors")({
        select: author => ({ ref: author.ref, name: author.properties.name }),
      }),
    },
  }),
)
```

Properties require a schema before typed comparison or ordering. Unschemaed
properties may be selected as validated JSON but do not acquire guessed types.
Content operations require a compatible content capability. Generic children
and reference traversal preserve node identity; a relational driver's named
relationship is an optimized/proved edge over those same nodes, not a second
result ontology or a separately authored node facet.

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
- Decide whether the coordinated breaking REST change increments the protocol
  version or replaces pre-release v1 atomically. Do not support two ontologies
  indefinitely.

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
  selections, edges, and sensitivities. Keep `database(path).relations` only as
  a typed relational capability adapter over logical node sets.
- Add query fixtures for exact node, children, bounded descendants, properties,
  Markdown content, extracted references, backlinks, multiple roots, mounted trees, file
  rollups, and relational joins/aggregates. Verify unsupported capabilities
  fail before reading data.
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
