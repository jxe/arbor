# Merge executable and shared objects

The reference implementation has a TypeScript merge package, `@arbor/merge`, and
an `arbor-merge` executable script run by Bun. This checkpoint is implemented on
`codex/merge-tool`; it is not deployed. There is no Canopy SQLite migration,
object-layout change, public Wire change, or client cutover.

Canopy invokes one process per evaluation by default. The same executable has a
sequential persistent mode for future sidecar integration. Canopy still owns
accepted history, causal reconstruction, authorization, guards, conflict identity,
retention and atomic acceptance. The executable owns the existing format rules
and tree merge computation. It has no database connection or credentials in its
API; this is a trusted local worker, not an OS sandbox for arbitrary plugins.

## API and execution

```sh
bun run arbor-merge evaluate --objects /data/objects --staging /data/merge-jobs/example/objects
bun run arbor-merge serve --objects /data/objects --staging /data/merge-jobs/example/objects
```

`evaluate` accepts one JSON request on stdin and writes one JSON response on
stdout. Failures exit nonzero with diagnostics on stderr. `serve` accepts one
JSON request per line and returns one response per line, in order; an invalid
request returns `{ "error": { "message": "..." } }` and leaves the process usable.
Persistent callers own staging lifetime and serialization. Production Canopy does
not yet supervise or multiplex a persistent sidecar.

The [typed and validated contract](../packages/merge/src/contract.ts) is the
source of truth. For example, a tree merge takes these fields (replace abbreviated
hashes with actual SHA-256 object hashes):

```json
{
  "kind": "tree",
  "base": { "object": "sha256:..." },
  "current": { "object": "sha256:..." },
  "incoming": { "object": "sha256:..." },
  "rules": { "id": "tree-default", "revision": 1 }
}
```

It returns `result: { object }`, `decisions`, `objects` (new object hashes, not
bytes), and `evidence: { rule, summary? }`. Conflict decisions name their path,
reason, and entry or coupled-directory scope. A successful partial merge may
contain unresolved decisions. Empty decisions do not clear existing Canopy choices.
Canopy reifies the rule output with retained alternatives and origins, assigning
durable identities itself. Account merge selection uses `account-config-v1` or
`account-config-v2`; authorization remains in Canopy before and after evaluation.

A `kind: "source"` request carries the same object-reference inputs plus `tree`,
`path`, and `proposal: { object }`. Its incoming material also carries exact
`changes: [{ change, operations }]` and ordered `contributions: [{ change, operation }]`.
The two lists must agree. Canopy proves the causal history and reconstructs the
proposal before asking a format rule whether it is valid. The source result is
that proposal with a resolved/unresolved/inapplicable decision and reason. Existing
plain-text and Markdown-prose rules validate it conservatively; they do not infer
operations from snapshots. Full unresolved-state/alternative-aware rule inputs and
new operation execution are remaining work in [Reliability 013](../plans/reliability/013-merge-operations-and-formats.md).

The rule revision identifies algorithm semantics; it is not a versioned client API.
Unrecognized rules, invalid responses or missing material fail evaluation. There
is no supported-operation advertisement to clients. Ship server support before
clients emit additional operations.

## Objects, authority and failure

`@arbor/object-store` extracts the existing immutable, hash-sharded store unchanged.
Reads verify hashes; writes flush files and atomically link them into place. A merge
job reads the shared store plus its private staged inputs, and writes generated
objects only into staging. Request JSON contains no object-store filesystem paths.

Canopy creates a unique `/data/merge-jobs/job-*` directory, stages uncommitted input
objects, and records the request. The worker receives fixed paths, with a minimal
environment rather than inherited server credentials. Canopy validates the response
shape, rule identity, object hashes and result closure, then applies its normal
schema, boundary, authorization and guarded-acceptance checks. Returned objects are
retained in memory until Canopy durably stores them before the accepted transaction.
Writing an object alone never creates accepted state.

Normal and failed jobs remove staging in `finally`. A host crash can leave an
unaccepted job directory; after confirming no worker uses it, it can be removed.
The existing retained object store has no garbage collector: accepted input history
is not pruned during evaluation. A future collector must pin job inputs, staged
inputs, results awaiting commit, hidden alternatives and provenance dependencies;
the job manifest alone is not a completed GC lease protocol.

Canopy defaults to four concurrent workers, at most 64 queued evaluations, a
30-second worker timeout with forced termination, and an 8 MiB stdout/stderr buffer
limit. Runtime options can change concurrency and timeout. Worker launch, timeout,
validation or execution failure conservatively preserves ordinary content as
accepted ambiguity; it does not recreate a client conflict hold. Governed account
configuration retains its authorization/rejection policy. The client keeps its
usual durable retry behavior for unrelated storage or transaction failures.

## Running and configuring

The default invocation runs the TypeScript CLI with the current Bun runtime. The
workspace exposes `bun run arbor-merge`; its executable script has a Bun shebang.
No compilation or signing is needed. A custom `ARBOR_MERGE_EXECUTABLE` may name an
absolute executable script or program; programmatic options also accept fixed
arguments and worker limits. Arguments are never interpreted by a shell.

Install workspace dependencies with `bun install`. Collection schema compilation
resolves the worker's installed Zod, uses private temporary files, and evaluates
inside the existing memory/time-limited QuickJS sandbox. It does not depend on the
caller's working directory or execute authored schemas in the host runtime.


Ported behavior: Markdown additive merging and frontmatter/fence checks; stable-page
rename and directory reconciliation; keyed collection rows and schema/constraint
checks; plain-text and Markdown source-proposal validation; account configuration
v1/v2 merging. The subsequent [operation evaluation checkpoint](merge-operation-evaluation.md) adds exact authored-operation execution and conservative format rules; its remaining completion gates are tracked in 013.

## Verification

```sh
bun test tests/integration/merge tests/unit/canopy/update-merge.test.ts tests/unit/canopy/source-reconciliation.test.ts
bun run typecheck
bun run test
bun run test:protocol
bun run build
```

The dedicated corpus compares exact roots, bytes, decisions and evidence against
the ported rules, exercises both execution modes, and checks concurrent staging,
corrupt objects, malformed output, nonzero exits and forced timeouts. A real HTTP
case verifies accepted ambiguity, replay, continued publication, restart and
integrity with a missing worker. A process test runs a collection merge
with an empty environment and working directory outside the checkout.

September 17, 2026 verification: 822 product tests passed, including 27 process and
failure tests; TypeScript checking, the full cross-language protocol suite, the
CLI build, frozen dependency installation, relative-link checks and diff whitespace
checks passed. No live data, installed clients or deployments were changed.
