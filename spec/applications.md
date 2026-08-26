# Executable web documents
*Part of the [Arbor spec](../spec.md): authority-hosted MDX/TSX documents, Arbor user identity, server rendering, and live query delivery.*

Arbor does not add an application object, application identifier, entry component, route table, or location language. A website is an Arbor tree containing ordinary related documents. A host that supports execution may render an authored `.mdx` or `.tsx` document at that document's ordinary canonical Arbor location.

## Documents and navigation

Executable documents use the same logical paths, tree boundaries, canonical authority URLs, relative links, moves, and access rules as other Arbor content. For a tree containing:

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

Relative resolution and extensionless canonicalization follow [format](format.md) and [locators](locators.md). A same-tree host may intercept an ordinary link for client navigation, but the link must remain correct as an ordinary HTTP navigation with JavaScript absent. Back, forward, reload, open-in-new-tab, and copying the URL use browser semantics rather than a parallel application history.

The query string belongs to the addressed document and is passed as an ordinary `URLSearchParams` value named `search`:

```tsx
export default function List({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) return <p>This link has no list ID.</p>
  return <ListContent id={id} editing={search.has("edit")} />
}
```

There is no reserved `view` parameter, inferred union, generated link constructor, codec, match component, or global list of allowed query keys. A document interprets the parameters it owns. Query and mutation handles still validate their inputs; removing typed navigation does not permit unvalidated values to cross an execution boundary. Unknown parameters may be ignored unless the document deliberately rejects or canonicalizes them.

Fragments retain ordinary document-fragment and Arbor `PageID` behavior. A document may also use a fragment for explicitly client-local state, but server rendering, authorization, metadata, and initial live queries cannot depend on fragment data unavailable to the server.

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

There is no parallel metadata export or metadata read lifecycle. A component renders `<title>`, `<meta>`, `<link>`, and other React-supported head elements from the same query result it uses for visible content. The authority supplies the canonical Arbor URL independently, so an authored document need not rediscover it merely to emit the canonical link.

Executable documents have Tailwind available as a compiler capability without an import, stylesheet directive, configuration file, or content glob. The compiler scans the addressed document's public import graph for statically discoverable utility classes, emits only the required CSS, and records its pinned Tailwind/compiler version in the coherent document version. Constructing class names from arbitrary string fragments is not portable; conditional complete class tokens are. An ordinary imported stylesheet remains available for exceptional CSS, but neither `@import "tailwindcss"` nor a CDN/runtime compiler is part of authored source.

`Markdown` from `arbor/react` renders a Markdown source string with Arbor's ordinary link resolution, safe URL and asset policy, and source semantics. It is the standard way for a component to present stored Markdown; executable documents do not choose a separate third-party Markdown policy accidentally.

Structured editors that cannot preserve MDX or TSX source exactly must use a raw/code-capable mode. They never rewrite executable source as ordinary Markdown. General network, filesystem, process, credential, and host APIs are unavailable in the component realm.

## Compilation and hosting

Compilation begins from the addressed executable document and follows its explicit import graph. It produces a reviewed document manifest containing:

- source tree `TreeID`, logical document path, and code-version identity;
- public component and asset bundles;
- server-only query and mutation handles with Standard Schema input contracts;
- resolved read/write capabilities and backing-coupled features;
- required collection/schema fingerprints;
- static query results when explicitly baked; and
- live-host requirements.

The document path is ordinary Arbor identity, not an application ID. Moving a path-identified executable document changes its readable URL just as moving another path-identified file does. Imported named handles are identified by tree, module path, and export name; code hashes identify their versions.

An authority explicitly enables executable-document hosting for a tree and grants its tree execution principal the reviewed capabilities required by its compiled documents. Merely adding `.mdx` or `.tsx` source does not publish it, execute it, or grant it access. The host may compile eagerly or on demand, but a request uses one coherent version of the addressed document and all of its handles. An incompatible compilation fails without replacing the last usable version.

Framework filenames do not create mutation endpoints, action routes, loaders, or private-data boundaries. Generated transport endpoints are host protocol details and are never authored or navigable Arbor documents.

## Host and authority boundaries

A live Arbor authority may run the executable-document runtime adjacent to its wire authority. The roles remain distinct:

- the wire authority owns tree identity, access, accepted updates, immutable objects, and current-tree watch;
- store drivers own database transactions, snapshots, and committed change observation; and
- the document runtime owns source compilation, query isolation, dependency tracking, server rendering, live query evaluation, and public result disclosure.

The tree execution principal receives only reviewed tree prefixes, store connections, and operations. A public executable document may read a private backing tree, but only validated rendered output and query results are disclosed. Raw stores, credentials, server handle source, diagnostics containing private values, and unrelated rows never enter the browser bundle or public response.

Executable-document subscriptions are not accepted-update history and do not add historical-object access. A SQLite mutation that advances an authored tree also produces the ordinary tree ref update. A Postgres-backed mutation may update live query results without changing the source tree ref.

## Arbor user identity and authorization

Executable documents do not define their own password, login-code, or session model. The host resolves the existing Arbor account/device or authority browser session and injects an unforgeable user context into queries and mutations:

```ts
type ArborUser = null | {
  profile: ProfileID
  community: TreeID
}
```

Authority-local account IDs, device IDs, credentials, and mutable handles are not document user identities. Scripts never accept a caller-supplied profile or account ID as proof of identity. Authored rows referring to a person store `ProfileID`; current display name, handle, portrait, and other public profile fields are resolved from that profile tree at query time. Profile reads are live dependencies, so a profile edit updates subscribed documents.

A query or mutation may require `user !== null`, but source documents never implement sign-in. Establishing, renewing, switching, and revoking the authority browser session is Arbor platform UI. The authority rechecks the session on render, each query-stream request, and mutation; revocation terminates existing streams and prevents an unauthorized value from being treated as current.

`useUser()` returns the optional safe Arbor user projection. `useUser({ required: true })` declares that the mounted component cannot execute anonymously. It suspends before user-dependent queries mount and lets the authority present its own session UI; Supplies or another authored tree never receives credentials or implements authentication. A query plan that dereferences user fields may likewise declare `require user`, causing an anonymous call to fail before data access even when it is invoked outside React.

Anonymous, Arbor-user, and tree-principal executions are separate cache and subscription contexts. User-dependent queries record the identity and access decision as dependencies. Public executions may be shared only when their inputs, authorization, capabilities, and output are genuinely user-independent.

## Server rendering and live query streams

The host resolves the requested Arbor path, compiles or loads the executable document, passes its query string, evaluates query reads mounted by its component tree, renders it, and embeds only validated results plus public handle/version metadata and canonical output hashes. Hydration reuses those values rather than issuing blind duplicate reads. `useQuery` follows React Suspense semantics for an initial value and throws query failures to an error boundary; it does not return an ambiguous loading/error union. Arbor wraps each addressed document in accessible default loading, error, reconnecting, and revalidating UI. Documents may add narrower React Suspense or error boundaries around independently useful regions.

Live delivery has no durable execution or subscription resource. The client makes one streaming request that completely describes the document and its currently mounted query graph. The lifetime of that HTTP response is the lifetime of those subscriptions: closing it releases them. When the mounted graph changes, the client opens a replacement request describing the new complete graph and may keep the old response only until the replacement reports that it is ready. Navigation naturally replaces the graph; browser history does not retain live authority for previously visited documents.

The common request shape is:

```ts
type QueryCursor = string; // opaque outside one published query state

type QueryHandleRef = {
  tree: string;
  module: string;
  export: string;
  version: Hash;
};

type QueryStreamRequest = {
  document: {
    tree: string;
    path: string;
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

The `queries` array is nonempty. Query IDs are nonempty, unique only within the request, and carry no authority. The host verifies that the document version is coherent, every handle and version belongs to its reviewed manifest, every input validates, and the current subject may execute the resulting graph. It binds each evaluation to the authenticated user/access context and current resolved backing identities. A `knownOutputHash` is only a payload-suppression hint derived from a value the client already holds; the host reauthorizes and reevaluates rather than trusting it as evidence of current state. An output hash is SHA-256 of the RFC 8785 canonical JSON serialization of the complete public result value.

The response is an SSE stream with three event kinds:

```ts
type PublicQueryError = {
  code: string;
  message: string;
  retryable: boolean;
};

type QueryResultEvent =
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
    };

type QueryStreamEvent =
  | QueryResultEvent
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

The SSE `event` field supplies the `type` discriminator and its JSON `data` supplies the remaining members. A `result` has exactly one of `value` or `error`; a value has `outputHash`, while an error is sanitized for the caller. Results are complete replacements. The initial `ready` event is sent only after every requested query has passed the race-free snapshot-then-follow sequence and the stream is following later commits. Before `ready`, the host sends a `result` for every query whose current hash differs from `knownOutputHash`, and may omit the value for an unchanged query because `ready` confirms its hash and new `observedThrough`. Changes after that boundary produce new complete `result` values. Identical canonical output hashes produce no payload.

The stream has no execution ID, acknowledgement, subscription version, replay cursor, or resumable server state. On interruption the client visibly reconnects by repeating the complete request. The host reauthorizes it and establishes fresh snapshot-then-follow boundaries; a new `ready` or `result` makes the retained authorized value current again. Source-version or access-context changes send `reload` when possible and close the response. A request that is already unauthorized or incoherent fails with the host protocol's ordinary HTTP error before streaming begins. Listener loss, backing uncertainty, process restart, or backpressure that cannot retain the newest complete state closes the response rather than guessing or requiring a separate resynchronization API.

The host may coalesce invalidations and queued replacements per query because the stream represents current state rather than an effect log. It may also share identical authorized evaluations internally. Raw driver changes never enter the stream. The initial portable contract has no structural diff form; a future diff extension must retain complete replacement as fallback and prove the client's exact base output hash before applying a patch.

Mutation handles are React Actions as well as typed imperative handles. `useMutationAction(handle)` is a thin typed adapter over React's Action state model and returns `[state, action, pending]`. The action accepts `FormData`, constructs its shallow input object, validates and transforms it through the handle's Standard Schema, supplies a caller-stable mutation ID, serializes submissions for that action instance, and exposes a typed result, durable receipt, or sanitized public error in `state`. The mutation runner invokes the handler inside one default store transaction and supplies `tx`; successful return commits and any throw rolls back. Successful uncontrolled forms receive React's normal reset behavior. Complex gestures may use the same handle imperatively, but ordinary forms do not reimplement `preventDefault`, pending state, retry identity, transaction wrapping, or error plumbing.

Server exceptions, database diagnostics, private values, and stack traces never become action state. A `MutationActionError` has a stable code, safe message, retryability, and optional field errors; mutation code creates an expected one through `publicError`, while unexpected failures are sanitized by the runtime. The durable receipt and related query stream may arrive in either order. A client correlates the mutation ID when available, treats both paths idempotently, and ultimately displays the authoritative subscribed result. Optimistic presentation may use React's ordinary optimistic primitives, but it never displaces the subscribed result as authority.

`useNavigate` performs an ordinary same-origin Arbor navigation for the uncommon case where the destination depends on a mutation result. Anchors remain the default for known destinations; this hook adds no route registry or parallel history model.

## Portability and limits

The same source document may be served locally by arbord or by a live authority when both provide its declared stores and runtime features. A backing-independent handle cannot change meaning when `_store.sqlite3` is replaced by `_store.postgres`; schema compatibility and data migration are checked before the new handle version is used.

A native Arbor client may present an executable document through the same local or authority runtime in a constrained platform web surface. It retains Arbor location, provenance, access, and source-view controls outside that surface; it does not translate the authored React tree into a separate native component implementation. Embedded content receives neither arbord credentials nor ambient access to other loopback services. A client without a compatible runtime keeps the source browsable and reports execution as unavailable.

For a query spanning transaction domains, the opaque `observedThrough` value represents the host's revision vector rather than inventing a global transaction. Cross-authority execution requires explicit composition and never acquires authority merely through network reachability.

Static baking may replace explicitly static query reads with compiled results. A document depending on user identity, live data, mutations, or hosted-only capabilities remains an executable-host requirement and cannot silently become static.
