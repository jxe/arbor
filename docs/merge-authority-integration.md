# Merge authority integration checkpoint

Merged to main and deployed to `arb.nxhx.org` on 2026-09-17. This is the
server integration of [operation evaluation](merge-operation-evaluation.md), with
no public Wire, client state-machine or portable specification change.

Canopy forwards the exact authored operations, candidate, original semantic basis,
current state, guarded decisions and authorized alternative bindings. The tool
executes all eight specified operation kinds and returns both the authored state
and reconciled state. Canopy's former `editSource` executor/reconciler is no longer
in the acceptance path. Snapshot and account rules remain distinct inputs to the
same executable; account authorization stays in Canopy.

## Ownership and validation

Schema 12 adds `accepted_merge_states`, owned by the accepted update ID. Its record
contains the accepted state hash, exact authored state hash, public inspections,
complete immutable dependency closure, original intent and validation evidence.
The accepted row, inspection ownership and transition commit in one transaction.
Objects are hash-verified and durably stored before that transaction; unowned staged
objects are never accepted state. Historical schema-11 records remain readable.

Canopy validates result projection, tree scope, decision dependencies, selected
material, request binding, response/state agreement, retained unresolved decisions
and the transitive object closure, including deleted/undo material and hidden
contexts. Public decision/alternative IDs are assigned by Canopy from tree-scoped
private keys. Tool node IDs, state layout and process API are not portable Wire.
Rule configuration is retained with the immutable evaluation envelope.

Historical snapshots acquire conservative semantic checkpoints when needed.
Unchanged path occurrences retain provenance; changed snapshot bytes acquire an
opaque origin. A checkpoint does not claim a move, copy or resolution. There is no
second local/client merge engine, migration rewrite of historical roots, or object
store layout change. The store remains append-only; packing and GC remain in the
[packfile plan](../plans/canopy/001-pack-object-storage.md).

## Existing clients

Installed `editSource` editors and filesystem snapshot clients use the same update,
watch, inspection and resolution contracts. Accepted ambiguity installs normally
and permits later publication. Source successors retain their exact candidate basis,
including when that candidate became a hidden alternative. Matching uses retained
origins, never byte equality. Exact retries use immutable receipts even if the
worker is unavailable. Unvalidated source intent is never downgraded to a snapshot.

The original deployment requested whole-file choices. The current implementation
defaults to independent source choices, with current material selected; an explicit
`mergeTool.contentChoices: "file"` option retains whole-file presentation. Format
rules can still require coupled choices. Inspection ranges bind to the actual
accepted file hash and alternatives expose exact retained fragment objects. Deleting,
replacing or moving an ancestor may create a whole-root enclosing decision with
independent child decisions retained. Dependencies form the tool's acyclic constraint
graph; keeping a parent can leave its children open, while discarding guarded child
material requires coherent declarations. Stale snapshots that cannot be attributed
retain their exact candidate alongside current and any merged projection.

The implementation remains conservative at snapshot barriers and unsupported format
structures. Historical rule results and accepted receipts are not recomputed.
Native's new review UI, broader editor capture and configurable Canopy/tree policies
remain separate work. Unknown operation kinds are still invalid under the existing portable contract.

## Verification and deployment boundary

Focused tests cover all eight operations through HTTP, undo after restart, hidden
alternative editing, lenient Markdown insertions, exact replay with a missing worker,
transaction rollback, forged projection/missing inverse objects, nested decisions,
guarded resolution, and stale intent across 80 intervening source/snapshot updates.
The cross-language protocol gate runs disposable Canopy/Arbor Sync hosts with Swift
Wire, working-tree and real editor-admission tests. See the
rehearsal record (migration 010, deleted after cutover; see git history) for restored production data.

The server and packaged worker deployed together after quieting writers, verifying
a fresh backup, and migrating schema 11 to 12. Clients need no rebuild for this
server milestone. See the live cutover record (migration 010, deleted after cutover; see git history).
Ship server support before enabling new editor operations.

September 17 verification: the full product suite passed 957 tests. TypeScript
checking, the CLI build, migration tests, repository-wide relative-link audit (no
new failures), whitespace checks and the full Swift/TypeScript live protocol gate
passed. The restored-backup rehearsal preserved every old accepted row.

The Dockerfile's package payload was copied to an isolated directory, installed
with frozen production-only dependencies, and exercised with the pinned Bun 1.3.14
runtime. The worker ran outside the checkout and passed a TypeScript WASM-parser
merge through Canopy's response/closure validation. The subsequent Railway deployment built and health-checked the actual Linux image;
see the live cutover record for its revision and image digest.

The final focused suite also passed all 205 merge/authority tests on Bun 1.3.14,
including snapshot-conflict identity preservation and the eight-operation lifecycle.
