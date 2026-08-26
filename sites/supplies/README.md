# Meaning Supplies for Arbor

This checked-in tree is the in-progress port of the existing Supplies application and Arbor's executable-site acceptance fixture. It is ordinary authored Arbor content, not a Vite, React Router, or standalone JavaScript package.

When Arbor implements executable documents, hosting should work as follows:

1. Promote `data/` as a private nested Arbor tree and attach either its `_store.sqlite3` or an equivalent `_store.postgres` backing.
2. Promote this folder as an Arbor tree.
3. Give the tree's execution principal read/write access to the private data tree and profile-read access required by the compiled queries.
4. Enable executable-document hosting for the tree on its authority.

Each root `.mdx` or `.tsx` document is an ordinary Arbor location. `Home.mdx` is served at the extensionless `Home` path, `List.tsx` at `List`, and so on. Links are ordinary relative Arbor links. Query parameters belong to the addressed document, such as `List?id=<UUID>&edit`; there is no application entry, route table, location registry, generated link type, or view selector.

The root `_index.md` is ordinary explanatory Arbor content. `Home.mdx` provides editorial layout; interaction-heavy documents remain TSX. A renderable document default-exports its component (the MDX body supplies that default automatically) and receives the request's ordinary `URLSearchParams` as `search`. It renders `<title>` and `<meta>` normally; React hoists them into the document head.

The source intentionally imports proposed `arbor/react` and `arbor/data` APIs that do not exist yet. It is expected not to compile until those Arbor features are implemented. The port itself is the executable design target for those packages.

## Ported so far

- ordinary extensionless Arbor navigation between executable documents;
- normalized SQLite schema with stable UUID/ProfileID keys;
- independently live practice-search and popular-list regions, plus list, practice, profile, my-lists, and edit-choice relational queries;
- React Action forms for create, rename, reorder, membership, reaction, list-sharing, tag, duplicate, and practice-edit mutations;
- Arbor user identity through `useUser` instead of an application user/auth model;
- an MDX home document and TSX list view/edit, practice, profile, and my-lists documents at peer Arbor paths;
- React-hoisted head elements derived from the same live values as visible content;
- built-in zero-configuration Tailwind utilities with no stylesheet or Tailwind import;
- Arbor-native Markdown rendering and default Suspense/error/resync query boundaries;
- required-user gates that delegate session UI to the Arbor authority;
- single-consumer queries and mutations colocated with their document/component;
- relative `database()` handles in each consumer instead of a central data module;
- Zod input schemas for both queries and mutations through the Standard Schema contract;
- mutation handlers receiving a default atomic `tx` instead of wrapping themselves in transactions;
- query-inferred values instead of handwritten person/practice/list DTOs;
- compact `query.many`/`query.maybe` plans with explicit `pick` projections and callable schema relationships;
- database-fact query results with presentation state calculated in React;
- shared `Panel`, `Button`, and form-control components instead of exported class strings;
- partition-safe ordered relation mutations instead of calculating positions from row counts;
- ordinary relative links and result-dependent `useNavigate` calls with no React Router or Prisma imports.

## Known Arbor implementation gaps

- executable MDX/TSX document and data authoring packages;
- callable symbolic-query lowering, relationship metadata, type inference, and SQLite compilation; a Postgres runtime adapter is later and need-driven;
- profile trees as a batchable virtual relation;
- transaction row APIs and retry-stable mutation context;
- SSR/hydration and active-query discovery from the addressed document component;
- React Action adaptation, hoisted-head streaming, built-in Tailwind compilation, Markdown, and document boundaries;
- committed store observation, semantic sensitivity, replacement-result streaming, and fresh reconnect;
- authority browser sessions and tree execution-principal hosting.

## Product question discovered by the port

The existing application calls `unlisted` lists private but allows anyone with the URL to load them. This port currently gives `private` lists owner-only visibility. If secret-link/unlisted sharing is intended, it should become an explicit third visibility mode rather than an accidental property of routing.
