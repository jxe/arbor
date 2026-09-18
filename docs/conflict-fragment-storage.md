# Conflict fragment storage proof

This is a durable representation and lifecycle experiment, not the production
Canopy backend. Its [store](../packages/canopy/src/experimental/conflict-fragments/store.ts)
uses a separate SQLite database and refuses to open a database containing Canopy
or another experiment's tables. The [tests](../tests/unit/canopy/conflict-fragments.test.ts)
exercise real disk persistence, restart, exact request replay and transaction failure.
Production remains on schema 11 with [whole-entry decisions](accepted-entry-conflicts.md).
No migration, Wire change, client emission or deployment is part of this checkpoint.

## Representation

Immutable fragment nodes are addressed by the hash of canonical JSON. Immutable
source objects are addressed by their ordinary Wire hash. The node kinds are:

- `slice`: source object and UTF-8 byte range, including empty source.
- `sequence`: ordered fragment references forming a file.
- `directory`: named child references, preserving physical occurrence scope.
- `absent`: an entry's absence, distinct from an empty file.
- `choice`: decision identity, selected alternative, and alternatives containing
  identity, revision, fragment reference and contributing change/operation references.

An accepted experimental state references a fragment graph, its ordinary Wire tree
projection and its predecessor. Both graph and ordinary root are retained. Selected
alternatives determine visible bytes; all branches participate in conflict inspection
and validation. Thus a selected deletion can project an absent directory while the
accepted state still contains unresolved decisions in its hidden directory alternative.
Repeated content shares objects. Decision identities cannot be reused for separate
occurrences. This slice has no mounts, directory metadata, binary leaf nodes or
operation correspondence across different bases; those require explicit extensions.

The graph has no mutable current-file offsets. A length-changing alternative edit
replaces its fragment reference and revision, sharing unaffected sequence children.
Editing a descendant also changes the revision of every enclosing alternative whose
fragment changed. It does not alter the independent sibling decision. The original
range partitioner supplies the first two-choice document in the tests; its region
positions do not become public decision identities.

## Lifecycle findings

The disk-backed corpus demonstrates:

1. Two independently resolvable source choices in a nested file, including a hidden
   alternative edit, length changes, restart and partial resolution. BOM, CRLF and
   Unicode bytes remain exact. Historical alternatives remain readable.
2. An ancestor deletion can wrap the previous directory graph in one choice. Keeping
   that directory preserves its independent decisions. Discarding it requires the
   same atomic request to guard every descendant decision that will disappear.
3. An opaque whole-file replacement can similarly wrap the previous file graph,
   retaining its internal choices without enumerating whole-document combinations.
   This proves representability, not a rule that every snapshot should create a choice.
4. Equal bytes never clear identity. A hidden edit or explicit resolution can produce
   a new accepted state with the same ordinary root.
5. Incomplete guards, stale state/revisions, identity reuse and accidental decision
   loss are rejected. A failed receipt insert rolls back accepted state and head;
   exact retry succeeds afterwards. Reading a retained state requires its tree owner.

These results favor the composable graph over adding only flat byte ranges to the
existing entry records. A flat range list cannot itself express the ancestor or opaque
replacement case without flattening the nested decisions or introducing another
composition mechanism.

## Physical layout and boundaries

The isolated database has immutable object and node tables, accepted state rows,
one head per tree, and request receipts. Accepted state, head and receipt are written
in one SQLite transaction. Builder operations can leave unreferenced staged nodes;
there is no collector. All historical states and all objects remain retained. Graph
validation walks hidden alternatives, verifies source hashes/scalar boundaries and
caps traversal. This is deliberately not a production retention or resource policy.

The experiment exposes internal constructors and guarded mutations, not network
endpoints or a new resolution language. It has exact-state admission for validating
the representation; production still needs ordinary reconciliation against a stale
basis. It is not a source-format analyzer and does not choose whether to autoresolve.
Per-format rules must continue owning that decision.

Production adoption remains a coordinated implementation task: extract the graph
projection/validation into the existing accepted transaction, bind original operations
to fragment occurrences, retain all graph/object dependencies, add a history-preserving
offline migration, and produce existing Wire material references and inspection.
Then exercise ordinary snapshot/source continuation, partial resolution and recovery
through TS and Swift against the real server. In particular, hidden nested decisions
need inspection locations and dependencies before clients can review them. The
experiment's ancestor context is private and must not be copied into Wire ad hoc.

Packing remains a separate physical optimization governed by
[storage plan 001](../plans/canopy/001-pack-object-storage.md). No per-character
patch graph or packfile implementation was needed to pass this corpus.

Verification: nine focused storage tests pass; the full product suite passes
766 tests. Typecheck and build pass. Repository-relative link checks introduce no
new failures (24 pre-existing unresolved links). No live data was opened or changed.
