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
  accepted update. Named queries run on it through apps-runtime's `SQLiteQueryEngine`
  and `LiveQueryBroker`; a mutation runs in `SQLiteStoreBroker.trialAsync`, rolls back,
  and is submitted as one guarded update of row operations with a durable receipt in
  `<dataRoot>/mutation-receipts.sqlite3`. Tests: `tests/integration/host-collections.test.ts`.
- **Handles are registered in code.** `serveHost({ collections: { queries, mutations } })`
  takes handle objects matched by module, export and version, for any tree. Nothing
  reads a handle's source from a tree, and no activation names which code may run.
- **The caller's own authority.** The query route needs the caller to read the tree;
  the mutate route needs write access and submits the update as the caller. Execution
  tokens, `app` rules and lending (Apps 004, deployed on schema 13) are not used.
- **Not in production.** `packages/overstoryd/src/cli.ts` passes no `collections`, so
  the deployed host answers both routes with `unsupported-operation`.
- **In process.** overstoryd now depends on `@ovst/apps-runtime` and loads the query
  engine, against the boundary in the
  [execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md) document.

## Fork for Joe

**Where authored code runs.** The original plan required a separate sidecar process so
that no evaluator, compiler or authored JavaScript loads in overstoryd. 005 put the
evaluator in process for handles the operator registers. Options:

1. **In process for now (recommended).** Steps 1 to 3 build activation, authority and
   source resolution on `HostCollections` as it is. Step 4 (the sidecar) is taken when
   code from trees other than the operator's runs, or when compilation (Apps 003)
   arrives, since that is when a crash or a slow handler in authored code could take
   ordinary reads, watches and merges down with it.
2. **Sidecar first.** Extract `HostCollections`' execution behind the bridge before
   adding authority, as the earlier plan had it. Slower to the lending test, cleaner
   boundary from the start.

Either way the materializations, receipts and update submission can stay in
overstoryd: they are accepted-state bookkeeping, not authored code.

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
  always if Joe picks option 1 above; record which.
- Document configuration, limits (body size, concurrent executions, deadlines, stream
  buffers), shutdown and rollback in the deployment guide. Ordinary readiness must not
  depend on any app.
- Before enabling a real app, a soak on an isolated copy of the live host: Story consent and
  revocation, and configuration conflict resolution including queued configuration writes.
  Take a fresh backup of the live host first (the schema 13 migration backups were deleted on
  2026-10-26).

**Verify:** `bun run test:affected`, `bun run test:protocol`, and one hand check with
Joe on a disposable host: an activated Supplies query and mutation, then revocation.

## 4. The execution sidecar (when option 1's trigger arrives, or first under option 2)

Move query planning, evaluation and mutation execution behind an authenticated local
HTTP bridge, as the [execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md)
document describes, and remove `@ovst/apps-runtime` from overstoryd's dependency
closure. The earlier version of this plan (git history before 2026-10-24) has the
detailed steps; in short:

- **Contract.** Paired request and error fixtures in `tests/fixtures/execution-sidecar/`;
  loopback or Unix-socket transport with private credentials, version handshake,
  readiness and supervision; bounded bodies, concurrency, queues, deadlines and
  buffers; host-issued context, client context headers stripped, response headers
  allowlisted; disconnect cancels; a committed mutation is never promised rolled back,
  and an unknown response is recovered by exact retry and receipt.
- **Extraction.** Run the step 1 to 3 machinery behind the bridge; the sidecar reads
  through ordinary current-tree, object, watch and update APIs with the execution
  token. Streams publish whole replacement values and reconnect statelessly.
  `tests/unit/execution-sidecar-boundary.test.ts` proves the overstoryd closure has
  no evaluator, compiler, React or QuickJS, including through barrels and dynamic
  imports.
- **Failure independence.** Kill the sidecar before and during streams and after a
  mutation commits; overstoryd's reads, watches, updates and merges keep working, and
  a restart reconnects with a fresh snapshot and replays a persisted receipt. Reuse
  the same bridge beside Story Sync on disposable roots.

**Verify:** `tests/integration/execution-sidecar.test.ts` with real processes, plus
the step 1 and 2 cases rerun through the bridge.

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
`bun run test:performance`, `bun run check:links` and `git diff --check`. Record
implemented and deployed evidence separately in `status.md` and the architecture docs,
repair incoming links, and delete this plan. If step 4 is deferred under option 1,
move it to its own plan first.

Not here: browser document hosting, SSR and hydration (Apps 001 and 003); durable
authoring and workflow semantics (Apps 006); approvals on placement hosts (Apps 008);
cross-host delegation (Apps 009). The mutation guard is scoped to the collection
([status](../../status.md#rows-on-the-host-eviction-and-a-collection-scoped-guard--2026-10-28)).
Never widen authority to get a fixture passing.
