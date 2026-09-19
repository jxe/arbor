# Merge executable and shared objects

The reference implementation has a TypeScript merge package, `@arbor/merge`, and
an `arbor-merge` executable script run by Bun. It is on main and deployed to
`arb.nxhx.org`. The authority integration adds schema 12 ownership records; it does not change
object layout, public Wire, or require a client cutover. See the
[integration checkpoint](merge-authority-integration.md) and
offline migration (migration 010, deleted after cutover; see git history).

The incremental-state implementation connects Canopy to the executable's existing
sequential persistent mode: one worker and a bounded FIFO queue, with no fan-out.
This is deployed to `arb.nxhx.org` as of September 18, 2026.
Canopy still owns
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
Persistent callers own staging lifetime and serialization. Canopy
adapter keeps the worker alive across jobs, validates each result, then clears
staging before starting the next job. Timeouts and crashes are reaped before
cleanup; queued successors can start a replacement. Canopy shutdown drains the
active job, rejects queued work, and closes its worker. Custom executables retain
one-shot mode unless `persistent: true` is explicitly configured.

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
operations from snapshots. Authored execution and unresolved alternatives now use
the operation-bearing tree request described in [operation evaluation](merge-operation-evaluation.md).
Canopy now forwards authoritative operations through that request. The proposal-only
source rule remains a diagnostic API; it is not Canopy's source acceptance path.

The rule revision identifies algorithm semantics; it is not a versioned client API.
Unrecognized rules, invalid responses or missing material fail evaluation. There
is no supported-operation advertisement to clients. Ship server support before
clients emit additional operations.

### Trusted semantic basis

For operation-bearing tree requests, the host supplies already validated
`base` and `current` state/root pairs within the named tree. Canopy derives them
from accepted records, validated legacy checkpoints, or validated earlier batch
results. They are not client-provided assertions. This is the worker contract;
there is no trust flag or optional untrusted-basis mode.

Exact-basis source execution loads active state and directory metadata to obtain
unchanged file hashes. It does not reread untouched file bodies or reconstruct
the entire basis to prove the state/root relationship again. Referenced bytes
remain hash-checked, operation selectors remain checked, and the computed result
must match the supplied candidate. Canopy still validates worker output and
retention before acceptance. General merges currently retain their full
projection work; extending incremental execution is separate remaining work.

## Historical checkpoints

Canopy reconstructs missing legacy semantic states with `checkpoint-batch`
requests containing an initial material reference and up to 64 ordered accepted
projections, change identities and legacy decisions. The worker applies the same
checkpoint semantics at each step and returns every intermediate state reference.
Canopy checks each against its accepted projection, then validates their combined
retention closure once before persisting objects and caching references.

Each batch retains at most 128 MiB of generated objects and 32 MiB of cached input
bytes. Exceeding the generated-object budget exits with code 75; Canopy retries a
smaller slice against the same basis. Other failures remain failures. These are
internal worker requests, with no public Wire or database schema change.
Bun uses native SHA-256 with the same object identities as the portable fallback.

## Incremental retained state

Indexed state maps retain large history records through shared value pages.
Before/after piece sequences share unchanged pages across effects instead of
embedding a complete copy in every record. Readers retain compatibility with
inline history records and legacy state roots. These are internal object formats,
not changes to public update requests; old deployed binaries cannot read the new
formats after they have been written.

Canopy validates new history records and carries their typed dependencies with
that validation. Per-evaluation proofs survive until acceptance even when they
are too large for the optional cross-request cache. Material validation compares
against the preceding validated state; graph validation inherits unchanged
structure only from an accepted root. Retention independently checks availability
of staged dependencies before acceptance. See the [scaling measurements and
remaining limits](canopy-update-performance.md#structural-diagnosis-and-fixes).

## Objects, authority and failure

`@arbor/object-store` provides immutable, hash-sharded storage. Reads verify
hashes. Durable writes flush files and atomically link them into place;
disposable staging uses atomic publication without fsync. A merge job reads
shared storage first, falling back to staging only when an object is absent.
Corrupt shared bytes fail validation. Generated objects are written only into
staging. Generated hashes already present in the shared store
reuse those verified bytes; Canopy reads returned hashes from staging or shared
storage. Neither process recopies existing immutable material into every job.
Request JSON contains no object-store filesystem paths.

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

Canopy uses one worker, at most 64 queued evaluations, a
30-second worker timeout with forced termination, and an 8 MiB stdout/stderr buffer
limit. Runtime options can change the timeout, but not add workers. Worker launch, timeout,
validation or execution failure preserves ordinary snapshot content as accepted
ambiguity where the existing snapshot path can do so safely. Authoritative operation
execution and semantic checkpoint failures cannot become unchecked snapshot writes:
no acceptance is recorded, and the client retains its durable request for retry.
An exact accepted retry uses its receipt without requiring the worker. Governed account
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
v1/v2 merging. The [operation evaluator](merge-operation-evaluation.md) adds exact authored-operation execution, nested choices and conservative format rules; its verified support contract completes the tool-only scope of 013.

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
