# Apps 003: Compile and typecheck executable Arbor documents

## Status

- **Priority:** P1
- **Effort:** XL
- **State:** PLANNED — deliberately separated from Data 002 so the logical node
  protocol can close without choosing an editor integration architecture.
- **Depends on:** historical
  [Data 002](../_done/data/002-reconcile-node-data-model.md)'s
  provider-neutral node/query contracts and Apps 001's checked-in
  Supplies corpus.
- **Blocks:** Apps 001 local/Canopy execution and Apps 002 hosted
  agents.

## Target result

An authored `.ts`, `.tsx`, or `.mdx` module inside any tracked Arbor tree gets
the same source-located typechecking, completion, activation manifest, and
runtime meaning in `arbor check`, VS Code, Zed, local Arbor, and Canopy. Editor
integration is an adapter over an editor-independent compiler and language
service; no normative type information exists only inside a VS Code plugin.

The common authored source locator is tree-logical rather than database-
specific. This plan must settle the exact `arbor(...)` locator syntax with the
user before changing checked-in applications. A literal locator resolves from
the source module's enclosing tree and placement graph, then pins the resolved
TreeID, logical path, schema fingerprint, and required capabilities in the
activation manifest.

## Portable compiler core

1. Discover the enclosing tracked tree for every source module, including a
   single file opened outside an editor workspace, nested tree boundaries, and
   mounted placements.
2. Build a deterministic `.ts`/`.tsx`/`.mdx` import graph. Keep `.ts` and
   non-default-exporting `.tsx` import-only; expose `.mdx` and default-exporting
   `.tsx` as extensionless executable nodes.
3. Resolve literal Arbor locators against declared node, child, property,
   content, edge, and capability schemas. Empty child sets receive their
   declared type rather than a sample-derived `never` or unchecked JSON type.
4. Emit ordinary TypeScript declarations for source handles, symbolic fields,
   queries, mutations, `NodeOf`, `RowOf`, `ResultOf`, `useQuery`, and
   `useMutationAction`. A normal TypeScript language server must be able to
   consume the declarations without Arbor-specific checker patches.
5. Split public React code from server-only query/mutation implementations and
   reject ambient filesystem, process, network, clock, randomness, credentials,
   dynamic code loading, and undeclared-tree access.
6. Produce a coherent document version from source TreeID/ref, logical path,
   import graph, schemas, generated types, and pinned compiler/runtime versions.
7. Emit a reviewed activation manifest containing public bundles/assets,
   handles and schemas, resolved node sources, sensitivity plans, transaction
   domains, access requirements, capabilities, backing requirements, and
   runtime features. Never put credentials, physical store paths, or server
   implementations in client output.
8. Compile statically discoverable Tailwind classes without requiring authored
   config, imports, stylesheets, or content globs.

## Development typechecking

Implement `arbor check <tree-or-path>` and watch mode over the compiler core.
Diagnostics identify authored spans and distinguish source, schema,
capability, access, and stale-activation failures. Schema, tree placement,
mount, imported profile-shape, or compiler-version changes invalidate exactly
the affected graph.

Generated artifacts are deterministic projections, not canonical tree data.
Keep full generated output in private Arbor state. If ordinary TypeScript tools
need a small tree-local entrypoint or `tsconfig` helper, specify its lifecycle,
sync exclusion, portability, and behavior in an existing user-owned TypeScript
project before creating it.

## Editor-neutral language service

Build one Arbor language server over the same compiler core:

- resolve an absolute opened file to its enclosing TreeID and logical path;
- refresh and cache generated schemas and declarations;
- complete Arbor locators, properties, capabilities, query operators, and
  mutation handles;
- publish source-located diagnostics and stale/offline state;
- navigate between uses, schemas, backing nodes, and generated manifests; and
- compile MDX to virtual TSX with exact source maps.

VS Code and Zed receive thin extensions that start or connect to this service.
VS Code may additionally use a TypeScript language-service plugin; Zed may run
the Arbor service beside `vtsls`. Neither adapter may define types or query
semantics unavailable to `arbor check` and ordinary generated declarations.
Cache the last known good declarations for offline editing and clearly mark
them stale rather than silently discarding type information.

## Bounded portable execution

The current provider-neutral reference evaluator may page a complete ordinary
child source, with an emergency ceiling, before applying the common predicate
and field projection. That fallback is not public query semantics.

- Every activation manifest declares a finite source bound or a provider plan
  whose pushdown and cursor preserve the portable query meaning exactly.
- Reject activation when neither mechanism proves bounded execution.
- SQLite/Postgres collation, coercion, ordering, or null behavior must not
  silently change a portable result; push down only reviewed equivalent
  operations and evaluate the remainder through the shared query core.
- The emergency ceiling remains a diagnostic safety limit, not an authored
  cardinality contract.
- Add cross-provider fixtures comparing full reference evaluation with every
  accepted pushdown and cursor plan.

## Conformance and gates

Add fixtures for homogeneous children, discriminated unions, optional content,
references, relational capability refinement, computed-locator bounds, empty
sources, stale schema fingerprints, nested/mounted trees, and imported helper
modules. Add negative fixtures for invalid paths and fields, dynamic locators,
forbidden imports, capability-dependent operators, dynamic Tailwind fragments,
and server-handle leakage.

Completion gate:

- `arbor check sites/supplies` typechecks the unchanged corpus;
- inferred result and mutation types reach TSX and MDX call sites;
- VS Code and Zed show the same representative completions and diagnostics;
- local Arbor and Canopy activate the identical reviewed manifest; and
- inspection proves public bundles contain no private data, credentials,
  physical store paths, or server implementations.

## Deliberate boundaries

- Do not change authored query or mutation syntax without discussing it with
  the user first.
- Do not make a global TreeID/path registry part of authored application code.
- Do not infer property types from currently sampled rows.
- Do not require one editor, one workspace layout, or a running Canopy.
- Do not absorb Apps 001 rendering/hosting or Postgres 004 replication.
