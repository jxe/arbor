# Apps 005: Source resolution, execution authority and the sidecar

**Why and when:** Joe wants queries and mutations running on hosts fairly soon, to test the permissions and lending models against real code; he moved it to soon on 2026-10-28. Schema language 005 (2026-10-24) got them running; this plan makes them run as an app, under the authority an activation grants, from code resolved out of a tree, and then decides where that code runs.

## Status

**PLANNED · L effort · high authority-boundary risk.** Rewritten 2026-10-24 after
Schema language 005 milestone 6 ([status](../../status.md#collections-that-sync--2026-10-24))
put named queries and mutations inside overstoryd. The earlier version (replanned at
`d55f4142`, 2026-09-21) assumed no query evaluator would ever load in overstoryd; its
detailed sidecar steps are in git history and are summarized under step 4.
Read [DEVELOPMENT.md](../../DEVELOPMENT.md), `status.md`, current source and tests
before relying on this plan. No live-data, installed-app or public-host changes are
authorized by it.

## What exists now

- **Rows on the host.** `HostCollections` (`packages/overstoryd/src/collections.ts`)
  keeps a disposable SQLite materialization per collection, caught up after every
  accepted update. The sidecar runs named queries on it through apps-runtime's
  `SQLiteQueryEngine`; a mutation runs in `SQLiteStoreBroker.trialAsync`, rolls back,
  and is submitted by the sidecar as one guarded update of row operations, with a durable
  receipt in `<dataRoot>/exec`. Tests: `tests/integration/host-collections.test.ts`.
- **Handles are registered in code.** The sidecar's `--handles` module
  (`serveHost({ collections: { handles } })`) lists handle objects matched by module, export
  and version, for any tree. Nothing
  reads a handle's source from a tree, and no activation names which code may run.
- **The caller's own authority.** The query route needs the caller to read the tree;
  the mutate route needs write access and submits the update as the caller. Execution
  tokens, `app` rules and lending (Apps 004, deployed on schema 13) are not used.
- **Not in production.** `packages/overstoryd/src/cli.ts` passes no `collections`, so
  the deployed host answers both routes with `unsupported-operation`.
- **In a sidecar.** Since 2026-10-28 (step 4) queries and mutations run in
  `@ovst/overstoryd-exec`, a separate process, behind
  [the execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md) boundary.

## Joe's decision (2026-10-28): the sidecar first

The original plan required a separate sidecar process so that no evaluator, compiler or
authored JavaScript loads in overstoryd; Schema language 005 put the evaluator in process for
handles the operator registers. Joe chose to extract `HostCollections`' execution into the
sidecar before adding authority: step 4 comes first, then steps 1 to 3 on the sidecar. Slower
to the lending test, with a clean boundary from the start.

The boundary was settled with Joe the same day and is written up in
[the execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md). overstoryd
keeps the SQLite materializations, issues tokens and holds client query streams. The
sidecar runs the code, reads the materializations, uses the standard API with a token that
lasts for one question, and commits a mutation itself as a guarded, row-only update with
its own receipts. A mutation's trial still runs in a rolled-back transaction on the
materialization, and overstoryd watches `pragma data_version` to catch a sidecar that
commits to it.

## 1. Activation and execution authority

Make a query or mutation run as an app, not simply as its caller.

- An **activation** is private host configuration (in the tree configuration graph,
  spec 04 §2) binding a handle's module, export and version to a tree, its lenders,
  its providers and resource limits. Unactivated handles are refused, as an
  unregistered one is today. Source-only sharing never enables execution.
- Execution runs under a host-issued **execution token**
  ([access control §2.1](../../docs/overstory-spec/05-access-control.md#21-execution-tokens))
  carrying the actual caller, source tree and path, pinned code version, lent grants
  with their lenders, and the activation. overstoryd already checks each grant against
  its named lender; the issuer chooses lenders in a fixed order, the caller's own access
  first, then lender TreeID. There is no public mint endpoint.
- **Decide first:** whether attested code may use the caller's own access without the
  caller's approval. Today a grant with no lender allows it
  ([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority),
  `executionAllows` in `packages/overstoryd/src/access.ts`), so any app a person runs can
  do anything that person can. Proposed: code gets `everyone` access and the tree's own
  `app` rules, and anything more of the caller's needs the caller's `who: me` entry in
  `apps.yaml`, which matches what code gets on a placement host. The decision edits
  access control §1.1.
- A query's reads and a mutation's submitted update are checked against the token, not
  the route's caller check. A mutation's update is authored by the app with the caller
  recorded, so history says which code made it.
- Revocation of the activation, a lender's grant or the caller's access ends open
  query streams and refuses queued results and receipts; loss of the invalidation
  channel fails closed. A revoked caller cannot use an old receipt to read a result.

**Verify:** extend `tests/integration/host-collections.test.ts`: an anonymous reader
through an `app` rule; caller-only reads; a lent write; a mutation by a caller who can
read but not write, allowed only through a lender; revocation while a stream is open
and while results are queued; a forged or stale token. Use real execution tokens and
the real materializations, not mocked grants.

## 2. Resolve sources from trees

Replace registration in code with handles read from trees.

- An activation names a handle by tree, logical path, export and pinned version; the
  host loads that module from retained objects at the pinned root, with each imported
  helper keeping its own defining tree and path. Replace filesystem-based
  `resolveStorySource` (`packages/apps-runtime/src/schema.ts`) with logical resolution.
  No stale same-name fallback; running mutations keep the bindings they started with.
- A handle's sources (`node()` paths such as `./data`) bind to collections in its tree,
  or to opaque SQLite descriptors from private provider configuration; never to a
  caller-supplied filename or the current directory. No paths, DSNs or private schemas
  escape in responses or errors.
- Code versions, binding versions and data cursors stay separate: a schema or binding
  change invalidates a plan, a row change only reruns it.

Trusted code only: the module runs as the operator's own code would. A hostile-JS
sandbox is out of scope.

**Verify:** the Supplies queries and mutations (`examples/supplies`) load from a tree,
not from the test, and `tests/integration/supplies-mutations.test.ts` runs against the
host. Schema change, binding change, helper context and a nested-tree escape attempt
each behave as above.

## 3. Turn it on in the host

- `cli.ts` reads activations and passes `collections`; with none, the routes keep
  answering `unsupported-operation` and nothing else changes.
- Packaging: the deployed image carries apps-runtime only when apps are enabled, or
  always (the sidecar comes first); record which.
- Document configuration, limits (body size, concurrent executions, deadlines, stream
  buffers), shutdown and rollback in the deployment guide. Ordinary readiness must not
  depend on any app.
- Before enabling a real app, a soak on an isolated copy of the live host: Story consent and
  revocation, and configuration conflict resolution including queued configuration writes.
  Take a fresh backup of the live host first (the schema 13 migration backups were deleted on
  2026-10-26).

**Verify:** `bun run test:affected`, `bun run test:protocol`, and one hand check with
Joe on a disposable host: an activated Supplies query and mutation, then revocation.

## 4. The execution sidecar (first, Joe 2026-10-28) — done

Built on 2026-10-28 ([status](../../status.md#queries-and-mutations-run-in-a-sidecar--2026-10-28)):
[the execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md) describes
it, `@ovst/overstoryd-exec` runs the code, and overstoryd no longer depends on
`@ovst/apps-runtime`. Steps 1 to 3 now build on it:

- Step 1 issues each question's token from the activation, with its lenders, instead of
  the caller's own authority (`HostCollections.mutate`).
- Step 2 replaces the sidecar's `--handles` module with handles read from trees; the
  handshake and questions already name handles by module, export and version.
- Step 3 decides how the deployed image starts the sidecar (`collections.command`).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
`bun run test:performance`, `bun run check:links` and `git diff --check`. Record
implemented and deployed evidence separately in `status.md` and the architecture docs,
repair incoming links, and delete this plan.

Not here: browser document hosting, SSR and hydration (Apps 001 and 003); durable
authoring and workflow semantics (Apps 006); approvals on placement hosts (Apps 008);
cross-host delegation (Apps 009). The mutation guard is scoped to the collection
([status](../../status.md#rows-on-the-host-eviction-and-a-collection-scoped-guard--2026-10-28)).
Never widen authority to get a fixture passing.
