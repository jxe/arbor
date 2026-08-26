# Scripts
*Part of the [Arbor spec](../spec.md): portable script authoring, compilation boundaries, execution, and consent.*

Arbor executable-document code uses ordinary `.ts` and `.tsx` modules plus explicit `.mdx` component documents. Modules may export components, queries, and mutations. `query` and `mutation` are explicit execution-boundary markers; Arbor does not infer a security boundary from an arbitrary export graph. Ordinary `.md` files are authored content and never become executable merely because another document imports or links them.

A source tree is identified by its existing `TreeID`; Arbor adds no application-ID namespace. `(TreeID, logical module path, export name)` identifies a named handle and the compiled code hash identifies its version. Moving a path-identified module or changing an export name creates a different handle; changing handler code changes its version. Reusing a handle with incompatible input or output requires an intentional document-version transition.

## Compiled public surface

For each exported handle, compilation produces a stable function identity, input validation, code identity/version, declared or inferred tree access, and enough result metadata for clients and agents to call it without receiving privileged implementation code.

Literal tree paths contribute precise read/write prefixes. A computed path requires an explicit declaration. Compilation fails when code can address a path not represented by its declared capability, closes over UI-only state, or imports ambient host authority into a handler. Collection predicates intended to remain backing-independent must compile into a driver-executable deterministic form or fail clearly rather than fall back to surprising full-data execution.

The concrete bundler, package graph, intermediate representation, and output files are reference choices.

## Handle input schemas

`query.many`, `query.one`, `query.maybe`, and `mutation` accept a Standard Schema-compatible input schema. Zod is supported directly and is the reference authoring choice, but Arbor does not wrap it in a separate validator vocabulary. A query with no input omits the schema entirely:

```ts
import { z } from "zod"

export const list = query.maybe(
  suppliesData.relations.lists,
  z.object({ id: z.string().uuid() }),
  (list, { input }) => ({
    where: list.id.eq(input.id),
    select: list.pick("id", "name", "about"),
  }),
)
```

The handle's call input is the schema input type; the query plan or mutation handler receives the validated, transformed output type. Validation happens before data access. The compiled handle retains the schema/version identity and public input contract needed for calls and diagnostics without putting privileged handler code in the client. A no-input query is called as `useQuery(handle)`, not with a ceremonial empty object.

## Queries

A query is a deterministic function of `(resolved workspace snapshot, validated input, trusted user context)`. Its only data doors are the scoped Arbor tree API and compiled relational expressions over declared collections. It has no ambient filesystem, network, process, clock, randomness, credential, or undeclared-tree access.

Database work is declared through the callable symbolic relational language in [stores](stores.md). `query.many`, `query.one`, or `query.maybe` declares root cardinality; its callback returns predicates, ordering, bounds, and an explicit nested selection. Schema relationships are callable and may take a compact selection fragment or a configuration containing `where`, `orderBy`, `take`, `after`, `keyBy`, and `select`. The relational result may be followed by bounded deterministic composition with explicit tree/profile reads. The runtime does not infer a database security or performance boundary by observing arbitrary JavaScript property access, and it does not rescue an untranslatable expression with a hidden full-table scan. A backing-coupled query uses a separately declared escape hatch and carries that fact in its handle.

The return shape selects database facts and relational aggregates, not arbitrary presentation expressions. A query may return the owner ID, author rows, reaction profile IDs, edit-policy fields, and counts; the component combines those facts with `useUser()` to calculate `canEdit`, `isUser`, or `userReacted`. Access control is different: predicates that prevent private rows from being disclosed remain in the server query or mutation and are never delegated to a component.

The compiler makes the authored data self-typing. `database(path).relations` exposes schema-derived base and virtual relation handles; their symbolic row scopes expose the named callable relationships in the schema fingerprint. `RowOf<typeof relation>` names a relation row when a component or helper needs it, and `ResultOf<typeof handle>` names a query or mutation result. `useQuery(handle)`, `useQuery(handle, input)`, and `useMutationAction(handle)` infer their values directly, so a site does not maintain parallel `PersonValue`, `PracticeValue`, or `ListSummaryValue` declarations. A named result type, when useful, is an alias such as `type PopularList = ResultOf<typeof popularLists>[number]`, not a second handwritten schema.

`database(path)` is a cheap declarative handle. Each document, component, or shared server module may open the same relative data boundary and destructure the relations it uses; the compiler canonicalizes those handles to one backing identity. A tree needs no central `scripts/data.ts` registry. Single-consumer handles stay beside their consumer, while `scripts/` is only for code with genuine cross-module use.

The compiler derives database dependencies and change sensitivity from the normalized relational plan; the runtime records dynamic tree/profile dependencies produced by the scoped tree API. A dependency may name an exact node or row and projected fields, but filtered and ordered reads also retain their predicate, joins, grouping, ordering, window boundary, schema, relationships, and access decision. Recording only the rows returned by the previous execution is incorrect: a later insert or update outside that row set may enter the result.

A subscription reruns when a committed change may intersect its semantic dependencies. Exact row changes can skip queries that provably cannot change; collection- or store-level changes conservatively rerun every dependent query in that scope. Before/after row images may be tested against a deterministic predicate to avoid unrelated reruns. A portable relation or query may use another as a virtual relation, preserving the combined dependencies, access, and code-version provenance while permitting safe plan composition and predicate pushdown.

Live behavior is intrinsic to a query rather than a distinct query language or `stream` declaration. A one-shot caller evaluates the query's current value once. A subscribing caller asks the runtime to maintain that same value. The subscription is a stream of authorized query-result states, not a stream of raw database row changes.

The runtime establishes subscriptions with a race-free snapshot-then-follow sequence:

1. begin buffering committed changes after an observed store cursor;
2. execute the query against a consistent backing snapshot and collect dependencies;
3. inspect buffered changes after that snapshot;
4. publish only when no buffered change may affect the collected dependencies, otherwise rerun; and
5. atomically replace the result and dependency set while continuing to buffer.

While a rerun is in progress, intersection uses the union of the old and newly collected dependencies. Concurrent invalidations coalesce, but the runtime does not publish a result already known to be stale. Each published result has a canonical output hash, and identical output hashes produce no client payload. Slow clients may skip intermediate replacement states because a query subscription represents current state rather than an effect log. If a connection cannot retain the newest complete state, it closes; reconnecting reevaluates the complete request from a fresh snapshot boundary.

The portable stream shape is a complete replacement result. Driver row changes never cross directly to an untrusted component as if they were query results. Dependency-directed reruns plus output-hash suppression are sufficient for correctness. A later keyed-diff transport or incremental relational-maintenance implementation is an explicit optimization, not part of the initial authored query or subscription contract.

A query whose data is not materialized locally may be hosted by the relevant authority if that host advertises and enforces the same manifest, validation, access, determinism, and version contract. Mixed-authority queries require explicit composition; they never acquire additional authority merely because one runtime can reach both hosts.

## Mutations

A mutation is validated code running against explicit write prefixes. The runner opens one transaction in the selected store before invoking the handler and supplies it as `tx`. Returning commits; throwing rolls back. The handler does not call a transaction wrapper, and a mutation cannot silently span several transaction domains.

```ts
export const renameList = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    name: z.string().trim().min(1),
  }),
  async ({ user, tx, now }, input) => {
    const list = await requireListEditor(tx, input.listId, user)
    await tx.update(lists, { id: list.id }, { name: input.name, updated_at: now })
    return { ok: true }
  },
)
```

All relation reads, authorization checks, ordered operations, and writes performed through `tx` share that transaction. Helpers receive `tx` explicitly. A future workflow that genuinely needs multiple stores or external effects uses a separate effect/workflow contract rather than opting this mutation out of atomicity.

The caller supplies one mutation identity and reuses it for an ambiguous retry. Identity is scoped to the source tree, handle, code version, authenticated subject, and canonical validated input. The runtime captures one logical mutation time and deterministic generated-ID namespace before execution; retries observe those same values. A mutation receipt includes the committed store/tree cursor needed to reconcile related live queries. Query invalidation begins only after commit and is safe whether it reaches a component before or after the HTTP mutation response.

`arbor/react` adapts a compiled mutation handle to React Actions:

```tsx
const [state, action, pending] = useMutationAction(createList)

return (
  <form action={action}>
    <input name="name" required />
    <select name="visibility">
      <option value="public">Public</option>
      <option value="private">Private</option>
    </select>
    <button disabled={pending}>Create list</button>
    {state.error ? <p role="alert">{state.error.message}</p> : null}
  </form>
)
```

The generated action converts `FormData` to an ordinary object, then passes it through the handle's Standard Schema and reports validation through safe field errors. Its state is parameterized by the mutation result and contains no thrown implementation detail. Direct typed invocation remains available for interactions that are not naturally forms. Both call forms share validation, authorization, retry identity, receipts, and authoritative live-query reconciliation.

Form conversion is deliberately shallow and deterministic: a name occurring once becomes its string or file value, a repeated name becomes an array in document order, and an omitted name is absent. Coercion and transformation belong to the authored schema—for example `z.stringbool()` for a form boolean—rather than Arbor trying to infer intent from schema internals. Malformed values, unwanted duplicates, unsupported files, and unknown fields are rejected by that schema. A generated Action also remains a normal host form target when JavaScript is absent.

Mutation code deliberately exposes an expected failure with `publicError(code, message, options?)` from `arbor/data`. Codes are stable and messages and optional field errors must be safe for any caller allowed to invoke the handle. Other thrown values become a generic internal error; stack traces, SQL, paths, and private row data never enter `MutationActionError`.

External side effects or centralized invariants are not disguised as deterministic collection mutations. A future authority action requires a separately specified effect and consent contract.

## Components

Components are ordinary React authoring in TSX or MDX in a confined UI realm. An MDX body or TSX default component export may be rendered at its ordinary Arbor logical path as specified by [executable web documents](applications.md). MDX supplies editorial layout and explicit component composition, not implicit queries, routes, or capabilities. Supporting modules without a default component remain importable code. Workspace data and effects enter through query/mutation handles owned by mounted components. A handle used by one component or document should normally be declared beside that consumer; genuinely shared handles remain shared modules. The compiler extracts server implementations from mixed component modules and never includes them in the client bundle. General network and host APIs are absent. UI-local timers, focus, and animation may exist without becoming data authority.

A component receives an initial query result during server rendering and subscribes to the same handle, validated input, code version, and user context after hydration. `useQuery` suspends until that value exists and throws a query failure to the nearest React error boundary. A skipped query mounts no execution or subscription. The addressed document and its ordinary query string determine the mounted component tree; following an Arbor link changes the active query graph without invoking route loaders or action endpoints. Components may optimistically present a mutation, but the committed query stream is authoritative and reconciles the optimistic state. Client bundles contain public handle metadata and component code, never query/mutation implementation code, store credentials, declared server prefixes, or raw database access.

The public component package is `arbor/react`; data and handle authoring come from `arbor/data`. The former provides `useQuery`, `skipQuery`, `useMutationAction`, imperative mutation access when needed, `useUser`, `useNavigate`, and `Markdown`. The latter provides `database`, schema-derived callable relation handles, `query`, `mutation`, `RowOf`, and `ResultOf`; handle input validation comes from any Standard Schema implementation such as Zod. Package names are part of the authored portability surface and do not include an application abstraction.

Cross-tree script imports use absolute Arbor locators and resolve to immutable code identities for one build/execution. Imported handles retain their own declared access; resolving an import cannot silently widen it.

## Consent and confinement

Before first execution in a context, a human-readable consent statement summarizes the resolved trees, read prefixes, write prefixes, hosted execution, and any backing-coupled or external capability. Enforcement must make this statement true. A host process's broader filesystem or credentials do not become script capabilities.

Scripts are callable through the CLI, human clients, and agent tools using the same handle identity and validation. A client interface may differ; the public semantics do not.
