# Executable documents
*Part of the [Arbor spec](../spec.md): portable MDX/TSX source, named handles, Arbor user identity, rendering, confinement, and consent.*

Arbor does not add an application object, application identifier, entry component, route table, or location language. A website is an Arbor tree containing ordinary related documents. A host that supports execution may render an authored `.mdx` or `.tsx` document at that document's ordinary canonical Arbor location.

## Documents and navigation

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

The query string belongs to the addressed document and is passed as an ordinary `URLSearchParams` value named `search`:

```tsx
export default function List({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) return <p>This link has no list ID.</p>
  return <ListContent id={id} editing={search.has("edit")} />
}
```

The optional path-attached `;arbor-key=...` identity suffix is consumed before
document routing and never appears in `search`. It can therefore heal or
redirect a renamed executable document without taking an application query
parameter away from it. Healing preserves the complete query string unchanged.

There is no reserved `view` parameter, inferred union, generated link constructor, codec, match component, or global list of allowed query keys. A document interprets the parameters it owns. Query and mutation handles still validate their inputs; removing typed navigation does not permit unvalidated values to cross an execution boundary. Unknown parameters may be ignored unless the document deliberately rejects or canonicalizes them.

Fragments retain ordinary document-fragment behavior. A document may also use
a fragment for explicitly client-local state, but node identity, server
rendering, authorization, metadata, and initial live queries cannot depend on
fragment data unavailable to the server.

## Authored component forms

`.md` remains non-executable authored Markdown. `.mdx` combines Markdown composition, frontmatter, explicit ESM imports/exports, and React components. A `.tsx` document is renderable when it has a default component export. Supporting `.tsx` modules without a default component remain importable source rather than hosted views. `.ts` modules may define server handles and shared code.

An MDX body is its default component. Document head elements are ordinary React authoring and are hoisted by React during server rendering and client updates:

```mdx
import { PopularLists } from "./components/PopularLists"

<title>Meaning Supplies</title>
<meta name="description" content="A directory of social practices" />

# Discover and share social practices

<PopularLists />
```

There is no parallel metadata export or metadata read lifecycle. A component renders `<title>`, `<meta>`, `<link>`, and other React-supported head elements from the same query result it uses for visible content. The server supplies the canonical Arbor URL independently, so an authored document need not rediscover it merely to emit the canonical link.

Executable documents have Tailwind available as a compiler capability without an import, stylesheet directive, configuration file, or content glob. Statically discoverable utility classes in the addressed document's public import graph are available, and the pinned Tailwind/compiler version is part of the coherent document version. Constructing class names from arbitrary string fragments is not portable; conditional complete class tokens are. An ordinary imported stylesheet remains available for exceptional CSS, but neither `@import "tailwindcss"` nor a CDN/runtime compiler is part of authored source.

`Markdown` from `arbor/react` renders a Markdown source string with Arbor's ordinary link resolution, safe URL and asset policy, and source semantics. It is the standard way for a component to present stored Markdown; executable documents do not choose a separate third-party Markdown policy accidentally.
For a relative Markdown destination carrying the reserved `#arbor-key=` alias,
it emits the equivalent server-visible path suffix and preserves the authored
application query. It does not forward the reserved identity alias as an HTML
fragment.

Structured editors that cannot preserve MDX or TSX source exactly must use a raw/code-capable mode. They never rewrite executable source as ordinary Markdown. General network, filesystem, process, credential, and host APIs are unavailable in the component realm.

## Modules and named handles

Executable-document source uses ordinary `.ts` and `.tsx` modules plus explicit `.mdx` documents. Modules may export components, queries, and mutations. `query` and `mutation` are explicit execution-boundary markers; Arbor does not infer a security boundary from an arbitrary export graph. Ordinary `.md` files never become executable merely because another document imports or links them.

A source tree is identified by its existing `TreeID`; Arbor adds no application-ID or script-ID namespace. `(TreeID, logical module path, export name)` identifies a named handle and the compiled code hash identifies its version. Moving a path-identified module or changing an export name creates a different handle; changing handler code changes its version.

For each exported handle, compilation exposes stable function identity, input validation, code version, declared or inferred tree access, and public result metadata without disclosing privileged implementation code. Literal tree paths contribute precise prefixes; computed paths require explicit declarations. Compilation fails when code can address an undeclared path, closes over UI-only state, or imports ambient host authority.

`query.value`, `query.many`, `query.one`, `query.maybe`, and `mutation` accept an optional Standard Schema-compatible input schema. Zod is supported directly, without an Arbor-specific validator vocabulary. The handle's call input is the schema input type; the query plan or mutation handler receives its validated, transformed output. Validation occurs before data access. A no-input query omits the schema and is called as `useQuery(handle)`.

## Queries

A query is a deterministic function of `(resolved workspace snapshot,
validated input, trusted user context)`. Its only data door is one finite,
declarative selection graph over the scoped logical node model. It may select an
exact node, immediate children, explicitly bounded descendants, properties,
content, references extracted from those values, derived backlinks,
mounted-tree nodes, and schema-declared relationships.
Every result retains tree-scoped provenance internally even when the authored
public projection omits it.

`query.one`, `query.maybe`, and `query.many` assert the cardinality of any typed
node source; they do not imply a database relation. `query.value` composes a
finite object from several independent selections. Their callbacks return
predicates, ordering, bounds, explicit nested selections, and safe scalar
values. Predicates that prevent private nodes or rows from being disclosed stay
in the server plan and are never delegated to a component.

The universal symbolic node surface includes ref, path/name, revision,
capabilities, diagnostics, declared properties, compatible content projections,
and derived reference edges. A schema-governed collection or database relation is
the same node-set source with additional proved relational capabilities:
relationships, joins, grouping, and aggregates. `database(path).relations`
remains a schema-derived convenience over those node sets, not a parallel
ontology. A provider may push a plan into SQL, indexes, tree traversal, or
search, but cannot change its portable meaning. An unavailable capability or
an unbounded traversal fails before data access rather than silently loading an
entire tree into executable memory.

Literal node/store locators are resolved by the development compiler. Declared
property, content, child, and edge schemas generate TypeScript source types;
homogeneous children receive one item type and heterogeneous children a declared
discriminated union. Computed locators require an explicit schema and capability
bound. The compiler never guesses from sampled data. The document manifest pins
the contributing tree roots and schema fingerprints, and activation refuses a
stale plan or keeps the last-known-good version. `NodeOf`, `RowOf`, and
`ResultOf` expose inferred types, so authored source maintains no second result
schema.

The return shape selects node/store facts and specified aggregates rather than
running arbitrary presentation code over loaded results. The callback constructs
the plan once at compilation and is not called per node. A backing-coupled query
uses a separately declared escape hatch and carries that fact in its handle and
consent statement.

Live behavior is intrinsic to a query. A one-shot caller evaluates its current value once; a subscribing caller maintains that same value. The subscription is a stream of authorized complete query-result states, not raw driver changes. It establishes a race-free snapshot-then-follow boundary, never publishes a result already known to be stale, suppresses identical canonical output hashes, and may skip intermediate states for a slow client because it represents current state rather than an effect log.

A live dependency plan names the narrowest proved node revisions,
child-membership generations, property/content fields, edges, schema
fingerprints, mounted roots, profile/access facts, and provider revisions that
can affect the result. Providers translate it into committed observation or
conservative subtree/store invalidation. Observation precision is an
optimization and cannot change the result.

A query whose nodes are not materialized locally may be hosted by the relevant
server when that host advertises and enforces the same manifest, validation,
access, determinism, and version contract. A read-only placement projection may
materialize a reviewed node query into SQLite and serve its last completely
applied state offline. This specification does not define general cross-server
query discovery, delegated authorization, or server-to-server routing.

## Mutations

A mutation is validated code running against explicit write prefixes. The runner opens one transaction in the selected store and supplies it as `tx`. Returning commits; throwing rolls back. All reads, authorization checks, ordered operations, and writes through `tx` share that transaction. A mutation cannot silently span several transaction domains.

The caller supplies one mutation identity and reuses it for an ambiguous retry. Durable lookup is scoped by source tree, authenticated subject, and mutation ID; a canonical request digest binds that identity to the handle, code version, and validated input, so changed intent conflicts. The runtime captures one logical mutation time and deterministic generated-ID namespace before execution; exact retries observe the same values. A receipt includes the request digest and committed store/tree cursor needed to reconcile related live queries.

`arbor/react` adapts a mutation handle to React Actions. Form conversion is shallow and deterministic: a name occurring once becomes its string or file value, a repeated name becomes an array in document order, and an omitted name is absent. Coercion belongs to the authored schema. Expected failures use `publicError(code, message, options?)` from `arbor/data`; other thrown values become a generic internal error without stack traces, SQL, paths, or private row data.

External side effects and cross-domain workflows require a separately specified effect and consent contract; they are not disguised as deterministic collection mutations.

## Component and data packages

Components are React authoring in TSX or MDX within a confined UI realm. Workspace data and effects enter through query and mutation handles. The compiler excludes server implementations from client bundles. General network and host APIs are absent; UI-local timers, focus, and animation do not become data authority.

The public component package is `arbor/react`; data and handle authoring come from `arbor/data`. The former provides `useQuery`, `skipQuery`, `useMutationAction`, imperative mutation access when needed, `useUser`, `useNavigate`, and `Markdown`. The latter provides logical node sources, `database`, schema-derived callable relation handles, `query`, `mutation`, `publicError`, `NodeOf`, `RowOf`, and `ResultOf`. Package names are part of the authored portability surface.

Cross-tree source imports use absolute Arbor locators and resolve to immutable code identities for one build or execution. Imported handles retain their own declared access; resolving an import cannot silently widen it.

Before first execution in a context, a human-readable consent statement summarizes the resolved trees, read prefixes, write prefixes, hosted execution, and any backing-coupled or external capability. Enforcement must make this statement true. A host process's broader filesystem or credentials do not become executable-document capabilities. Named handles are callable from human clients and agent tools using the same identity, validation, and authorization.

## Compilation and hosting

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

## Host and server boundaries

A live Arbor server may run the executable-document runtime adjacent to its Wire API. The roles remain distinct:

- the Arbor server owns tree identity, access, accepted updates, immutable objects, and current-tree watch;
- node/store providers own traversal, database transactions, snapshots, and committed change observation; and
- the document runtime owns source compilation, query isolation, dependency tracking, server rendering, live query evaluation, and public result disclosure.

The tree execution principal receives only reviewed tree prefixes, store connections, and operations. A public executable document may read a private backing tree, but only validated rendered output and query results are disclosed. Raw stores, credentials, server handle source, diagnostics containing private values, and unrelated rows never enter the browser bundle or public response.

Executable-document subscriptions are not accepted-update history and do not add historical-object access. A mutation of an Arbor-canonical data tree produces an ordinary accepted data-tree update regardless of its SQLite or Postgres materialization. A mutation of a shared external Postgres store may update live query results without changing the executable source-tree ref.

## Arbor user identity and authorization

Executable documents do not define their own password, login-code, or session model. The host resolves the existing Arbor account/device or server browser session and injects an unforgeable user context into queries and mutations:

```ts
type ArborUser = null | {
  profile: ProfileID
  community: TreeID
}
```

Server-local account IDs, device IDs, credentials, and mutable handles are not document user identities. Handlers never accept a caller-supplied profile or account ID as proof of identity. Authored rows referring to a person store `ProfileID`; current display name, handle, portrait, and other public profile fields are resolved from that profile tree at query time. Profile reads are live dependencies, so a profile edit updates subscribed documents.

A query or mutation may require `user !== null`, but source documents never implement sign-in. Establishing, renewing, switching, and revoking the server browser session is Arbor platform UI. The server rechecks the session on render, each `queries` request, and mutation; revocation terminates existing streams and prevents an unauthorized value from being treated as current.

`useUser()` returns the optional safe Arbor user projection. `useUser({ required: true })` declares that the mounted component cannot execute anonymously. It suspends before user-dependent queries mount and lets the server present its own session UI; an authored tree never receives credentials or implements authentication. A query plan may dereference the nullable-safe symbolic `user.profile`, or use `user.required.profile` to declare that anonymous execution must fail before data access even when the handle is invoked outside React.

Anonymous, Arbor-user, and tree-principal executions are separate cache and subscription contexts. User-dependent queries record the identity and access decision as dependencies. Public executions may be shared only when their inputs, authorization, capabilities, and output are genuinely user-independent.

## Rendering, actions, and live data

The host resolves the requested Arbor path, loads one coherent executable-document version, passes its query string, evaluates mounted query reads, server-renders the component tree, and embeds only validated results plus public handle metadata. Hydration reuses those values. `useQuery` follows React Suspense semantics for its initial value and throws failures to the nearest error boundary.

Live query requests, complete replacement results, authorization, reconnection, and cross-server mutation delivery follow the [wire protocol](04-wire.md#15-evaluate-and-stream-named-queries) and its separate named-mutation operation.

Mutation handles are React Actions as well as typed imperative handles. `useMutationAction(handle)` returns `[state, action, pending]`. Its Action converts `FormData`, validates it through the handle's Standard Schema, supplies a stable mutation identity, and exposes a typed result, durable receipt, or sanitized public error. Successful return commits the runner-owned transaction; throwing rolls it back. Ordinary forms retain React's reset behavior.

Server exceptions, database diagnostics, private values, and stack traces never become Action state. Expected `MutationActionError` values have stable codes, safe messages, retryability, and optional field errors. The durable receipt and authoritative query result may arrive in either order and are correlated idempotently. Optimistic presentation never displaces the subscribed result as the source of truth.

`useNavigate` performs an ordinary same-origin Arbor navigation when a destination depends on a mutation result. Anchors remain the default for known destinations; the hook adds no route registry or parallel history model.

## Portability and limits

The same source document may be served by any compatible local runtime or
server that provides its declared nodes, stores, and runtime features. A
backing-independent handle cannot change meaning when expanded children,
`_store.sqlite3`, `_store.yaml`, or a placement SQLite projection supplies its
source; schema compatibility, store-scoped model digests, and data migration
are checked before the new handle version is used.

For a query spanning transaction domains, the opaque `observedThrough` value represents the host's revision vector rather than inventing a global transaction. Cross-server execution requires explicit composition and never acquires authority merely through network reachability.

Static baking may replace explicitly static query reads with compiled results. A document depending on user identity, live data, mutations, or hosted-only capabilities remains an executable-host requirement and cannot silently become static.
