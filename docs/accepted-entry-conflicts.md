# Accepted whole-entry conflicts

Source-built Canopy retains competing file edits, including nested files, as accepted choices.
This checkpoint is on main, not deployed. It uses the existing unversioned Wire
contract; clients need no identity map, review cache or coordinated upgrade.

## Implemented slice

Creation accepts source candidates based on a retained accepted state, including
nested files, partial ranges and multiple operations per file.
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

Conservative entry fallback follows the complete retained accepted chain, including
source edits against successive bases, ordinary snapshots and equal-root updates.
It is independent of the automatic range-merger's 64-update limit. It collects exact
source operation contributions and identifies snapshot changes as such; old snapshots
without retained change identities do not gain invented provenance. Missing ancestry
is not treated as evidence of agreement.

Physical directories are traversed recursively, so files in different directories
have independent decisions even when their names and object hashes match. Nested
TreeID mounts are boundaries. A retained authored predecessor that differs from its
accepted projection still needs verified correspondence: existing hidden-alternative
continuations work, while general suffixes after an automatic merge remain guarded.

Once decisions exist, ordinary snapshot saves continue their attributable selected
revision. A stale save competing with a newer revision adds an alternative. Deleting
a visible file changes its selected alternative to absence and retains hidden content.
Entry kind changes retain explicitly typed values. A batch suffix continues its
previous *submitted candidate*, including a hidden alternative, rather than being
silently attributed to the accepted projection. Exact retries reconstruct that
attribution from retained accepted evidence. This works even when the alternatives
have equal bytes.

Attribution preserves independent physical entries and all open choices; it does
not infer renames or movement from snapshot equality. Deleting or replacing an
ancestor of unresolved nested decisions remains guarded until coupled structural
decisions can preserve their meaning. Directory backing metadata changes also
remain outside this reconciliation subset. Authority
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

These decisions use typed entry alternatives. A nested placement uses the existing
root material reference plus `within` parent segments; no Wire field was added.
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

Schema 10 introduced immutable per-accepted-state decision snapshots in `accepted_conflicts`.
Schema 11 adds an optional physical parent path to their private entry encoding.
Missing parent paths keep their historical root meaning. Integrity checks follow
the parent spine and verify the selected value at the exact physical entry.
Accepted changes, including snapshots, retain tree-scoped unique change identities.
Decisions, resolution declarations, accepted identity, unresolved flag, ref, provenance
and observation commit in one transaction. Selected revisions change independently
of hidden revisions. Old accepted states retain their prior decisions and resolution
receipts. `ConflictStore.objectDependencies()` exposes typed retention roots; integrity
verification checks both hidden objects and selected projection correspondence.

[Migration 009](../migrations/009-nested-conflict-locations/README.md) upgrades schema
8, 9 or 10 directly to 11. Existing schema 10 decisions and all accepted history are
preserved without rewriting their JSON. Known operation change IDs are backfilled
when upgrading older storage; old snapshot identities remain explicitly unknown.
Disposable migration tests pass; live-copy rehearsal and deployment remain pending. Do not downgrade an authority
to a binary that can discard accepted alternatives. Storage snapshots are deliberately
simple; packing and compaction must preserve these dependencies and remain separate
work under [storage 001](../plans/canopy-storage/001-pack-object-storage.md).

## Validation and remaining work

HTTP tests cover whole-file ambiguity, same-byte alternatives, snapshot continuation,
deletion, stale saves, historical/paged inspection, authorization, partial resolution,
choice of a hidden value, guard failures, rollback and exact batch replay. The protocol
gate also creates a real conflict, edits through the filesystem synchronizer, and
checks Swift inspection and snapshot acknowledgement against that accepted state.

Next: independent source-range decisions, coupled ancestor changes, broader causal
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
Nested tests exercise independent decisions, hidden successors, snapshot continuation,
partial resolution, ancestor-change rejection and 80 intervening source/snapshot
updates. They verify exact historical pages and storage integrity after restart.

The protocol harness now runs a Swift source-enabled document session through real
disposable Canopy at root and nested paths: capture R1, install several peer updates,
admit the exact R1 range edit,
restart the in-memory replica, publish accepted ambiguity, continue the hidden
candidate, and resolve from a second Wire client. It checks hidden candidate hashes,
historical inspection, stale resolution rejection, and an equal-root resolution
advancing accepted identity. This is automated client/server evidence; installed
Native apps and live Canopy remain unchanged.

Nested/history checkpoint verification: the 748-test product suite, protocol gate
(including both live Swift locations), typecheck, and five migration cases pass.
The migration tests preserve schema 10 rows exactly, retain schema 9 authored
provenance, permit a direct schema 8 upgrade, and roll back failed validation.

The CLI reconnect case was intermittent during final verification: one full product
run failed, isolated execution failed on both unchanged `a6a1b9c` and this change,
and the complete CLI suite passed on both. Reproduce the focused comparison with
`bun test tests/integration/cli-sync.test.ts --test-name-pattern 'stopped Canopy'`;
the ordinary file-level check is `bun test tests/integration/cli-sync.test.ts`.
This change does not alter CLI account configuration or reconnect behavior.
