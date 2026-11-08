# Apps 005: Views on the host

**Why and when:** Joe wants queries and mutations running on hosts fairly soon, to test the permissions and lending models against real code.

On 2026-11-06, Joe split the apps work into three plans:
1. This plan: views replace queries, the sidecar runs them from trees, and they are turned on in the host.
2. [Apps 010](../later/apps-010-activation-and-lending.md): activation authority and lending.
3. [Apps 011](apps-011-widgets-in-story.md): widgets in Story.

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

The view language is specified in
[executable documents §4.1](../../docs/overstory-spec/07-executable-documents.md#41-views)
and the [authoring API §3](../../docs/overstory-spec/08-authoring-api.md#3-views). Joe settled
it on 2026-11-08, after comparing tracing, pipelines, Datalog and shape-first forms
(project files `view-notations/`; the chosen form is `shapes/candidates/facts.tsx`). In
short:
- **Facts are the narrowing.** `Model.all(facts)`, `Model.one(facts)` and
  `relationship.all(facts)` are written inline, wherever rows are needed. Rows from
  enclosing code are filled-in placeholders, so results are tree-shaped. The shorthands are
  path facts (`l.items.practice.authors.has(x)`), helper variables named with an object of
  sources, and `rule`, `or` and `not`.
- **Relationship reads stay reads** (`l.items`, `p.tags`), with no facts needed.
- **Shapes are implicit.** Components take rows and read what they show, and the host
  learns the shape in a plan pass over stand-ins.
- **Ordering is JS,** except a limit (`.orderBy(…).take(n)`), which orders in the plan.
- **Data views and JSX views are written separately,** both directly over rows. A data
  view's value pass runs on the host, and its JSON carries field types and row identity, so
  Story can draw it with Quagmire's default renderer. A JSX view's value pass runs on the
  client over the plan's rows, so state changes stay on the device.

Mutations stay as they are, and a view refers to one as an action value.

- Move the spike from its branch into apps-runtime, under `overstory/data`, and replace
  its select-dialect narrowing (`.where`, `.eq`, `.some`) with facts. Facts need a
  compiler from clauses to `QueryPlan`: path facts and helper variables become joins,
  `not` becomes an anti-join, and a rule is inlined where it's used.
  Remove `query.many/one/maybe` and the select-object builder once Supplies is ported. Keep
  the plan IR (`QueryPlan`) and `SQLiteQueryEngine`, because traced views compile to them.
- Annotate data results: the value pass tracks which values came unchanged from a row
  field and which objects were built while reading a row, and the host sends that as the
  result's `shape`.
- Fix the spike's remaining pinches:
  - **A field that is also a relationship** (`owner`). Expose only the relationship, and
    answer `.id` on a direct to-one from the foreign-key column, without a join. Today
    `l.owner === user.profile` is silently false. In facts, `l.owner.is(me)` is the
    intended spelling.
  - **Inputs as parameters.** Trace with tagged input values, so a plan is cached per view
    and not per input.
  - **Counts over facts** (`p.tags.all(…).length`). This needs a `where` on the engine's
    count.
  - **Lift `key` out of an intrinsic view's props.**
  - **Brand keys by model,** so a fact can't be given a List where it expects a Person.
- Access is narrowing, never JS. A view can't read past the authority it runs with (here
  the caller's, and an activation's in Apps 010). An `if` that hides a private row
  doesn't count as protecting it.
- **Read rules belong to the model, and the host applies them** to every read, as facts
  (Joe, 2026-11-08). A view never has to call Supplies' `visible`, and one that forgets it
  still can't see a private list. Their home is access policy (spec 05, `access.yaml`),
  next to [Schema language 010](../later/schema-language-010-row-ownership.md)'s row
  ownership, as row-level read rules such as `who: {property: owner}`. The host compiles a
  model's read rules into facts once per caller and joins them into every plan that reads
  the model.
  - Value predicates (`when: {property: visibility, is: Public}`) aren't supported yet
    (Joe, 2026-11-08). Until they are, Supplies' public/private check stays an app rule
    its views call, and it isn't a security boundary.

**Verify:** the spike's tests, plus every Supplies query ported to a view.
- Each data view answers what its old query answered, with the same SQL statement count.
- The view-tree forms snapshot, and a JSX view's `rows` answer reruns on a client to the
  same tree.
- A branch the trace skipped widens once, and so does a `missed` read from a client.
- A forged input or `missed` path can't read a row the facts exclude, and a view that
  omits a model's read rule still gets only the rows the rule allows.
- Field types and row identity in a data result match the schema.

## 2. The wire format and the spec

- Spec 07 §4 and §12.1: a view request names a view and its input, and answers data or a
  view tree, with the same live replacement stream queries use now. Requests name views and
  mutations with the spec's `HandleRef` (`tree, path, name, version`), replacing
  `@ovst/protocol`'s `QueryHandleRef` (`module`, `export`), and the route is
  `QUERY …/views`, renamed from `…/queries` (Joe, 2026-11-06).
  - A view tree is `{type, props, children, key}`, plus action values naming a mutation and
    its input.
  - The answer forms are specified: `value` (data views), `rows` (JSX views, run on the
    client), `tree` (JSX views run on the host), with `missed` for widening and a
    `ResultShape` for field types and row identity. Build them here, because Apps 011
    needs `rows`.
- Spec 08: `overstory/react` gives way to the view API (§3 Views: `view`, sources with
  `.all`/`.one`, facts, JSX runtime, action values). Leave widget-only parts (controls,
  `keep`, `mine`, `setup`) to Apps 011.
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
  ([Apps 011](apps-011-widgets-in-story.md)).
- Durable workflows ([Apps 006](../later/apps-006-durable-authoring.md)).
- Serving and drawing USL `~views` as declared views
  ([Apps 012](apps-012-one-kind-of-view.md)). Step 2's spec and wire changes are
  written so the two kinds of view stay one.
- Approvals on placement hosts (Apps 008).

Never widen authority to get a fixture passing.
