# Supplies live-site implementation plan

**Status:** The authored reference tree is checked in at [`sites/supplies`](../../sites/supplies). Arbor can browse its source today, but cannot yet execute its MDX/TSX documents.

This plan uses the real Supplies port as the implementation corpus for Arbor's data, scripts, and executable-document work. The existing app at `/Users/joe/src/supplies` stays live and unchanged until the Arbor version has been built, populated, staged, and cut over.

## Target result

One unchanged `sites/supplies` tree runs over its private SQLite data tree:

1. in local `arbor browse`;
2. in local signed macOS Arbor through the same arbord runtime; and
3. at its ordinary canonical HTTP locations after an authority explicitly activates the shared tree.

The authority supplies Arbor users, so Supplies has no login system or application `User` table. Queries stream new authorized result states after related database or profile changes. The browser never receives raw SQLite, store credentials, server handle implementations, or unrelated private rows.

SQLite is the first and only runtime backing needed for this slice. After all three surfaces work, a repeatable importer moves the real Supplies Postgres corpus into SQLite. Add a Postgres runtime driver later only if measured production use supplies a reason.

## Authored tree frozen by the port

```text
sites/supplies/
  _index.md
  Home.mdx
  List.tsx
  Practice.tsx
  Profile.tsx
  MyLists.tsx
  components/
    PracticeSearch.tsx
    PopularLists.tsx
    shared.tsx
  scripts/
    queries.ts                 # only the query used by two documents
    mutations.ts               # only cross-document mutation helpers/handles
  data/
    _index.md
    schema.sql
    _store.sqlite3
```

Each module opens its own cheap relative `database()` handle and destructures only the relations it uses. The compiler canonicalizes those handles to the same nested data-tree identity; there is no `scripts/data.ts` registry. A query or mutation used once stays in its document or component.

`arbor/data` derives relation rows and handle results from the schema and relational return shape. `RowOf<typeof relation>` and `ResultOf<typeof handle>` are available when a name is useful, while `useQuery` and `useMutationAction` infer values without handwritten `PersonValue`, `PracticeValue`, or `ListSummaryValue` copies.

Both `query` and `mutation` accept an ordinary Standard Schema input validator; the port uses Zod directly. Arbor does not maintain a parallel set of `uuid`, `string`, `boolean`, or object-schema constructors. Mutation handlers receive `tx` because the runner wraps every handler in one transaction by default.

Queries return database facts: IDs, policy fields, related rows, counts, and reaction/profile memberships. Components combine those facts with `useUser()` to calculate presentation values such as `canEdit`, `isUser`, and `userReacted`. A server query still filters private rows before disclosure; authorization is not a presentation calculation.

The shared UI exports React components such as `Panel`, `Button`, `TextInput`, `TextArea`, and `Select`, not public class-string constants. Tailwind is built into the Arbor compiler and requires no import or stylesheet.

## Data model

The private data tree uses normalized collections with stable keys:

| Collection | Primary key and important fields |
|---|---|
| `lists` | UUID `id`; ProfileID `owner_profile`; name, about, visibility, kind, edit policy, timestamps |
| `practices` | UUID `id`; name, about, timestamps |
| `practice_authors` | `(practice_id, author_profile)` |
| `list_practices` | `(list_id, practice_id)` plus sortable `position` |
| `list_reactions` | `(list_id, profile)` plus emoji |
| `list_tags` | `(list_id, id)` plus name and optional color |
| `practice_tags` | `(list_id, practice_id, tag_id)` |
| `list_contributors` | `(list_id, profile)` plus first/last contribution times |

Person references are stable Arbor ProfileIDs. Names, handles, portraits, and bios come from live profile trees, not duplicated Supplies identity rows. Email addresses, login codes, credentials, and authority-local account IDs never enter the Supplies database.

Before hosting, `data/` is promoted as a separate private nested tree. The Supplies source-tree execution principal gets reviewed access to it; a website visitor gets only rendered output and validated query results.

## Navigation and component model

Every root `.mdx` or default-exporting `.tsx` file is an ordinary executable Arbor document. `Home.mdx` is served at `Home`, `List.tsx` at `List`, and so on. Links remain ordinary relative anchors such as `List?id=<UUID>&edit`; there is no application entry, route table, path registry, or reserved query key. Each document receives `search: URLSearchParams` and interprets its own query string.

Known destinations use anchors. `useNavigate` performs an ordinary Arbor navigation only when a mutation result supplies the destination, as after creating or duplicating a list. Back, forward, reload, copied URLs, and JavaScript-free navigation retain normal HTTP semantics.

`useUser()` returns the safe optional Arbor user projection. `useUser({ required: true })` suspends before user-dependent queries mount and lets Arbor present its session UI. Supplies never receives credentials or implements authentication.

`useQuery` suspends for its initial result and throws failures into Arbor's document boundary. React hoists authored `<title>` and `<meta>` elements. Arbor's `<Markdown>` renders stored Markdown with ordinary Arbor link and asset semantics. `useMutationAction` adapts mutation handles to React Actions and supplies validated `FormData`, pending state, retry identity, typed result, and sanitized public errors.

## Implementation order

Each phase below names concrete code to add and checks to run. The checked-in Supplies handles are the test corpus throughout; do not substitute a synthetic demo or retrofit the current React Router app.

### Phase 1 — query engine

1. Add an `arbor/data` runtime package with `database`, schema-derived relation handles, `query`, `mutation`, `rel`, `RowOf`, and `ResultOf` public types; accept any Standard Schema-compatible input validator and use Zod in the reference tree.
2. Resolve `database("./data")` and `database("../data")` from the importing Arbor module, cross the nested-tree boundary through existing longest-prefix resolution, and canonicalize both spellings to one store identity.
3. Introspect `sites/supplies/data/schema.sql` and `_store.sqlite3`; generate relation field/nullability/key metadata plus the `arbor_profiles` virtual relation backed by ProfileID trees.
4. Parse the exact `rel` blocks in `PracticeSearch`, `PopularLists`, `Profile`, `Practice`, `List`, and `myLists` into a typed relational IR: named bindings, correlations, simple disclosure predicates, nested `one`/`many`, field aliases, counts, existence, stable keys, ordering, and bounds.
5. Keep the return expression surface to projected fields, nested relations, and specified aggregates. Reject arbitrary computed presentation expressions with a source-located diagnostic. Keep simple server predicates capable of excluding private rows.
6. Compile that IR to parameterized SQLite statements and deterministic result shaping. Reject unknown fields, nullable/cardinality mismatches, ambiguous `one`, unstable ordering, duplicate result keys, and unsupported operators before opening the store.
7. Resolve profile rows in batches, merge their exact tree/ref reads into query dependencies, and ensure a missing or inaccessible profile has explicit nullable/not-found behavior.
8. Exercise each real query against a deterministic nonempty fixture containing public/private lists, authored/authorless practices, memberships, tags, reactions, contributors, and separate profile trees. Snapshot the typed shaped results and SQLite query plans.

Finish the phase by invoking every Supplies query directly in a headless harness, proving that anonymous callers cannot receive private lists and that no query loads the full database into JavaScript.

### Phase 2 — query result streaming

1. Add a committed-change observer to the SQLite store broker. Arbor-owned transactions emit ordered cursor, collection, primary-key, changed-field, and before/after information only after commit.
2. Derive a sensitivity plan from each normalized query: exact rows/fields, predicates that a new row may enter, correlation keys, aggregates, ordering/window boundaries, schema identity, profile-tree refs, and user/access context.
3. Implement snapshot-then-follow subscription startup: begin buffering after a store cursor, execute on a consistent snapshot, compare buffered changes with the new dependency set, rerun if needed, and publish the result with its `observedThrough` cursor.
4. Implement a per-query state machine that unions old/new dependencies while rerunning, coalesces bursts, suppresses identical canonical output hashes, and never publishes a result already invalidated during execution.
5. Start with complete replacement results. Add keyed insert/update/move/remove diffs only for shaped `many` values with stable `key by` and `order by`; keep replacement as the correctness fallback.
6. Multiplex active subscriptions on one ordered SSE stream with subscription IDs, versions, output hashes, acknowledgements, bounded replay, backpressure that retains newest state, and explicit resync after cursor gaps or server restart.
7. Detect external SQLite revision/WAL changes conservatively and invalidate the entire store when exact rows are unavailable. Re-run from a new snapshot rather than inferring row changes from undocumented WAL internals.
8. Test two simultaneous subscriptions, a related update, an unrelated precise update, a possibly-entering insert, top-N reorder, profile edit, mutation-during-rerun race, external commit, disconnect/replay, replay gap, and listener restart.

Finish the phase with a headless two-client test in which related results change without polling, unrelated precise writes produce no rerun, and every forced gap produces a fresh current snapshot.

### Phase 3 — mutation runner

1. Add the mutation execution broker behind `arbor/data`: resolve a compiled handle/version, validate and transform input through its Standard Schema, inject `ArborUser | null`, and expose only reviewed relation/tree capabilities.
2. Capture a caller-stable mutation ID, one logical `now`, and a deterministic generated-ID namespace before handler execution. Store a durable receipt keyed by handle/version/user/input so ambiguous retries return the same committed result.
3. Begin one SQLite transaction before invoking every mutation handler, pass it as `tx`, commit on return, and roll back on throw. Implement the port's `one`, `many`, `insert`, `update`, `upsert`, `delete`, and `deleteWhere` operations on that `tx`; remove any authored transaction wrapper.
4. Implement `tx.ordered(...).append`, `.replace`, and `.remove` with partition locking/serialization, key validation, and position normalization. Never derive append positions from row count.
5. Run user and row-policy checks inside the write transaction. Pass `{ user }` to handlers; reject caller-supplied identity fields as proof of identity.
6. Implement `publicError` sanitization and typed field validation. Convert unexpected errors to generic public failures while retaining private diagnostics server-side.
7. Commit data, retry receipt, and one ordered store change atomically enough that a retry cannot duplicate effects and the streaming scheduler sees changes only after successful commit.
8. Invoke every checked-in Supplies mutation in tests: list create/duplicate/rename/reorder/sharing/kind/tagging/reaction, practice create/edit, membership changes, and contributor recording. Add concurrent append/reorder and authorization race cases.

Finish the phase by replaying ambiguous mutation submissions and proving stable IDs/times/results, one committed effect, no partial multi-row writes, and correct downstream query invalidation.

### Phase 4 — compiler and development typechecking

1. Extend Arbor format recognition so `.mdx` and default-exporting `.tsx` have an extensionless executable surface while remaining readable/editable as exact source. Supporting `.tsx` and `.ts` modules stay import-only.
2. Build the addressed document's explicit MDX/TSX/TS import graph and split it into a public React graph and server-only query/mutation graph. Reject ambient filesystem, network, process, credential, and undeclared-tree access.
3. Read query and mutation input/output types from their Standard Schemas, then generate declarations for `database().relations`, `RowOf`, `ResultOf`, `useQuery`, and `useMutationAction`. Feed diagnostics back to the authored source span rather than a generated file.
4. Typecheck the complete public and server graphs in watch mode whenever a source, schema, imported profile shape, or compiler version changes. Add an `arbor check sites/supplies` command that exits nonzero on source, schema, capability, or portability errors.
5. Compile MDX and TSX into one coherent document version keyed by source TreeID/ref, document path, import graph, schema fingerprint, and pinned compiler versions. Keep generated artifacts in a private reproducible cache, not the authored tree.
6. Compile Tailwind from statically discoverable classes in the public graph without an import, config, stylesheet, or content glob. Preserve ordinary stylesheet imports only as an explicit optional feature.
7. Emit a reviewed manifest containing public bundle/assets, handle metadata/input contracts/result shapes, capabilities, sensitivity plans, schema fingerprints, backing-coupled flags, and runtime feature requirements. Never place server implementation code or private paths in the client manifest.
8. Add compiler fixtures from every Supplies document, verify inferred result types at their component call sites, and add negative fixtures for a complex return expression, forbidden import, undeclared path, invalid query field, dynamic Tailwind fragment, and leaked server handle.

Finish the phase when `arbor check sites/supplies` typechecks the unchanged tree, editor diagnostics identify authored lines, and inspecting bundles confirms that relation/result types are inferred and server implementations are absent.

### Phase 5 — components in `arbor browse` and authority HTTP

1. Add an executable-document surface to shared REST, TypeScript client, Swift client, and ArborKit node models: source kind, coherent version, runnable/diagnostic state, and execution URL. Keep source access available separately.
2. Have arbord render an addressed executable node using the same tree/path/access resolution as ordinary browse. Pass `URLSearchParams`, run mounted queries, server-render React, embed authorized initial results/cursors, and hydrate without duplicate reads.
3. Implement `arbor/react` exactly as used by Supplies: `useQuery`, `skipQuery`, `useMutationAction`, `useUser`, `useNavigate`, `Markdown`, React head hoisting, and accessible default Suspense/error/reconnecting/resync boundaries.
4. Wire React Actions to the mutation runner, correlate receipts with query-stream updates, and preserve JavaScript-free form submission. Keep anchors as normal HTTP links and make `useNavigate` change the ordinary Arbor location.
5. Show the running document in local Arbor web with Arbor chrome, location, provenance, and an explicit source view/edit control. Preserve query strings, back/forward, reload, open-in-new-tab, and copied extensionless URLs.
6. Add explicit per-tree executable hosting to the authority. Activation records a reviewed tree/ref, manifest, private data-tree grants, resource ceilings, and last-known-good version; sharing source alone does not execute it.
7. Resolve authority browser sessions to `ArborUser`, serve enabled documents at their ordinary canonical HTTP paths, run the same SQLite/query/stream/mutation stack, and invalidate affected subscriptions on user switch or revocation.
8. Add browser tests against local and authority hosts with two contexts: SSR/hydration, public/private disclosure, required-user session UI, every Action, live related/unrelated changes, profile edits, reconnect/resync, source rollout, revocation, and absence of SQLite/server code in responses.

Finish the phase when `bun run arbor browse sites/supplies` opens the seeded working site and the unchanged shared tree works at its authority URL with two live clients.

### Phase 6 — components in Arbor native

1. Decode the executable-document REST fixtures in `ArborClient`, add `WorkspaceSurface.executableDocument`, and preserve precise source-only and runtime-unavailable states.
2. In signed macOS Arbor, open the local arbord execution URL in a constrained `WKWebView` while the native tab retains its `WorkspaceLocation`, TreeID, provenance, and normal document controls.
3. Route same-tree links through the native tab model, apply normal external-link policy outside the tree, and keep raw source/view/edit reachable without giving the web content arbord credentials or ambient loopback access.
4. Forward user/session changes, runtime diagnostics, reconnect state, and source-version reloads through the shared protocol instead of inventing native-only behavior.
5. Add Swift provider/client tests for executable surface decoding, source fallback, navigation, revocation, and diagnostics. Add a macOS UI pass for Home, list navigation, an Action, a concurrent browser update, back/forward, reload, source view, and relaunch.
6. After authority HTTP works, let iOS display the authority-hosted executable surface under the same constrained rules. Record a fully offline iOS React/query/SQLite runtime as separate work rather than claiming it from the macOS loopback implementation.

Finish the phase when the signed macOS app runs the local Supplies tree, observes browser mutations live, and returns to exact source without losing native tab identity; verify authority-hosted presentation on iOS separately if included.

### Phase 7 — anything else: fixtures, real data, cutover, and hardening

1. Create a deterministic seed generator for `_store.sqlite3`, separate profile-tree fixtures, schema integrity checks, stable counts, and one root validation command. Replace the current empty fixture before engine acceptance tests rely on it.
2. Build `tools/supplies-import` to read the current Postgres database in one read-only consistent snapshot and write a new SQLite database off to the side. Read credentials only from runtime configuration and redact them from logs/reports.
3. Inventory legacy `List.uuid`, `Space.id`, user IDs/handles, slugs, inbound URLs, `List.extra`, `unlisted`, reactions, profiles, certifications, and unknown fields. Write an explicit preserve/transform/archive decision and machine-readable discrepancy for every category.
4. Map legacy people to stable Arbor ProfileIDs through reviewed evidence; never infer identity solely from display name, email, or mutable handle. Block cutover on unresolved identities or record an explicit reviewed resolution.
5. Convert spaces, authorship, list order, reactions, tags, contributors, and edit policies to the normalized schema. Preserve a durable legacy-ID/redirect map and decide whether legacy URL-accessible `unlisted` becomes a third visibility before importing it.
6. Validate logical row counts, visibility, order, authors, reactions, tags, attribution, text, and representative old URLs. Run the importer twice from the same snapshot and require identical logical output.
7. Install through a recoverable private-tree database swap, stage the real site side-by-side on an authority, run visual/behavioral checks, freeze old writes for a final delta, and retain backups plus a tested rollback before changing the public domain.
8. Measure query reruns, stream volume, SQLite contention, compilation latency, SSR latency, and authority resource use. Add keyed diffs, incremental maintenance, a Postgres runtime driver, or production scaling only in response to those measurements.

Finish the phase when the real Meaning Supplies corpus runs on the authority with reviewed identities, stable redirects, matching content/access/order, recoverable backups, and an exercised rollback path.

## Milestone completion

The slice is complete after the same checked-in source passes all three surfaces; related database and profile changes reach two clients without refresh; unrelated precise changes avoid reruns; reconnects cannot leave stale results; retries cannot duplicate mutations; private rows and raw store bytes remain private; component bundles contain no server capabilities; all person-valued rows use stable Arbor ProfileIDs; and the real-data cutover has passed side-by-side staging and rollback.

## Deliberate cuts

- No Postgres runtime/compiler before SQLite Supplies works end to end.
- No incremental-view engine before dependency-directed reruns and output suppression are measured.
- No arbitrary SQL presented as portable relational authoring.
- No complex presentation expressions in query return shapes.
- No site-specific authentication, route table, application entry, loader/action endpoints, or parallel navigation state.
- No claim that query filtering protects publicly downloadable raw database bytes.
- No Swift rewrite of the React components or a claim that macOS loopback implies fully offline iOS execution.
- No production data or identity mapping committed to source control; only importer code, validation rules, and non-secret reports belong here.
