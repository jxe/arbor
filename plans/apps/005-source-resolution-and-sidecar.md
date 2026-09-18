# Apps 005: Source resolution and the HTTP execution sidecar

## Status and target

**P1 · PLANNED · after [Apps 004](004-mutation-permissions.md).** Define the concrete
internal bridge first, then extract existing headless execution. The unused current
query/mutation formats may break; no adapters or dual-route compatibility are
required. Preserve correctness, not obsolete signatures. [Apps 006](006-durable-authoring.md)
then replaces authoring/runtime semantics. Apps 003 supplies full compiler tooling;
its unfinished editor integration does not block a headless extraction fixture.

Normative owner: [source resolution](../../spec/03-locators.md#7-source-resolution).
Canopy owns tree authority/resolution; the HTTP sidecar owns query planning,
evaluation and mutation execution; SQLite remains a direct scoped provider.
React hosting is the next bridge gate, not a prerequisite to headless extraction.

## Current seams to inspect

`packages/canopy/src/host.ts` injects `QueryStreamRuntime` and `MutationCallRuntime`
from core protocol. Existing evaluator, observer, SQLite and mutation machinery
lives in `packages/data/src/{host,node-query,live,live-stream,observer,sqlite,mutation,authoring}.ts`.
Read `tests/integration/query-stream-api.test.ts`, `data-live-query.test.ts`,
`generic-node-query.test.ts`, and `supplies-mutations.test.ts` before extraction.
Inspect node/provider resolution, source binding checks and ordinary Canopy object,
watch/update APIs. Current passing tests do not establish a production compiler,
React host, hostile-code isolation or cross-store workflow durability.

## Phase 1: Concrete bridge contract

Complete [reference bridge documentation](../../docs/execution-sidecar.md) and paired request/error fixtures
before moving code. Specify authenticated local HTTP transport, host-issued context,
header stripping, source/caller identity, executable/sponsor binding, resource limits,
request/body bounds, backpressure, cancellation, safe response headers, HTTP errors,
query stream errors after headers, health/version handshake, restart and shutdown.
Do not create an app ID, module registry in Canopy, or durable query subscription
resource. Execution activation is host configuration; ordinary requests remain
self-contained. Immutable compilation/cache entries are replaceable artifacts.

Canopy forwards ordinary canonical document/action/asset requests and execution
traffic; runtime routes are not authored document routes. No compiler, React or
query evaluator import remains in the Canopy runtime dependency graph. Browser
credentials are not forwarded as general sidecar credentials. Test forged context,
spoofed `via`, response cookie/header injection, disconnect and timeout behavior.

## Phase 2: Authorized source resolution

Implement the spec route and TS/Swift/shared fixtures together. Resolve relative
locators from pinned defining-module roots; preserve TreeID/path and nested/mounted
boundaries, imported helper context and explicit user resource selections. There is
one resolution request without a purpose field. Consent UI authenticates as the
grantor; runtime resolution uses an execution token. Return only authorized binding
metadata; fetch private schemas/data separately under current authority.
No paths, DSNs, raw SQLite or private schema reach browser responses.

Add trusted provider-descriptor publication/configuration for opaque SQLite bindings;
validate schema ownership and invalidate on change. Bindings convey no authority.
Implement binding invalidation from tree changes and provider metadata changes;
cache versions separately from data cursors and code hashes. No stale same-name
fallback. Unsupported remote/federated sources fail explicitly.

## Phase 3: Extract headless runtime

Move/reuse the current registered query/mutation runtime behind the HTTP server.
Keep SQLite snapshots, dependency plans, transactions and same-transaction receipts.
Use provider bindings rather than a database chosen by caller path or current working
directory. Canopy sources use immutable objects and authorized watch/update calls;
SQLite sources use direct mediated connections and committed provider observation.
Cross-provider queries are finite and use cursor vectors, not fictitious snapshots.
Do not relocate query-plan evaluation into Canopy during extraction.

Public query streams remain complete replacement values with stateless reconnect.
Reauthorize and establish snapshot-follow on every subscription; preserve membership
race protection, relevance filtering and output deduplication. Propagate authority
invalidation into both provider reads and queued disclosures. Provider unavailability
or sidecar death must leave ordinary Canopy sync/merge usable. Exact mutation retries
must recover from persisted receipts after sidecar restart.

## Phase 4: HTTP document and local integration

Use Apps 003 coherent compilation to serve one Supplies document, public assets,
SSR initial results and hydration without duplicate initial reads. Test ordinary
links/search/back/reload and JavaScript-free form actions. Reuse the boundary beside
Arbor Sync; host differences do not alter provider/query semantics. Supervision,
connection paths and provider credentials belong in private deployment configuration.
Document initial trusted-runtime assumption and no claim of hostile cross-tree JS
sandboxing. Activation revocation stops all affected execution, not static sync.

## Lifecycle acceptance cases

1. Anonymous public query: author policy enables read via code; resolve private
   SQLite binding, evaluate/render, subscribe with snapshot-follow, mutate backing,
   stream only authorized projection, then revoke and prove output stops.
2. User notebook mutation: consent binds selected TreeID, create without broad read,
   guarded update accepts, lost response retries do not duplicate, denied grants
   cannot expose objects or watch whole-tree changes.
3. Switching schema/binding invalidates compiled query; changing ordinary data only
   reruns queries. Imported helpers resolve against their own module context.
4. Kill/restart sidecar while Canopy read/watch/update/merge stays available; reconnect
   stream and replay a committed mutation. Kill invalidation channel and prove fail-closed.

The combined SQLite-to-Arbor workflow belongs to Apps 006, not this extraction.

## Gates and completion

Add process-level HTTP tests plus focused existing data/query/mutation suites.
Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
affected Swift protocol/client suites, dependency-boundary checks, relative-link
check and `git diff --check`. SSR/browser gates use maintained tooling established
with Apps 001/003, not the currently retired web-editor build. Measure cold/steady
request, stream cancellation and memory behavior; do not invent thresholds without
baseline. Record actual installed/local artifacts separately from test evidence.

Done: no in-process Canopy execution imports; fixtures run against real separate
processes; source resolution and revocation pass; one local/hosted document traverses
the bridge. Document deployment rollback, update status and move to completed plans.
If scoped data cannot be returned safely or retry atomicity regresses, stop extraction
at the failing gate rather than widen authority or drop checks.
