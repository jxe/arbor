# Authoring API
*Part of the [Arbor spec](../spec.md): the `arbor/react` and `arbor/data` packages an executable document is written against. This is a library contract versioned with those packages; the execution model it exposes is defined by [executable documents](07-executable-documents.md).*

*Owns: the `arbor/react` and `arbor/data` exports and their React behavior. References: [executable documents](07-executable-documents.md) for every semantic guarantee.*

Package names are part of the authored portability surface: a compatible runtime provides these two modules with these exports, so the same source runs anywhere the [execution model](07-executable-documents.md#11-portability-and-limits) allows.

## 1. Packages

`arbor/data` is authoring for data and handles: `arbor(path)` logical node sources, schema-derived children handles, `query`, `mutation`, `publicError`, `RowOf`, and `ResultOf`.

`arbor/react` is the component package: `useQuery`, `skipQuery`, `useMutationAction`, `useCanInvoke`, imperative mutation access when needed, `useUser`, `useNavigate`, and `Markdown`.

## 2. Documents

The query string belongs to the addressed document and is passed as an ordinary `URLSearchParams` value named `search`:

```tsx
export default function List({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) return <p>This link has no list ID.</p>
  return <ListContent id={id} editing={search.has("edit")} />
}
```

An MDX body is its default component. Document head elements are ordinary React authoring and are hoisted by React during server rendering and client updates:

```mdx
import { PopularLists } from "./components/PopularLists"

<title>Meaning Supplies</title>
<meta name="description" content="A directory of social practices" />

# Discover and share social practices

<PopularLists />
```

A component renders `<title>`, `<meta>`, `<link>`, and other React-supported head elements from the same query result it uses for visible content.

Executable documents have Tailwind available as a compiler capability without an import, stylesheet directive, configuration file, or content glob. Statically discoverable utility classes in the addressed document's public import graph are available, and the pinned Tailwind/compiler version is part of the coherent document version. Constructing class names from arbitrary string fragments is not portable; conditional complete class tokens are. An ordinary imported stylesheet remains available for exceptional CSS, but neither `@import "tailwindcss"` nor a CDN/runtime compiler is part of authored source.

`Markdown` from `arbor/react` renders a Markdown source string with Arbor's ordinary link resolution, safe URL and asset policy, and source semantics. It is the standard way for a component to present stored Markdown; executable documents do not choose a separate third-party Markdown policy accidentally.
For a relative Markdown destination carrying the reserved `#arbor-key=` alias,
it emits the equivalent server-visible path suffix and preserves the authored
application query. It does not forward the reserved identity alias as an HTML
fragment.

## 3. Handles

`query.many`, `query.one`, `query.maybe`, and `mutation` accept an optional Standard Schema-compatible input schema. Zod is supported directly, without an Arbor-specific validator vocabulary. The handle's call input is the schema input type; the query plan or mutation handler receives its validated, transformed output. Validation occurs before data access. A no-input query omits the schema and is called as `useQuery(handle)`.

Queries and mutations declare `authority: { author: [...], user: [...] }`.
Requirements identify resolved source handles and operations, not credentials or
arbitrary authority-bearing strings supplied by callers. Both parties' requirements
are checked separately, then their granted capabilities combine for execution.
Expansion beyond existing resource rules requires renewed consent; module/export
renames within a code TreeID do not discard grants. Omission never confers ambient
authority. Ordinary caller read permission, including `everyone`, works through code.

The following is illustrative authoring syntax; [Apps 006](../plans/apps/006-durable-authoring.md)
freezes the exact overloads, resource-selection typing and step API using the Supplies
corpus before implementation. The previous `permission()` and `{ requires }` forms
are superseded, not compatibility obligations.

```ts
export const savePractice = mutation({
  input: inputSchema,
  authority: {
    author: [practices.read(), saves.create()],
    user: [notebook.createChildren()],
  },
  async run({ input, user, step }) {
    const prepared = await step("prepare", () => database.transaction(async tx => {
      const practice = await tx.practices.get(input.practiceID)
      return tx.saves.prepare({ practice, user })
    }))
    const page = await step("page", () => notebook.create(prepared.page))
    return page
  },
})
```

Runtime handles choose their provider through [source resolution](03-locators.md#7-source-resolution).
Single-domain handlers retain an implicit runner-owned transaction where declared;
multi-domain handlers use explicit transaction blocks and stable durable steps.
Straight-line handle calls may receive compiler-generated stable steps; loops,
branches or dynamic repetition require explicit keys where stability is not proved.
The runtime owns receipts and deterministic IDs; authors do not implement receipt
or outbox tables. A transaction callback is one atomic step, not a sequence of
independently replayed row writes. Throws roll back only the active transaction.

`useCanInvoke(handle)` reports current requirement coverage or missing consent,
not predicted success of row-dependent checks. The server always reauthorizes.
Workflow action state distinguishes pending, blocked, failed and completed, and
can expose already committed progress without disclosing private backing details.

`RowOf` and `ResultOf` expose the types the development compiler infers from declared property and child schemas, so authored source maintains no second result schema.

## 4. Actions and forms

`arbor/react` adapts a mutation handle to React Actions. Form conversion is shallow and deterministic: a name occurring once becomes its string or file value, a repeated name becomes an array in document order, and an omitted name is absent. Coercion belongs to the authored schema. Expected failures use `publicError(code, message, options?)` from `arbor/data`; other thrown values become a generic internal error without stack traces, SQL, paths, or private row data.

`useMutationAction(handle)` returns `[state, action, pending]`. Its Action converts `FormData`, validates it through the handle's Standard Schema, supplies a stable mutation identity, and exposes a typed result, durable receipt, or sanitized public error. Ordinary forms retain React's reset behavior. Expected `MutationActionError` values have stable codes, safe messages, retryability, and optional field errors; server exceptions never become Action state.

`useNavigate` performs an ordinary same-origin Arbor navigation when a destination depends on a mutation result. Anchors remain the default for known destinations; the hook adds no route registry or parallel history model.

## 5. User

`useUser()` returns the optional safe Arbor user projection. `useUser({ required: true })` declares that the mounted component cannot execute anonymously. It suspends before user-dependent queries mount and lets the server present its own session UI; an authored tree never receives credentials or implements authentication. A query plan may dereference the nullable-safe symbolic `user.profile`, or use `user.required.profile` to declare that anonymous execution must fail before data access even when the handle is invoked outside React.

## 6. Rendering

`useQuery` follows React Suspense semantics for its initial value and throws failures to the nearest error boundary.
