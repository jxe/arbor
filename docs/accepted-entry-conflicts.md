# Accepted whole-entry conflicts

Source-built Canopy retains competing root-file text edits as accepted choices.
This checkpoint is on main, not deployed. It uses the existing unversioned Wire
contract; clients need no identity map, review cache or coordinated upgrade.

## Implemented slice

Creation starts with two same-basis source candidates editing root-level files,
including partial ranges and multiple operations per file.
When exact reconciliation cannot combine them, Canopy retains each authored value,
selects the previously accepted value for the ordinary projection, and acknowledges
an accepted update with `conflicted: true`. Separate files have separate decisions.
Equal bytes do not collapse alternative identities. No conflict markers are inserted.
Format rules still run first; an unresolved or inapplicable result can retain choices,
but never forces the proposed text combination into the selected projection.
Each decision still chooses between complete file values. The portable contract
also supports text alternatives scoped to source ranges and multiple independent
decisions in one file; Canopy's current entry storage does not implement that finer
representation yet. Exact range operations and all their contribution identities
remain retained, so this fallback does not reduce authored intent to a snapshot.

Creation currently requires exactly one intervening accepted source candidate with
the same basis. Nested creation and more general histories remain outside this
slice and retain the prior explicit conflict response. Existing decisions still
support the continuation behavior below.

Once decisions exist, ordinary snapshot saves continue their attributable selected
revision. A stale save competing with a newer revision adds an alternative. Deleting
a visible file changes its selected alternative to absence and retains hidden content.
Entry kind changes retain explicitly typed values. A batch suffix continues its
previous *submitted candidate*, including a hidden alternative, rather than being
silently attributed to the accepted projection. Exact retries reconstruct that
attribution from retained accepted evidence. This works even when the alternatives
have equal bytes.

Attribution currently operates on root entries. It preserves independent root entries
and all open choices, but does not infer renames or movement from snapshot equality.
Changes to root backing metadata remain outside this reconciliation subset. Authority
write paths that bypass attribution refuse to change an unresolved projection rather
than publish stale decision correspondence. Ordinary filesystem and Wire submissions
use the attribution path and do not pause on accepted conflicts.

## Inspection and resolution

`GET /.arbor/trees/{tree}/conflicts?state={acceptedUpdate}` returns the existing
`DecisionPage` contract. `after` continues a state-bound page; `conflict` selects one
complete decision. They are mutually exclusive. The reference page size is 32, with
no limit of 32 on accepted decisions. Unknown, unavailable or unauthorized state is
404; malformed query/token bindings are 400. Historical pages retain their identities,
values and revisions when current advances.

These decisions use typed entry alternatives and placements under the tree root.
File and directory bytes are read through the alternative-scoped object route in
[tree operations](../spec/01-tree-operations.md#123-reading-conflicts). Every request
checks current tree read authorization and exact state/decision/alternative reachability.
Ordinary object reads do not gain access to hidden objects. File bytes are never
sniffed as directory encodings.

The TypeScript `WireClient.conflicts` and Swift `ArborWireClient.conflicts` validate
the requested tree/state/root context. Inspection advertises `resolveConflict`;
alternative-target editing is not yet enabled. A resolution uses ordinary supported
source operations plus `resolves`, or `operations: []` to keep the current projection.
The declaration must name the current accepted state and complete alternative set.
A reviewed whole-file replacement can choose another value. Several declarations
are atomic, and unnamed decisions survive. Snapshot-mode resolution, configuration
resolution, and additional operation kinds remain unsupported. Stale/incomplete guards
return the existing structured conflict response without discarding work.

## Persistence and upgrade

Schema 10 adds immutable per-accepted-state decision snapshots in `accepted_conflicts`.
Accepted changes, including snapshots, retain tree-scoped unique change identities.
Decisions, resolution declarations, accepted identity, unresolved flag, ref, provenance
and observation commit in one transaction. Selected revisions change independently
of hidden revisions. Old accepted states retain their prior decisions and resolution
receipts. `ConflictStore.objectDependencies()` exposes typed retention roots; integrity
verification checks both hidden objects and selected projection correspondence.

[Migration 008](../migrations/008-accepted-conflicts/README.md) upgrades schema 8 or 9
directly to 10 while preserving history and provenance. Known operation change IDs
are backfilled; older snapshot change identities remain explicitly unknown. Disposable migration tests
pass; live-copy rehearsal and deployment remain pending. Do not downgrade an authority
to a binary that can discard accepted alternatives. Storage snapshots are deliberately
simple; packing and compaction must preserve these dependencies and remain separate
work under [storage 001](../plans/canopy-storage/001-pack-object-storage.md).

## Validation and remaining work

HTTP tests cover whole-file ambiguity, same-byte alternatives, snapshot continuation,
deletion, stale saves, historical/paged inspection, authorization, partial resolution,
choice of a hidden value, guard failures, rollback and exact batch replay. The protocol
gate also creates a real conflict, edits through the filesystem synchronizer, and
checks Swift inspection and snapshot acknowledgement against that accepted state.

Next: independent source-range decisions, nested locations, broader causal
correspondence, direct alternative edits, and the client review UI. Existing format
rules and their asynchronous execution boundary remain separate from persistence;
rule configuration, a sidecar, packfiles and review caching are not introduced here.

Checkpoint verification: 731 product tests, typechecking, and the full protocol gate
passed, including the real filesystem continuation case, Swift conflict inspection
and acknowledgement, and 60 working-tree tests. Migration 008 passed four preservation,
rollback, version and direct-upgrade cases. Relative-link and anchor checks introduced
no new unresolved references. No live database, installed app or deployment was changed.

## Range-input and live-client verification

Range-input tests exercise overlapping replacements, same-anchor insertions,
equal-byte intent, multiple contributions per file, Unicode replacements and
format-declined disjoint Markdown in both arrival orders. They check complete
alternative values/provenance, restart, immutable receipts and storage integrity.
A negative test retains the nested-creation boundary.

The protocol harness now runs a Swift source-enabled document session through real
disposable Canopy: capture R1, install peer R2, admit the exact R1 range edit,
restart the in-memory replica, publish accepted ambiguity, continue the hidden
candidate, and resolve from a second Wire client. It checks hidden candidate hashes,
historical inspection, stale resolution rejection, and an equal-root resolution
advancing accepted identity. This is automated client/server evidence; installed
Native apps and live Canopy remain unchanged.
