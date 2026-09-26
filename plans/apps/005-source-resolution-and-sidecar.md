# Apps 005: Source resolution and the HTTP execution sidecar

## Status, prerequisites and target

**P1 · PLANNED · L effort · high authority-boundary risk.** Replanned at
`d55f4142`, 2026-09-21. Execute after
Apps 007, declarative CDDL collection schemas, which is implemented
([status](../../status.md#declarative-collection-schemas--2026-09-24)): collection
acceptance, projection and merge no longer execute schemas, and QuickJS is no longer
a workspace dependency.
Read [DEVELOPMENT.md](../../DEVELOPMENT.md), `status.md`, current source and tests
before relying on this checkpoint. No live-data, installed-app or public-host
changes are authorized by this plan. Do not commit or push unless requested.

The resource-policy prerequisites (Apps 004, deployed on schema 13, plan deleted;
see git history) are implemented execution tokens, scoped authorization, guarded
updates and authority invalidation primitives. Step 1 here implements and tests
host/session/code-activation attestation and connects it to token issuance and
authority invalidation; there is intentionally no public mint endpoint. This plan
owns the provider integration Apps 004 left: verify an app's requested effects fit
the supported scoped snapshot subset, and implement exact provider enforcement
before exposing the operation, resolution and whole-object/watch projection forms
that currently reject; never substitute broad read or write access to make them
work. The consent, revocation and configuration-conflict soak is in
[release and soak](../release-and-soak.md#manual-recipes-retained-from-the-deleted-checkpoints)
and still applies before enabling a real application.

The outcome is an independently shippable **headless HTTP execution sidecar**.
canopyd owns identity, authorization, immutable tree reads, accepted watches and
updates; the sidecar owns query planning/evaluation and mutation execution. SQLite
is a direct mediated provider. CDDL collection validation, ordinary row projection
and collection merge stay independent of application activation and availability.
No authored schema JavaScript, compiler, React or query evaluator belongs in the
canopyd process dependency graph.

Unused current query/mutation signatures may break without compatibility adapters.
Preserve authority, data and retry semantics. [Apps 006](006-durable-authoring.md)
subsequently replaces authoring/workflow semantics. Browser document hosting, SSR,
hydration and full compiler/editor integration belong to Apps 001/003 after this
headless gate; they are not completion requirements here.

## Baseline, scope and ownership

Run `git status --short` and
`git diff --stat d55f4142..HEAD -- packages tests docs tools swift`.
Apps 007 deliberately changes these paths: reconcile its completion evidence and
new schema package before implementation. Do not restore the old sandbox seams.

At this baseline, `packages/canopyd/src/host.ts` has:

```ts
import { treeMutationResponse, treeQueryResponse } from "@overstory/apps-runtime/host";
// serveHost options:
queryRuntime?: QueryStreamRuntime;
mutationRuntime?: MutationCallRuntime;
```

`packages/apps-runtime/src/host.ts` passes `{ signal, user }` to the stream runtime,
but `{ user }` to mutations; its broad catch turns failures into HTTP 400. These
are implementation starting points, not the future authority/cancellation contract.
`tests/integration/query-stream-api.test.ts` injects in-process fake runtimes; it
does not prove process isolation. Existing evaluator/observer/SQLite/receipt machinery
is in `packages/apps-runtime/src/{node-query,live,live-stream,observer,sqlite,mutation,authoring}.ts`.
`schema.ts` there contains filesystem-based source resolution; inspect its current
API after Apps 007 rather than confusing it with collection schema parsing.

Read `tests/integration/{query-stream-api,data-live-query,generic-node-query,supplies-mutations}.test.ts`,
`packages/canopyd/src/{account-policy,host,canopy}.ts`, token and authority-watch
handlers, and merge process contracts. Shared package barrels must not pull worker
implementations into canopyd; the existing merge package has executable exports.

Normative owners: [locator resolution](../../docs/overstory-spec/03-locators.md),
[current-tree reads](../../docs/overstory-spec/01-tree-operations.md#111-reading-the-current-tree),
[execution authority](../../docs/overstory-spec/05-access-control.md#21-execution-tokens),
and [executable documents](../../docs/overstory-spec/07-executable-documents.md).
Complete the reference [bridge contract](../../docs/architecture/canopyd/execution-sidecar.md)
without changing portable behavior merely to fit the extraction.

Scope: apps-runtime plus a new executable entrypoint/package if useful; canopyd HTTP
forwarding and execution configuration; pure shared bridge contracts; Arbor Sync's
local integration; deployment/packaging configuration; affected protocol/Swift models,
fixtures/tests and reference docs. Keep CDDL enforcement and collection codecs in
the pure package established by Apps 007. Out of scope: schema migration, app registry,
durable subscription resources, cross-host delegation, React/compiler implementation,
cross-provider durable workflows, provider storage redesign and hostile-JS sandboxing.

## 1. Freeze the bridge and activation contract

Write paired request/error fixtures in `tests/fixtures/execution-sidecar/` and create
`tests/integration/execution-sidecar.test.ts`. Specify authenticated local HTTP
transport (private loopback listener or supported Unix socket), private credential
provisioning, protocol version handshake, startup/readiness, shutdown and supervision.
Public readiness must still allow ordinary canopyd operations when apps are disabled
or unavailable. Bound body/header sizes, concurrent executions, queue size, deadlines
and stream buffers; document explicit initial limits in configuration and tests.

Specify host-issued context with actual caller, source TreeID/logical path, pinned
code root/version, lent grants with their lenders, activation identity and allowed execution
scope. canopyd already checks each grant against its named lender; the issuer
chooses lenders in a fixed order: the caller's own access first, then lender TreeID. Bind imported code to the correct executable identity without escalation.

Decide before the sidecar exists whether attested code may use the caller's own
access without the caller's approval. Today a grant with no lender allows it
([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority),
`executionAllows` in `packages/canopyd/src/access.ts`), so any app a person runs
can do anything that person can. Proposed: code gets `everyone` access and the
tree's own `app` rules, and anything more of the caller's needs the caller's
`who: me` entry in `apps.yaml`. This matches what code on a placement host gets
([Security 007](../security/007-placement-hosts.md#code-on-b)), where no
`apps.yaml` is readable. The decision edits access control §1.1.
Strip all client-supplied context headers; never forward browser credentials as
sidecar service credentials. Sidecar canopyd calls use the host-private execution
token through ordinary current-tree/object/watch/update APIs; no public mint or
special resolution route. Requests contain enough information for restart/reconnect
without an app ID or subscription registry in canopyd. Activation remains private
host configuration binding reviewed code, lenders, providers and resource limits.

Specify initial HTTP status/error mapping and post-header stream errors separately.
Allowlist response headers; test cookies, redirects and credentials cannot be smuggled
across the boundary. Distinguish unavailable runtime, invalid input and denied authority.
Disconnect cancels reads/subscriptions and releases resources. For mutations define
pre-commit cancellation versus an already committed effect: cancellation never promises
rollback after commit; an unknown response is recovered by exact retry and receipt.

**Verify:** `bun test tests/integration/execution-sidecar.test.ts` → contract cases
pass against separately launched fixture processes; `bun run check:links` and
`git diff --check` → exit 0. Do not expose a half-specified bridge publicly.

## 2. Implement authorized bindings and provider enforcement

Replace filesystem-based `resolveArborSource` with logical resolution over retained
objects, pinned defining-module roots and explicit user selections. Preserve TreeID,
logical path, nested/mounted boundaries and each imported helper's defining context.
For a host-backed source, obtain `(root, update, observedThrough)` and access summary
from ordinary current-tree read under the execution token. Consent reads run as the
grantor. Fetch private schemas/objects separately under current authority; a binding
is metadata, never permission. No paths, DSNs, raw databases or private schemas may
escape through browser responses/errors.

Publish opaque SQLite descriptors and schema fingerprints from private provider
configuration. Never select a database from a caller filename or current directory.
Validate schema ownership; reject unsupported remote/federated sources explicitly.
Code versions, binding versions and data cursors remain separate. Schema/target changes
invalidate affected plans; ordinary row updates trigger reevaluation, not recompilation.
No stale same-name fallback. Running mutations retain original concrete bindings.

Tie activation/token revocation and authority-watch invalidation to provider reads,
in-flight work and queued disclosures. Loss/expiry of the invalidation channel fails
closed until fresh authorization is established. Define the authorized commit check
and disclosure boundary for SQLite explicitly; do not claim cross-store atomicity
from a last-minute asynchronous permission lookup. If the current authority APIs
cannot support the promised revocation semantics, stop for a contract decision rather
than temporarily granting broader access.

**Verify:** extend `tests/integration/execution-sidecar.test.ts` with anonymous `app`
reads, caller-only ordinary reads, forged context, nested-tree escape, helper context,
stale bindings, provider changes and revocation while results are queued → all pass.
Use actual execution tokens and backing providers, not only mocked grants.

## 3. Extract execution and preserve stream/receipt semantics

Run current registered query/mutation machinery behind the bridge. Keep SQLite
snapshots, dependency plans, transactions and same-transaction retry receipts.
canopyd sources use authorized immutable-object reads and watch/update calls; SQLite
uses direct mediated connections and committed observation. Cross-provider queries
are finite and use cursor vectors, not a claimed global snapshot. Query-plan evaluation
must not move into canopyd as an optimization.

Streams publish complete replacement values with stateless reconnect. Reauthorize
and establish snapshot-follow on every subscription. Preserve membership race protection,
relevance filtering, output deduplication and cleanup. Keep mutation ID/digest/binding
checks across restart: lost responses retry the exact request, changed payloads reject,
and revoked callers cannot use old receipts to bypass current disclosure authority.

Replace in-process runtime injection in the production host with a bridge client.
Keep test fakes only for focused unit cases; production integration tests must start
real independent processes. Add package-boundary tests at
`tests/unit/execution-sidecar-boundary.test.ts` for the transitive canopyd CLI/runtime
closure, including barrel re-exports and dynamic imports, and remove its direct
apps-runtime dependency. If merge contracts pull in the worker implementation, expose
pure contract imports rather than moving merge execution back into canopyd.

**Verify:**

```sh
bun test tests/integration/execution-sidecar.test.ts
bun test tests/integration/query-stream-api.test.ts tests/integration/data-live-query.test.ts tests/integration/generic-node-query.test.ts tests/integration/supplies-mutations.test.ts
bun test tests/unit/execution-sidecar-boundary.test.ts tests/unit/collection-schema-boundary.test.ts
```

All pass. The resolved daemon graph has no apps evaluator/compiler/React/QuickJS;
starting canopyd without installed apps-runtime or QuickJS in a disposable packaging
fixture still supports ordinary and CDDL collection operations.

## 4. Prove failure independence and local reuse

Reuse the bridge beside Arbor Sync with private connection/credential configuration;
do not fork provider semantics. Document launch, configuration, graceful shutdown,
version mismatch, restart and rollback. Sidecar failure must not restart canopyd or
make its ordinary readiness depend on application health. Keep credentials out of
synchronized files and public responses. Runtime/image packaging is distinct: report
what each process imports and what the deployed artifact contains.

Required process-level cases in `tests/integration/execution-sidecar.test.ts`:

1. Anonymous authorized projection from private SQLite; mutate backing and observe
   a replacement result; revoke and prove no queued or subsequent disclosure.
2. User-selected notebook create with no broad read; guarded update; dropped response;
   exact retry after restart creates no duplicate and denied authority leaks no objects.
3. Schema/binding change invalidates a plan, data-only change reevaluates it, and imported
   helpers resolve using their own pinned module context.
4. Kill sidecar before/during streams and after mutation commit. While it stays down,
   exercise canopyd read/watch/update/merge, including CDDL collections; all remain usable.
   Restart, reconnect with a fresh snapshot and replay a persisted receipt.
5. Lose authority invalidation, inject hostile context/response headers, exceed body/
   execution limits, disconnect slow readers and shut down; prove bounded resources,
   fail-closed disclosures and eventual cleanup.
6. Run the same headless query/mutation fixture beside Arbor Sync on disposable roots.

**Verify:** the above integration command passes all cases with real processes.
Measure cold/steady request latency, stream cancellation and retained memory against
baseline; record limits and results without unsupported performance claims.

## Completion and subsequent work

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
`bun run test:performance`,
`bun test tests/unit/canopyd-merge tests/integration/canopyd-merge`,
`xcodebuild test -project swift/Canopy.xcodeproj -scheme Canopy -destination platform=macOS -only-testing:CanopyAppTests/ArborSyncClientTests -only-testing:CanopyAppTests/LoopbackServicesTests`, `bun run check:links`,
and `git diff --check` → exit 0. Run affected Swift model suites if wire shapes changed;
CanopyEditor testing uses the repository wrapper. Verify changed packaging through
`bun run build:cli:package` and `bun run test:cli:package` when applicable; root
`bun run build` builds the CLI and is not sufficient evidence of host isolation.

Done: authorized headless execution across a real HTTP process boundary; durable
retry/revocation tests; ordinary host and CDDL operations independent of apps;
QuickJS/compiler/evaluator-free daemon closure; local bridge reuse; documented private
configuration, failure behavior and rollback. Initial runtime is trusted; process
separation alone makes no claim of hostile cross-tree JavaScript isolation.
Stop if safe scoped results, receipt atomicity, failure independence or dependency
separation cannot be proved. Never widen authority to get a fixture passing.

Apps 001/003 next supply ordinary document/action/asset forwarding, coherent compilation,
SSR initial results, hydration without duplicate reads, links/search/back/reload and
JavaScript-free actions over this boundary. Keep that next gate recorded in those
plans; do not silently drop it or fold it into this headless completion requirement.
Apps 006 owns combined SQLite-to-Overstory workflows and durable authoring semantics.

Record implementation/test evidence in `status.md` and architecture docs separately
from installed/deployed evidence. Repair incoming links, delete the completed plan and
update indexes; do not move it to a completed-plans directory. Changes to bridge
versions, execution tokens or provider invalidation require paired process fixtures.
