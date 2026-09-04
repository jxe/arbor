# Executable documents
*Part of the [Arbor spec](../spec.md): the execution model for portable MDX/TSX documents and agents: named handles, queries, mutations, Arbor user identity, hosting, confinement, consent, and transcripts. The `arbor/react` and `arbor/data` packages a document is written against are the [authoring API](08-authoring-api.md).*

*Owns: handle identity, query and mutation semantics and their routes, user context, compilation, hosting, confinement, the consent statement, the no-ambient-authority rule, and agents. References: the [model and Wire encoding](01-tree-operations.md) for synchronized values and the [authoring API](08-authoring-api.md) for package surfaces.*

Arbor does not add an application object, application identifier, entry component, route table, or location language. A website is an Arbor tree containing ordinary related documents. A host that supports execution may render an authored `.mdx` or `.tsx` document at that document's ordinary canonical Arbor location.

## 1. Documents and navigation

Executable documents use the same logical paths, tree boundaries, canonical server URLs, relative links, moves, and access rules as other Arbor content. For a tree containing:

```text
Home.mdx
List.tsx
Practice.tsx
Profile.tsx
MyLists.tsx
```

the corresponding extensionless locations are `Home`, `List`, `Practice`, `Profile`, and `MyLists`. The source filename does not become a separate route declaration; it is already an Arbor node. A related set of documents needs no root React component to select among them.

Links are ordinary authored links:

```tsx
<a href="Home">Meaning Supplies</a>
<a href={`List?id=${encodeURIComponent(list.id)}`}>{list.name}</a>
<a href={`Practice?id=${encodeURIComponent(practice.id)}&edit`}>Edit</a>
```

Relative resolution and extensionless canonicalization follow [format](02-directory-format.md) and [locators](03-locators.md). A same-tree host may intercept an ordinary link for client navigation, but the link must remain correct as an ordinary HTTP navigation with JavaScript absent. Back, forward, reload, open-in-new-tab, and copying the URL use browser semantics rather than a parallel application history.

The query string belongs to the addressed document, which receives it as an
ordinary search-parameter value ([authoring API](08-authoring-api.md#2-documents)).

The optional path-attached `;arbor-key=...` identity suffix is consumed before
document routing and never appears in `search`. It can therefore heal or
redirect a renamed executable document without taking an application query
parameter away from it. Healing preserves the complete query string unchanged.

There is no reserved `view` parameter, inferred union, generated link constructor, codec, match component, or global list of allowed query keys. A document interprets the parameters it owns. Query and mutation handles still validate their inputs; removing typed navigation does not permit unvalidated values to cross an execution boundary. Unknown parameters may be ignored unless the document deliberately rejects or canonicalizes them.

Fragments retain ordinary document-fragment behavior. A document may also use
a fragment for explicitly client-local state, but node identity, server
rendering, authorization, metadata, and initial live queries cannot depend on
fragment data unavailable to the server.

## 2. Authored component forms

`.md` remains non-executable authored Markdown. `.mdx` combines Markdown composition, frontmatter, explicit ESM imports/exports, and React components. A `.tsx` document is renderable when it has a default component export. Supporting `.tsx` modules without a default component remain importable source rather than hosted views. `.ts` modules may define server handles and shared code.

An MDX body is its default component. Document head elements are ordinary
component output hoisted during server rendering and client updates; there is
no parallel metadata export or metadata read lifecycle, and the server supplies
the canonical Arbor URL independently, so an authored document need not
rediscover it merely to emit the canonical link. Styling and Markdown
rendering facilities belong to the [authoring API](08-authoring-api.md#2-documents);
the pinned compiler version is part of the coherent document version.

Structured editors that cannot preserve MDX or TSX source exactly must use a raw/code-capable mode. They never rewrite executable source as ordinary Markdown.

Executable code—components, query plan callbacks, schema evaluation, mutation handlers, and agent runs—has no ambient authority: filesystem, network, process, clock, randomness, credential, secret, and host APIs are absent unless a separately specified capability or tool grants them. This is the single normative statement of that rule; other sections refer to it.

## 3. Modules and named handles

Executable-document source uses ordinary `.ts` and `.tsx` modules plus explicit `.mdx` documents. Modules may export components, queries, and mutations. `query` and `mutation` are explicit execution-boundary markers; Arbor does not infer a security boundary from an arbitrary export graph. Ordinary `.md` files never become executable merely because another document imports or links them.

A source tree is identified by its existing `TreeID`; Arbor adds no application-ID or script-ID namespace. `(TreeID, logical module path, export name)` identifies a named handle and the compiled code hash identifies its version. Moving a path-identified module or changing an export name creates a different handle; changing handler code changes its version.

For each exported handle, compilation exposes stable function identity, input validation, code version, declared or inferred tree access, and public result metadata without disclosing privileged implementation code. Literal tree paths contribute precise prefixes; computed paths require explicit declarations. Compilation fails when code can address an undeclared path, closes over UI-only state, or imports ambient host authority.

A handle may declare an input schema in the [authoring API](08-authoring-api.md#3-handles)'s
Standard Schema form. The handle's call input is the schema input type; the
query plan or mutation handler receives its validated, transformed output, and
validation occurs before data access.

The tokens this section introduces, and what each survives:

| Token | Identifies | Minted by | Survives |
|---|---|---|---|
| handle | one exported query or mutation, as `(TreeID, module path, export name)` | the author | code changes; not a move or a rename of the export |
| code version | one compiled handle or document | the compiler | moving the source tree; not a code change |
| schema fingerprint | one compiled schema | executing `schema.ts` or introspecting a database | nothing that changes the compiled schema |

## 4. Queries

A query is a deterministic function of `(resolved node snapshots,
validated input, trusted user context)`. Its only data door is a finite,
declarative selection over the scoped logical node model. Authored sources use
`arbor(path)` everywhere. The initial portable node-set source is `.children`,
with the same meaning for expanded directories, Markdown records, collection files,
SQLite tables, and later external or replicated providers. Every result retains
tree-scoped provenance internally even when the authored projection omits it.

`query.one`, `query.maybe`, and `query.many` assert the cardinality of any typed
node source; they do not imply a database relation. The portable callback
returns predicates and explicit field picks/aliases. Predicates that prevent
private nodes or rows from being disclosed stay
in the server plan and are never delegated to a component.

The initial universal symbolic surface is the source's schema-declared
properties. Filtering and field picking behave identically across providers.
Portable collection queries have the same meaning across backings. A database
relation or schema-governed collection is a typed node set within this language,
not a separate query universe. A provider may compile a plan to SQL, indexes,
or tree traversal but cannot change its meaning. Backing-specific relational
operations require an explicitly backing-coupled handle.
Results have automatic deterministic ordering by canonical stable
key, falling back to canonical path; authored ordering is not portable yet
([deferred 8](../spec.md#deferred)).
Relationships, joins, grouping, aggregates, explicit ordering, pagination
operators, and unbounded traversal are capability extensions rather than
baseline semantics ([deferred 8](../spec.md#deferred)). A provider may push a portable plan into SQL, indexes, or
tree traversal, but cannot change its meaning. An unavailable capability fails
before data access rather than silently loading an entire tree into executable
memory. There is no authored `database()` source or `.relations` namespace.

Literal node/store locators are resolved by the development compiler. Declared
property and child schemas generate TypeScript source types;
homogeneous children receive one item type and heterogeneous children a declared
discriminated union. Computed locators require an explicit schema and capability
bound. The compiler never guesses from sampled data. The document manifest pins
the contributing tree roots and schema fingerprints, and activation refuses a
stale plan or keeps the last-known-good version. Inferred row and result types
are exposed by the authoring API, so authored source maintains no second
result schema.

Activation retains each literal's authored spelling together with its resolved
`(TreeID, logical path, schema fingerprint)`; the authored basename is never a
store identity. Before query data access or mutation transaction entry, the
provider verifies that complete binding against the mounted tree, store root,
selected child relation, and active schema. Imported helpers retain the binding
of the module in which their `arbor(path)` was authored. An unbound, ambiguous,
stale, or differently resolved handle is inactive rather than being redirected
to a same-named table in the currently open database.

The return shape selects node/store facts and specified aggregates rather than
running arbitrary presentation code over loaded results. The callback constructs
the plan once at compilation and is not called per node. A backing-coupled query
uses a separately declared escape hatch and carries that fact in its handle and
consent statement.

Live behavior is intrinsic to a query. A one-shot caller evaluates its current
value once; a subscribing caller maintains that same value as a stream of
authorized complete query-result states, never raw driver changes, with the
no-gap, deduplication, and coalescing guarantees of
[§12.1](#121-evaluate-and-stream-named-queries).

A live dependency plan is a set of (provider, observation cursor, precision
scope) entries: the narrowest proved nodes, child membership, property/content
fields, edges, schema fingerprints, mounted roots, and profile/access facts
that can affect the result, each bound to the cursor it was read through
([tree watching](01-tree-operations.md#113-watching)). Providers translate it into committed observation or
conservative subtree/store invalidation. Observation precision is an
optimization and cannot change the result.

For a `.children` source, execution samples the resolved parent before reading
child pages and retains its child membership, schema fingerprint, and
`observedThrough` cursor as a membership dependency. Continuation cursors are
bound to the membership cursor used to create them. A subscriber follows or
replays from the retained pre-read cursor; therefore an insertion or removal
that races sampling or paging forces a rerun and cannot fall into a
snapshot/observation gap. Per-child precision may narrow property invalidation
but do not replace the parent membership dependency.

A query whose nodes are not materialized locally may be hosted by the relevant
server when that host advertises and enforces the same manifest, validation,
access, determinism, and version contract. A read-only placement projection may
materialize a reviewed node query into SQLite and serve its last completely
applied state offline. This specification does not define general cross-server
query discovery, delegated authorization, or server-to-server routing
([deferred 2](../spec.md#deferred)).

## 5. Mutations

A mutation is validated code running against explicit write prefixes. The runner opens one transaction in the selected store and supplies it as `tx`. Returning commits; throwing rolls back. All reads, authorization checks, ordered operations, and writes through `tx` share that transaction. A mutation cannot silently span several transaction domains.

Portable mutable schema includes primary and alternate unique keys, ordered
foreign-key field pairs, nullability, and explicit constraint actions. Primary
keys are immutable. The first portable foreign-key subset supports `restrict`,
`cascade`, and `set-null` on delete, validated at transaction end so declared
deferred or cyclic inserts succeed. `ON UPDATE CASCADE`, `SET DEFAULT`, and
backing-default collation or coercion are not portable. A foreign key may cross
collections only inside one logical data tree and one transaction domain; a
cross-tree Arbor reference is a typed authored property, not a transactional
foreign key. An accepted mutation contains every direct and cascading effect.
Arbor never invents cascade intent for an ambiguous concurrent file edit or
imprecise invalidation, and separate collection files do not imply a shared
transaction domain.

The caller supplies one mutation identity and reuses it for an ambiguous retry;
[§12.2](#122-execute-named-mutations) defines the request digest
that binds it to the handle, code version, validated input, and activated
source bindings, the replay scoping, and the receipt. The runtime captures one
logical mutation time and deterministic generated-ID namespace before
execution; exact retries observe the same values.

The runtime records retry identity and its completed result in the same
transaction domain as the data effects, or uses an equivalent crash-recoverable
mechanism that distinguishes a completed commit from an unexecuted intent after
restart. Backing adapters provide guarded physical commit primitives; they do
not define transaction scope, retry identity, or mutation semantics.

Expected failures are declared public errors with stable codes and safe
messages; other thrown values become a generic internal error without stack
traces, SQL, paths, or private row data.

External side effects and cross-domain workflows require a separately specified effect and consent contract ([deferred 3](../spec.md#deferred)); they are not disguised as deterministic collection mutations.

## 6. Components, imports, and consent

Components run within a confined UI realm. Node data and effects enter through query and mutation handles. The compiler excludes server implementations from client bundles. The [no-ambient-authority rule](#2-authored-component-forms) applies; UI-local timers, focus, and animation do not become data authority.

Cross-tree source imports use absolute Arbor locators and resolve to immutable code identities for one build or execution. Imported handles retain their own declared access; resolving an import cannot silently widen it.

Before first execution in a context, a human-readable consent statement lists the resolved trees, readable prefixes, writable prefixes, hosted execution, any backing-coupled or external capability, and—for an agent run—its tools, transcript destination, and any explicitly granted non-tree effect. Broad or computed declarations remain visibly broad. This is the single definition of the statement's contents, and enforcement must make it true. A host process's broader filesystem or credentials do not become executable-document capabilities. Named handles are callable from human clients and agent tools using the same identity, validation, and authorization.

## 7. Compilation and hosting

Compilation begins from the addressed executable document and follows its explicit import graph. It produces a reviewed document manifest containing:

- source tree `TreeID`, logical document path, and code-version identity;
- public component and asset bundles;
- server-only query and mutation handles with Standard Schema input contracts;
- resolved read/write capabilities and backing-coupled features;
- required tree roots, node/edge schemas, store identities, and schema fingerprints;
- static query results when explicitly baked; and
- live-host requirements.

The document path is ordinary Arbor identity, not an application ID. Moving a path-identified executable document changes its readable URL just as moving another path-identified file does. Imported named handles are identified by tree, module path, and export name; code hashes identify their versions.

An Arbor server explicitly enables executable-document hosting for a tree and grants its tree execution principal the reviewed capabilities required by its compiled documents. Merely adding `.mdx` or `.tsx` source does not publish it, execute it, or grant it access. The host may compile eagerly or on demand, but a request uses one coherent version of the addressed document and all of its handles. An incompatible compilation fails without replacing the last usable version.

Framework filenames do not create mutation endpoints, action routes, loaders, or private-data boundaries. Generated transport endpoints are host protocol details and are never authored or navigable Arbor documents.

## 8. Host and server boundaries

A live Arbor server may run the executable-document runtime adjacent to its Wire API. The roles remain distinct:

- the Arbor server owns tree identity, access, accepted updates, immutable objects, and current-tree watch;
- node/backing providers own traversal, snapshots, committed-change observation,
  and the physical primitives used to realize a commit; and
- the document runtime owns source compilation, query semantics and isolation,
  mutation transaction scope and retry identity, dependency tracking, server
  rendering, live query evaluation, and public result disclosure.

The tree execution principal receives only reviewed tree prefixes, store connections, and operations. A public executable document may read a private backing tree, but only validated rendered output and query results are disclosed. Raw stores, credentials, server handle source, diagnostics containing private values, and unrelated rows never enter the browser bundle or public response.

Executable-document subscriptions are not accepted-update history and do not
independently grant accepted-snapshot access. A mutation of an Arbor-canonical
data tree produces an ordinary accepted data-tree update regardless of its
SQLite or Postgres materialization. A mutation of a shared external Postgres
store may update live query results without changing the executable source-tree
ref.

## 9. Arbor user identity and authorization

Executable documents do not define their own password, login-code, or session model. The host resolves the existing Arbor account/device or server browser session and injects an unforgeable user context into queries and mutations:

```ts
type ArborUser = null | {
  profile: TreeID
  community: TreeID
}
```

Server-local account IDs, device IDs, credentials, and mutable handles are not document user identities. Handlers never accept a caller-supplied profile or account ID as proof of identity. Authored rows referring to a person store that profile tree's `TreeID`; current display name, handle, portrait, and other public profile fields are resolved from that profile tree at query time. Profile reads are live dependencies, so a profile edit updates subscribed documents.

A query or mutation may require `user !== null`, but source documents never implement sign-in. Establishing, renewing, switching, and revoking the server browser session is Arbor platform UI. The server rechecks the session on render, each `queries` request, and mutation; revocation terminates existing streams and prevents an unauthorized value from being treated as current.

A component may declare that it cannot execute anonymously; the host then
presents its own session UI before user-dependent queries mount, and an
authored tree never receives credentials or implements authentication. A query
plan may dereference the nullable user profile, or declare that anonymous
execution must fail before data access even when the handle is invoked outside
a component ([authoring API](08-authoring-api.md#5-user)).

Anonymous, Arbor-user, and tree-principal executions are separate cache and subscription contexts. User-dependent queries record the identity and access decision as dependencies. Public executions may be shared only when their inputs, authorization, capabilities, and output are genuinely user-independent.

## 10. Rendering, actions, and live data

The host resolves the requested Arbor path, loads one coherent executable-document version, passes its query string, evaluates mounted query reads, server-renders the component tree, and embeds only validated results plus public handle metadata. Hydration reuses those values.

Live query requests, complete replacement results, authorization, reconnection, and cross-server mutation delivery follow the [wire protocol](#121-evaluate-and-stream-named-queries) and its separate named-mutation operation.

Mutation handles are callable as form actions as well as typed imperative handles. The [authoring API](08-authoring-api.md#4-actions-and-forms)'s action adapter validates form input through the handle's schema, supplies a stable mutation identity, and exposes a typed result, durable receipt, or sanitized public error. Successful return commits the runner-owned transaction; throwing rolls it back.

Server exceptions, database diagnostics, private values, and stack traces never become action state. Expected public errors have stable codes, safe messages, retryability, and optional field errors. The durable receipt and authoritative query result may arrive in either order and are correlated idempotently. Optimistic presentation never displaces the subscribed result as the source of truth.

## 11. Portability and limits

The same source document may be served by any compatible local runtime or
server that provides its declared nodes, stores, and runtime features. A
backing-independent handle cannot change meaning when expanded children,
`_store.sqlite3`, `_store.yaml`, or a placement SQLite projection supplies its
source; schema compatibility, model hashes, and data migration
are checked before the new handle version is used.

For a query spanning transaction domains, the opaque `observedThrough` value represents the host's cursor vector rather than inventing a global transaction. Cross-server execution requires explicit composition and never acquires authority merely through network reachability.

Static baking may replace explicitly static query reads with compiled results. A document depending on user identity, live data, mutations, or hosted-only capabilities remains an executable-host requirement and cannot silently become static.

## 12. Wire operations

Executable documents use two reviewed logical-model operations. Queries safely
derive current permissioned values without exposing raw stores; mutations
execute reviewed transactional intent. Neither operation is accepted-tree
synchronization, even when a mutation also advances an Arbor-canonical data
tree.

### 12.1 Evaluate and stream named queries

```text
QUERY /.arbor/trees/{SourceTreeID}/queries
Content-Type: application/json
Accept: text/event-stream
```

An execution host may serve a reviewed [executable document](07-executable-documents.md)
while its permitted data lives on the same or another Arbor server. The request
completely describes the coherent document version and its currently mounted
query graph. A server without an executable-document runtime, or without
hosting activated for the source tree, returns `422 unsupported-operation`.

```ts
type QueryCursor = string;

type QueryHandleRef = {
  tree: TreeID;
  module: LogicalPath;
  export: string;
  version: Hash;
};

type QueriesRequest = {
  document: {
    tree: TreeID;
    path: LogicalPath;
    version: Hash;
  };
  queries: Array<{
    id: string;
    handle: QueryHandleRef;
    input: unknown;
    knownOutputHash?: Hash;
  }>;
};
```

`document.tree` must equal the route `SourceTreeID`. The query array is nonempty
and its IDs are nonempty and unique within this request. A handle from another
tree is allowed only when it is an imported reviewed handle in this document's
manifest. The host verifies the coherent document version, reviewed handle
membership, input schema, authenticated user context, effective access, and all
bound node roots, edge/schema fingerprints, and provider identities. The
request and events are independent of whether those nodes are expanded files,
collection files, SQLite, Postgres, mounted trees, or remote providers. A
`knownOutputHash` permits omission of unchanged bytes only after fresh
authorization and reevaluation; it is neither
authorization nor evidence of current state. Output hashes are SHA-256 of the
canonical CBOR encoding of the complete public result.

Every provider translates the reviewed query into conservative logical
sensitivities. An ordinary `.children` query depends on its resolved parent's
membership and schema, the sampled child identities and model hashes, and every
property field used by filtering or selection. A provider-owned mutation may
publish the exact changed property names; an external or imprecise observation
omits them and therefore widens invalidation. Relational providers may prove
narrower row/edge sensitivities, but missing precision never permits a skipped
reevaluation.

The UTF-8 SSE response has these semantic events:

```ts
type PublicQueryError = {
  code: string;
  message: string;
  retryable: boolean;
};

type QueryEvent =
  | {
      type: "result";
      id: string;
      observedThrough: QueryCursor;
      outputHash: Hash;
      value: unknown;
      error?: never;
    }
  | {
      type: "result";
      id: string;
      observedThrough: QueryCursor;
      error: PublicQueryError;
      outputHash?: never;
      value?: never;
    }
  | {
      type: "ready";
      queries: Array<{
        id: string;
        observedThrough: QueryCursor;
        outputHash?: Hash;
      }>;
    }
  | {
      type: "reload";
      reason: "source-changed" | "access-changed";
    };
```

The SSE `event` field supplies `type`; JSON `data` supplies the remaining
members. Each `result` is a complete authorized replacement for one query, not
a raw driver event or patch. `ready` is sent only after every query has
established a race-free snapshot-then-follow boundary. Before `ready`, changed
hashes produce complete `result` values and an unchanged retained value may be
confirmed by its hash in `ready`. Identical output hashes produce no payload.
The observation listener is active before sampling. Events racing evaluation
are checked against both the former and newly sampled dependencies; a relevant
event forces another complete evaluation before that result is published. This
is the no-gap guarantee. It does not require a retained query-event replay log.

`QUERY` has the safe and idempotent semantics defined by
[RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html). Evaluating or
subscribing to a query never performs a mutation. The response is
user/access dependent and long-lived, so it carries `Cache-Control: no-store`;
automatic retry still reauthorizes and reestablishes current state rather than
reusing a cached body.

The response lifetime is the subscription lifetime. There is no durable
execution ID, acknowledgement, SSE replay cursor, or resumable server-side
subscription. Reconnection repeats and reauthorizes the complete `QUERY`. When
the mounted query graph changes, the client opens a complete replacement request
and retains the old response only until the replacement sends `ready`. Source
or access changes send `reload` when possible and close. Listener loss, backing
uncertainty, process restart, or irrecoverable backpressure closes rather than
publishing a result known to be stale; hosts may coalesce intermediate complete
states.

### 12.2 Execute named mutations

Mutation calls carry the reviewed handle identity and version, validated input,
authenticated subject, and caller-stable mutation identity:

```text
POST /.arbor/trees/{SourceTreeID}/mutate
Content-Type: application/json
```

```ts
type MutateRequest = {
  document: {
    tree: TreeID;
    path: LogicalPath;
    version: Hash;
  };
  handle: MutationHandleRef;
  mutationID: string;
  input: unknown;
};

type MutationHandleRef = QueryHandleRef;

type MutationResultReceipt<Result = unknown> = {
  mutationID: string;
  requestDigest: Hash;
  observedThrough: QueryCursor;
  affected?: {
    tree: TreeID;
    update: string;
    root: Hash;
    cursor: EventCursor;
  };
  result: Result;
};
```

`document.tree` must equal the route `SourceTreeID`. The host validates the
document/handle versions and input before opening the transaction domain.
Mutation semantic identity is the SHA-256 of the canonical CBOR encoding of
`{ version: "mutate-v1", handle, input, sources }`, where `sources` is the
activated handle's complete, authored-path-sorted set of
`{ authoredPath, tree, path, schemaFingerprint }` bindings. The bindings are
reviewed manifest state, not caller-selected destinations. This prevents an
ambiguous retry from executing the same code and input against a newly resolved
store, relation, or schema. Durable lookup is scoped by
the source tree, authenticated subject, and `mutationID`. Reusing that identity
with a different request digest is a conflict; an exact ambiguous retry returns
the original receipt and creates no second effect. This is the same committed-
intent pattern as an accepted tree update: transport representation is excluded
from the semantic digest, the subject scopes replay, and the receipt identifies
the committed observation boundary. When the transaction advances an Arbor-
canonical data tree, `affected` identifies its accepted update, Wire root, and
gap-free watch cursor. A shared external-store mutation may omit `affected`
and uses `observedThrough` for the derived-query observation domain. The mutate
payload remains distinct from `UpdateRequest`: it carries reviewed intent and
authorization context, while updates carry complete candidate tree state.

Document React Actions may use the document's ordinary canonical HTTP action
surface, while a named Wire call uses the endpoint above. Both bind through the
compiled manifest and preserve this exact request/receipt identity.
The durable receipt and corresponding query result may arrive in either order;
clients correlate them idempotently and treat the query result as authoritative.

### 12.3 Relationship to tree synchronization

The four operations share authentication, semantic digests, receipts,
observation brokers, SSE framing, and tree-scoped authorization, but not
transaction or replay domains: `updates` and `mutate` have different conflict
domains, and `watch` has retained replay identity while `queries` deliberately
has none. Consolidation is shared machinery, not one polymorphic endpoint.

Query streaming is derived-result delivery, not tree history. A mutation of an
Arbor-canonical data tree advances that data tree's ordinary accepted root and
therefore also causes a `tree.update` watch event; it does not change the
executable document's source-tree root. A mutation of a shared external store can
update query results without an Arbor data-tree update. Neither execution nor
network reachability independently grants accepted-snapshot access, broadens
the readable tree graph, or exposes raw stores, credentials, private handler
source, unrelated rows, or private diagnostics. Cross-server query discovery,
delegated authorization, and server-to-server execution routing remain
unspecified ([deferred 2](../spec.md#deferred)).

## 13. Agents

An agent is an executable document whose body is a prompt. It shares the
no-ambient-authority rule, the consent statement, named handles, and mutation
receipts defined above; this section adds only what is specific to agents.

### 13.1 Agent files

An agent is an ordinary Markdown document. Its body is the primary instruction/prompt; frontmatter declares configuration such as model policy, named tools, context roots or queries, and transcript destination. Model/provider-specific tuning may be present as optional namespaced metadata, but the portable agent remains readable without a proprietary database. The portable frontmatter key set is not yet defined ([deferred 6](../spec.md#deferred)).

An agent file is versioned, linked, shared, and access-controlled like other
authored Markdown. Moving it preserves the stable key derived from its `id`
property; execution uses the resolved tree/path and revision chosen by the
caller.

### 13.2 Tools and context

Every runtime may expose Arbor's built-in read, navigate, search, backlinks,
node-query, and mutation operations. The node-query surface includes schema-
governed collection and relational capabilities when the addressed source
provides them. An agent may additionally name compiled
[executable-document](#3-modules-and-named-handles) query and mutation handles. Each
tool has a typed input/output boundary and retains tree/path provenance in its
results.

Context is assembled from explicit tree roots, locator selections, or deterministic query handles. It is not ambient retrieval over every host-readable file. Context results record their source locator and revision or observation cursor so a transcript can explain what the agent saw.

### 13.3 Confinement

Before execution, the runtime resolves an effective namespace from:

- the agent file's declared roots and tools;
- the caller's visible placements and remote access;
- the selected historical/live revisions; and
- an optional stricter process ceiling.

The intersection is the complete authority. The agent and its tools cannot address a path, tree, credential, network target, or host capability outside it. A tool cannot widen the namespace of the agent that called it. Access changes during a run take effect before subsequent operations.

This specification does not prescribe isolation technology, worker language, or process topology. The [no-ambient-authority rule](#2-authored-component-forms) applies to agents and their tools.

### 13.4 Consent and effects

Before an effectful run, the client presents the [consent statement](#6-components-imports-and-consent) with the agent's effective values, including its tools, transcript destination, and any explicitly granted non-tree effect.

All tree effects pass through ordinary wire or store mutations and produce normal durable receipts, conflicts, events, access checks, and nested-boundary enforcement. An agent cannot make a direct host-filesystem edit and label it an Arbor mutation. Ambiguous mutation retries reuse the original mutation identity.

### 13.5 Transcripts

An effectful run produces a readable transcript as ordinary tree content. It includes the agent identity/revision, caller-approved authority summary, model/runtime identity where available, ordered tool calls and results with secrets redacted, mutation receipts, failures, and final output. Large binary/tool payloads may be referenced by content hash rather than duplicated.

Transcripts are versioned and access-controlled by their destination tree. They never contain raw credentials or access-link secrets. A caller may choose not to persist a read-only exploratory transcript, but an effectful run cannot omit the durable record of its committed mutation receipts.

The same agent can run from the CLI, a human client, or another conforming orchestration client. No Arbor-specific screen or control is required.
