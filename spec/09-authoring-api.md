# Authoring API
*Part of the [Arbor spec](../spec.md): the `arbor/react` and `arbor/data` packages an executable document is written against. This is a library contract versioned with those packages; the execution model it exposes is defined by [executable documents](07-executable-documents.md).*

Package names are part of the authored portability surface: a compatible runtime provides these two modules with these exports, so the same source runs anywhere the [execution model](07-executable-documents.md#portability-and-limits) allows.

## Packages

`arbor/data` is authoring for data and handles: `arbor(path)` logical node sources, schema-derived children handles, `query`, `mutation`, `publicError`, `RowOf`, and `ResultOf`.

`arbor/react` is the component package: `useQuery`, `skipQuery`, `useMutationAction`, imperative mutation access when needed, `useUser`, `useNavigate`, and `Markdown`.

## Documents

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

## Handles

`query.many`, `query.one`, `query.maybe`, and `mutation` accept an optional Standard Schema-compatible input schema. Zod is supported directly, without an Arbor-specific validator vocabulary. The handle's call input is the schema input type; the query plan or mutation handler receives its validated, transformed output. Validation occurs before data access. A no-input query omits the schema and is called as `useQuery(handle)`.

`RowOf` and `ResultOf` expose the types the development compiler infers from declared property and child schemas, so authored source maintains no second result schema.

## Actions and forms

`arbor/react` adapts a mutation handle to React Actions. Form conversion is shallow and deterministic: a name occurring once becomes its string or file value, a repeated name becomes an array in document order, and an omitted name is absent. Coercion belongs to the authored schema. Expected failures use `publicError(code, message, options?)` from `arbor/data`; other thrown values become a generic internal error without stack traces, SQL, paths, or private row data.

`useMutationAction(handle)` returns `[state, action, pending]`. Its Action converts `FormData`, validates it through the handle's Standard Schema, supplies a stable mutation identity, and exposes a typed result, durable receipt, or sanitized public error. Ordinary forms retain React's reset behavior. Expected `MutationActionError` values have stable codes, safe messages, retryability, and optional field errors; server exceptions never become Action state.

`useNavigate` performs an ordinary same-origin Arbor navigation when a destination depends on a mutation result. Anchors remain the default for known destinations; the hook adds no route registry or parallel history model.

## User

`useUser()` returns the optional safe Arbor user projection. `useUser({ required: true })` declares that the mounted component cannot execute anonymously. It suspends before user-dependent queries mount and lets the server present its own session UI; an authored tree never receives credentials or implements authentication. A query plan may dereference the nullable-safe symbolic `user.profile`, or use `user.required.profile` to declare that anonymous execution must fail before data access even when the handle is invoked outside React.

## Rendering

`useQuery` follows React Suspense semantics for its initial value and throws failures to the nearest error boundary.
