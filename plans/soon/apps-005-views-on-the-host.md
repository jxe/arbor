# Apps 005: Views on the host

**Why and when:** Joe wants queries and mutations running on hosts fairly soon, to test the permissions and lending models against real code. He moved this plan to soon on 2026-10-28.

On 2026-11-06, Joe split the apps work into three plans:
1. This plan: views replace queries, the sidecar runs them from trees, and they are turned on in the host.
2. [Apps 010](../later/apps-010-activation-and-lending.md): activation authority and lending.
3. [Apps 011](../features/apps-011-widgets-in-story.md): widgets in Story.

## Status

**PLANNED · L effort · high authority-boundary risk.**

The execution sidecar is built ([status](../../status.md#queries-and-mutations-run-in-a-sidecar--2026-10-28)).
The view design comes from the 2026-11-05 apps discussion and its spike, on branch
`claude/project-thread-xzwqq4` (`packages/apps-runtime/src/endpoint.ts`,
`examples/supplies/endpoints`, `tests/integration/endpoint-spike.test.ts`). The spike's
findings are in project files, `apps-widgets/endpoint-spike.md`.

Read [DEVELOPMENT.md](../../DEVELOPMENT.md), `status.md`, current source and tests before
relying on this plan. It authorizes no live-data, installed-app or public-host changes.

## What exists now

- **Rows on the host.** `HostCollections` (`packages/overstoryd/src/collections.ts`)
  keeps a disposable SQLite materialization per collection.
  - The sidecar (`@ovst/overstoryd-exec`) runs named queries on it through apps-runtime's
    `SQLiteQueryEngine`.
  - It trial-runs a mutation in a rolled-back transaction, then submits it as one guarded,
    row-only update with a receipt.
  - The boundary is [the execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md).
- **Queries are select objects.** Authors write `query.many/one/maybe` with
  `where/orderBy/take/select` (spec 07 §4 and spec 08). React components read them with
  `useQuery`. USL `~views` (spec 11 §8) lays out Story's
  presented collections use them (`PresentedView.swift`, `packages/usl/src/present.ts`),
  as do People 001 and the games and excellences schemas.
- **Handles are registered in code.** The sidecar's `--handles` module lists handle objects
  for any tree, and nothing reads a handle's source from a tree.
- **The caller's own authority.** The query route needs the caller to read the tree. The
  mutate route needs write access and submits as the caller.
- **Not in production.** `packages/overstoryd/src/cli.ts` passes no `collections`, so the
  deployed host answers both routes with `unsupported-operation`.

## 1. Views replace queries

A **view** is any function over tables or rows that returns JSX or data.
- The host learns its shape by running it once over tracing stand-ins:
  - `.map` over a relationship is a nested selection.
  - A property read is a field.
  - `.length` alone is a count.
  - `.where`, `.orderBy` and `.take` narrow on the host.
- Everything else, such as values, `.filter`, `.sort` and ternaries, runs as ordinary JS over
  the results: on the host for data, on the device for a view tree.
- A read the trace missed widens the plan once.
- A view that takes a row (a component) joins its caller's plan.
- `view(Schema, fn)` makes a view addressable: links, embeds and HTTP can name it, and its
  reads are its declared scope.

Mutations stay as they are, and a view refers to one as an action value.

- Move the spike from its branch into apps-runtime, under `overstory/data`. Remove
  `query.many/one/maybe` and the select-object builder once Supplies is ported. Keep the
  plan IR (`QueryPlan`) and `SQLiteQueryEngine`, because traced views compile to them.
- Fix the spike's pinches:
  - **A field that is also a relationship** (`owner`). Expose only the relationship, and
    answer `.id` on a direct to-one from the foreign-key column, without a join. Today
    `l.owner === user.profile` is silently false.
  - **Inputs as parameters.** Trace with tagged input values, so a plan is cached per view
    and not per input.
  - **Counts over a narrowed relationship** (`l.items.where(…).length`). This needs a
    `where` on the engine's count.
  - **Narrowing callbacks get a row type without JS string methods**, so using JS where SQL
    is needed fails to typecheck.
  - **Lift `key` out of an intrinsic view's props.**
- A view lays out its rows in code: what each line shows, grouping and sort are plain JS.
  There is no separate arrangement model (Joe, 2026-11-06, for the first cut). A reader's
  choice of sort or grouping is a `keep` control the view reads (Apps 011). USL `~views`
  stays as it is and keeps driving Story's built-in collection lists.
- Access is narrowing, never JS. A view can't read past the authority it runs with (here
  the caller's, and an activation's in Apps 010). An `if` that hides a private row
  doesn't count as protecting it.

**Verify:** the spike's tests, plus every Supplies query ported to a view.
- Each data view answers what its old query answered, with the same SQL statement count.
- The view-tree forms snapshot.
- A branch the trace skipped widens once.
- A forged input can't read a row the narrowing excludes.

## 2. The wire format and the spec

- Spec 07 §4 and §12.1: a view request names a view and its input, and answers data or a
  view tree, with the same live replacement stream queries use now. Requests name views and
  mutations with the spec's `HandleRef` (`tree, path, name, version`), replacing
  `@ovst/protocol`'s `QueryHandleRef` (`module`, `export`), and the route is
  `QUERY …/views`, renamed from `…/queries` (Joe, 2026-11-06).
  - A view tree is `{type, props, children, key}`, plus action values naming a mutation and
    its input.
  - A device that runs the view itself asks for the plan's results instead. Decide that
    form here, because Apps 011 needs it.
- Spec 08: `overstory/react` gives way to the view API (`view`, tables, JSX runtime, action
  values). Leave widget-only parts (controls, `keep`, `mine`, `setup`) to Apps 011.
- [Executable documents §8](../../docs/overstory-spec/07-executable-documents.md#8-host-and-server-boundaries)
  and the execution-sidecar doc: questions name views as well as mutations.

## 3. Load views and mutations from trees

Replace the sidecar's `--handles` module with modules read from trees. The handshake and
questions already name handles by module, export and version.
- **The host loads the module at a pinned root.** For now, the activation is host
  configuration that names a tree, a logical path, an export and a pinned version.
  Apps 010 adds its lenders and authority.
  - The host loads the module from retained objects at the pinned root.
  - Each imported helper keeps its own defining tree and path.
  - Logical resolution replaces the filesystem-based `resolveStorySource`
    (`packages/apps-runtime/src/schema.ts`).
  - There's no stale same-name fallback, and a running mutation keeps the bindings it
    started with.
- **Sources bind only to the handle's tree or to private provider config.** A handle's
  sources (`node()` paths such as `./data`) bind to collections in its tree, or to opaque
  SQLite descriptors from private provider configuration. They never bind to a
  caller-supplied filename or the current directory. No paths, DSNs or private schemas
  escape in responses or errors.
- **Code versions, binding versions and data cursors stay separate.** A schema or binding
  change invalidates a plan; a row change only reruns it.
- **Compile with Sucrase** (TSX to JS), the same compiler Story will use on the device.

Trusted code only: the module runs as the operator's own code would. A hostile-JS sandbox
is out of scope.

**Verify:**
- Supplies' views and mutations load from a tree, not from the test, and
  `tests/integration/supplies-mutations.test.ts` runs against the host.
- A schema change, a binding change, helper context and a nested-tree escape attempt each
  behave as above.

## 4. Turn it on in the host

- `cli.ts` reads activations and passes `collections`, including how the deployed image
  starts the sidecar (`collections.command`). With no activations, the routes keep
  answering `unsupported-operation` and nothing else changes.
- Code still runs as its caller until Apps 010. So only Joe's own apps are activated, and
  only on a disposable host or one he names.
- Document configuration, limits (body size, concurrent executions, deadlines, stream
  buffers), shutdown and rollback in the deployment guide. Ordinary readiness must not
  depend on any app.

**Verify:** `bun run test:affected` and `bun run test:protocol`. Add a hand check of an
activated Supplies view and mutation on a disposable host to [Joe's to-do](../joe.md) when
this step lands.

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
`bun run test:performance`, `bun run check:links` and `git diff --check`. Record evidence in
`status.md` and the architecture docs, trim finished steps as they land, and delete the plan
when only Joe's items are left.

Not here:
- Activation authority and lending ([Apps 010](../later/apps-010-activation-and-lending.md)).
- Widgets in Story and the HTML renderer
  ([Apps 011](../features/apps-011-widgets-in-story.md)).
- Durable workflows ([Apps 006](../later/apps-006-durable-authoring.md)).
- Serving and drawing USL `~views` as declared views
  ([Apps 012](apps-012-one-kind-of-view.md)). Step 2's spec and wire changes are
  written so the two kinds of view stay one.
- Approvals on placement hosts (Apps 008).

Never widen authority to get a fixture passing.
