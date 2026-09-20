# canopyd execution sidecar boundary

This is the target reference implementation boundary, not a claim of deployed
support. [Apps 005](../../plans/apps/005-source-resolution-and-sidecar.md) owns its
implementation. Portable contracts live in [locator resolution](../../spec/03-locators.md#4-resolution-rules),
[execution authority](../../spec/05-access-control.md#21-execution-tokens), and
[executable documents](../../spec/07-executable-documents.md#8-host-and-server-boundaries).

## HTTP forwarding

The public host resolves canonical locations and caller identity, then forwards
HTTP execution traffic with trusted source TreeID, logical path, original method,
search parameters, body, and an opaque execution context. It strips untrusted
context headers. The runtime returns status, safe headers, and a streaming body;
public credentials and privileged response headers cannot be smuggled across the
bridge. Cancellation, backpressure, bounded requests, and disconnects propagate.
Source-only sharing never enables execution; activation explicitly binds reviewed
code, sponsoring account, providers, and resource limits.

The bridge supports documents, assets, actions, and query streams without exposing
compiler internals to canopyd. Runtime failures do not disable ordinary tree reads,
watches, updates, or merge execution. Processes, sockets, token formats, deployment
configuration, and health protocols belong to reference implementation documentation.

The runtime owns compilation, React, query planning/evaluation, dependency tracking,
input validation, mutation execution and workflow coordination. canopyd owns identity,
resource policy, logical resolution, immutable tree reads, accepted watches, and
guarded updates. Backing providers own snapshots, committed observation, and atomic
physical effects with retry evidence. Queries choose providers from bindings;
canopyd need not execute query plans. Optimized provider pushdown must preserve
portable semantics and finite execution bounds.


The trusted host issues execution tokens over its authenticated runtime channel.
The sidecar uses `Authorization: Bearer <execution-token>` for canopyd current-tree
reads, object reads, watches and updates. Public headers cannot select the caller,
sponsor or `via` identity. Token issuance/encoding, local transport, process
supervision and health checks are implementation details to settle in Apps 005.

## Provider enforcement and local reuse

Ordinary reads available to the caller remain usable through code without a `via`
rule. Author-contributed authority requires matching policy for the actual caller
and executable. Private SQLite access is mediated by the trusted runtime provider;
no general raw connection is exposed to authored JavaScript. Cross-tree JavaScript
isolation may be strengthened later, but the initial host trusts the sidecar and
must document that process isolation alone is not a hostile-code sandbox.

The same binding and provider interfaces support local execution beside Arbor Sync.
Cross-server discovery/delegation/routing remain separate work; a remote locator
must fail explicitly when the host cannot establish the required authority.

## Provider bindings

Locators resolve client-side by the spec's resolution rules against the pinned
defining-module root; a host-backed source's `(root, update, observedThrough)`
and access summary come from the ordinary current-tree read under the execution
token. Nothing else is asked of canopyd. A provider-backed source (SQLite,
Postgres) is mapped to a connection by private host configuration, never by an
authored filename, DSN or credential, and is published to the runtime as an
opaque backing descriptor plus schema fingerprint.

A binding version identifies the resolved resource, its backing identity and its
schema contract; it excludes ordinary row/content updates. Code version, binding
version and data observation cursor are independent. Changing a resource target
requires fresh grant coverage; an incompatible schema or provider change
invalidates the compiled plan. Running mutations retain their original concrete
bindings. Tree watches invalidate dependent canopyd bindings; provider
configuration publishes schema changes, and the host cannot infer changes inside
an unmanaged database. Reconnect and cursor expiry trigger fresh resolution and
authorization; stale cached metadata never becomes authority. There is no
same-name fallback, and an unsupported or remote source fails explicitly.
Bindings convey metadata, not access: every provider use rechecks authority.
