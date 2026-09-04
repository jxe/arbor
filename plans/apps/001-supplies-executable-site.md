# Apps 001: Complete the Supplies executable site

## Status

- **Priority**: P1
- **Depends on**: completed SQLite query, streaming, and mutation runtimes
  recorded in [`_done/applications`](../_done/applications/README.md), plus
  the provider-neutral node/query contract and core/provider phases in
  [Data 002](../_done/data/002-reconcile-node-data-model.md)
- **Progress**: IN PROGRESS — compiler and development typechecking are owned
  by [Apps 003](003-development-compiler-and-editor-tooling.md), and
  permissioned reader mutation is owned by
  [Apps 004](004-mutation-permissions.md)
- **Reference corpus**: [`examples/supplies`](../../examples/supplies)

## Target result

The unchanged checked-in Supplies tree runs over its private SQLite data tree:

1. in local `arbor open`;
2. in signed macOS Arbor through the same arborsync runtime; and
3. at its ordinary canonical HTTP locations after a Canopy explicitly
   activates the shared tree.

The Canopy supplies Arbor users, so Supplies has no login system or application
`User` table. Queries stream authorized result states after related database or
profile changes. The browser never receives raw SQLite, credentials, server
handle implementations, or unrelated private rows.

The existing app at `/Users/joe/src/supplies` stays live and unchanged until the
Arbor version has been built, populated, staged, and cut over. SQLite is the
only runtime backing required for this milestone; a Postgres runtime driver is
measurement-driven follow-up, not a gate.

## Authored contract frozen by the port

```text
examples/supplies/
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
    queries.ts
    mutations.ts
  data/
    _index.md
    schema.sql
    _store.sqlite3
```

Each module opens its own cheap relative `arbor(path)` handles and selects the
addressed nodes' children. The compiler canonicalizes those imports to the same
nested data-tree identity; there is no central data registry. Queries and mutations use Standard Schema inputs, stable
relationship metadata, inferred `RowOf`/`ResultOf` types, injected Arbor users,
and the implemented transactional runtime.

Person values are stable Arbor ProfileIDs. Names, handles, portraits, and bios
come from profile trees; email addresses, credentials, login codes, and
Canopy-local account IDs never enter Supplies data. Before hosting, `data/` is
promoted as a private nested tree and only the reviewed execution principal can
read it.

Every root `.mdx` or default-exporting `.tsx` file is an ordinary executable
Arbor document. Links remain relative anchors and query strings remain
document-owned; there is no application entry, route table, or parallel
navigation state. Arbor provides `useQuery`, `useMutationAction`, `useUser`,
`useNavigate`, `Markdown`, React head handling, and default loading/error/
reconnecting boundaries.

## Completed prerequisites

The following phases are historical outcomes rather than future instructions:

1. [SQLite query engine](../_done/outcomes.md#supplies-sqlite-query-engine)
2. [Race-free query-result streaming](../_done/outcomes.md#supplies-query-result-streaming)
3. [Transactional mutation runner](../_done/outcomes.md#supplies-transactional-mutation-runner)

Preserve their proved transaction and snapshot-follow behavior. Data 002 must
adapt the SQLite relation engine into the generic node-source query algebra and
dependency model; do not retain its database-root-only public handle merely
because that historical implementation passed.

## Remaining milestone 1 — compiler and development typechecking

Complete [Apps 003](003-development-compiler-and-editor-tooling.md)
against the unchanged Supplies corpus. This application plan consumes its
coherent compiled document and activation manifest; it does not maintain a
second compiler checklist or choose editor-specific typing semantics.

Gate: Apps 003's completion gate passes for `examples/supplies`.

## Remaining milestone 2 — local and Canopy execution

1. Add an executable-document surface to shared REST, TypeScript, Swift, and
   ArborKit models: source kind, coherent version, runnable/diagnostic state,
   and execution URL. Source access remains separate.
2. Have arborsync render an addressed executable node through ordinary Arbor
   tree/path/access resolution, SSR React with authorized initial results, and
   hydrate without duplicate reads.
3. Bind the frozen `arbor/react` surface and React Actions to the implemented
   query/mutation runtimes. Complete [Apps 004](004-mutation-permissions.md) so
   a reader can invoke only explicitly permitted reviewed mutations without
   receiving whole-tree write access. Preserve JavaScript-free form submission,
   ordinary anchors, query strings, back/forward, reload, and copied URLs.
4. Present the running document in local Arbor web with location, provenance,
   diagnostics, and explicit source controls.
5. Add explicit Canopy activation for a reviewed tree/ref, manifest, private
   data grants, resource ceilings, and last-known-good version. Sharing source
   alone never executes it.
6. Resolve Canopy sessions to `ArborUser`, serve enabled documents at ordinary
   canonical paths, and invalidate affected subscriptions on identity changes
   or revocation.
7. Add two-context browser tests covering SSR/hydration, disclosure, required
   users, every Action, related/unrelated changes, profile edits, reconnect,
   rollout, revocation, and absence of SQLite/server code in responses.

Gate: local `arbor open` and the Canopy URL run the same unchanged seeded tree;
two clients converge live and every source/runtime error stays diagnosable.

## Remaining milestone 3 — signed native presentation

1. Decode executable-document fixtures in `ArborClient` and add the matching
   `WorkspaceSurface` case without erasing source-only or unavailable states.
2. In signed macOS Arbor, present the local arborsync execution URL in a
   constrained `WKWebView` while the native tab retains location, TreeID,
   provenance, navigation, and source controls.
3. Route same-tree navigation through the native tab model, use normal external
   link policy, and give web content neither credentials nor ambient loopback
   access.
4. Forward session changes, diagnostics, reconnect state, and version reloads
   through the shared protocol rather than native-only behavior.
5. Verify Home, list navigation, one Action, a concurrent browser update,
   back/forward, reload, source view, and relaunch in the exact macOS artifact.
6. After Canopy HTTP works, iOS may present that hosted surface under the same
   constraints. A fully offline iOS React/SQLite runtime is separate work.

Gate: signed macOS Arbor runs local Supplies and observes browser mutations
without losing native tab identity or exact source access.

## Remaining milestone 4 — fixtures, real data, and cutover

1. Keep the deterministic SQLite/profile fixtures and root validation command
   as the acceptance baseline for every remaining phase.
2. Build a read-only consistent-snapshot importer from the live Supplies
   Postgres database into a new SQLite database. Runtime credentials never enter
   source, logs, or reports.
3. Inventory legacy IDs, users/handles, slugs, inbound URLs, visibility,
   reactions, profiles, certifications, and unknown fields. Record an explicit
   preserve/transform/archive decision for every category.
4. Map people to stable Arbor ProfileIDs through reviewed evidence. Never infer
   identity solely from name, email address, or mutable handle.
5. Preserve ordering, authorship, access, reactions, tags, contributors, text,
   and durable legacy redirects; require deterministic repeated imports.
6. Stage side by side, validate representative old URLs and logical counts,
   freeze old writes for the final delta, and retain recoverable backups plus an
   exercised rollback before changing the public domain.
7. Measure reruns, stream volume, SQLite contention, compilation, SSR latency,
   and Canopy resource use. Add keyed result diffs, incremental maintenance,
   another database driver, or production scaling only from those measurements.

Gate: the real corpus runs on Canopy with reviewed identities, stable redirects,
matching content/access/order, recoverable backups, and a tested rollback.

## Completion gate

The unchanged checked-in source passes local web, signed macOS Arbor, and
canonical Canopy presentation. Related database and profile changes reach two
clients without refresh; unrelated precise changes avoid reruns; reconnects
cannot leave stale results; retries cannot duplicate mutations; private rows
and raw store bytes remain private; component bundles contain no server
capabilities; all person-valued rows use stable ProfileIDs; and the real-data
cutover has passed side-by-side staging and rollback.

## Deliberate cuts

- No Postgres runtime/compiler before SQLite Supplies works end to end.
- No incremental-view engine or keyed transport diffs before measurement.
- No arbitrary SQL presented as portable relational authoring.
- No site-specific authentication, route table, application entry, or parallel
  navigation state.
- No Swift rewrite of React components or claim that macOS loopback implies
  fully offline iOS execution.
- No production data or identity mapping committed to source control.
