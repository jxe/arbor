# Accepted whole-entry conflicts

Canopy retains competing source and snapshot edits, including nested files, as accepted choices.
The source/ancestor checkpoint is deployed with schema 11; snapshot acceptance is described in the checkpoint below. Installed Native now emits
source operations after its [verified cutover](native-source-cutover.md); filesystem
clients continue to emit snapshots. It uses the existing unversioned Wire
contract; clients need no identity map, review cache or coordinated upgrade.

## Implemented slice

Creation accepts source candidates and plain snapshots based on a retained accepted state, including
nested files, partial source ranges and multiple operations per file. Snapshots do not
need an existing conflict before Canopy can retain alternatives.
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

The next representation step is implemented separately in
`packages/canopy/src/updates/source-regions.ts`: a pure, same-basis partition and
projection function. It groups connected overlapping operations into source
regions, retains each change's exact regional text and operation identities, and
allows independent choices within one file. Untouched bytes come from the immutable
source object. Equal-byte alternatives remain distinct; insertion anchors follow
the exact executor's boundary rules. The focused corpus covers two independent
overlaps, bridging overlaps, insertions, deletion, UTF-8/BOM/CRLF fidelity,
arrival permutations and serialized layouts. This is not yet called by update
acceptance or persisted as conflict state. It makes no format-specific resolution
decision. Durable decision identity, accepted projection correspondence, continuation,
inspection and guarded partial resolution must be integrated together before
replacing entry fallback. Different causal bases and structural coupling still
require additional correspondence.

Conservative entry fallback follows the complete retained accepted chain, including
source edits against successive bases, ordinary snapshots and equal-root updates.
It is independent of the automatic range-merger's 64-update limit. It collects exact
source operation contributions and identifies snapshot changes as such; old snapshots
without retained change identities do not gain invented provenance. Missing ancestry
is not treated as evidence of agreement.

Physical directories are traversed recursively, so files in different directories
have independent decisions even when their names and object hashes match. Nested
TreeID mounts are boundaries. A retained authored predecessor that differs from its
accepted projection uses the validated or exactly replayed request prefix as its
correspondence evidence. Source successors preserve unrelated accepted additions
and deletions. Differences between the authored predecessor and its accepted
projection enter conservative reconciliation alongside subsequent accepted changes;
same-file differences retain alternatives rather than guessing range translation.
The original source basis and operations remain unchanged in retained history.

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
ancestor of unresolved nested decisions adds an enclosing entry decision and keeps
the selected directory spine. The deletion or replacement remains a hidden
alternative; later selected-child edits update the enclosing selected directory,
while attributable hidden-ancestor edits continue their own alternative. A snapshot
move conservatively retains the old location and adds the destination; it does not
invent relocation intent. Collection backing metadata and coupled rename choices can retain the whole
directory, including the root, rather than fabricate independent entry choices. Authority
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
root material reference plus `within` parent segments. A root choice uses
`kind: "directory"`, the root basis reference and directory-valued alternatives
without `placement`; it has no containing entry or synthetic filename. No Wire
field was added. The shared TS/Swift inspection fixture covers this shape.
File and directory bytes are read through the alternative-scoped object route in
[tree operations](../spec/01-tree-operations.md#123-reading-conflicts). Every request
checks current tree read authorization and exact state/decision/alternative reachability.
Ordinary object reads do not gain access to hidden objects. File bytes are never
sniffed as directory encodings.

The TypeScript `WireClient.conflicts` and Swift `ArborWireClient.conflicts` validate
the requested tree/state/root context. Inspection advertises `resolveConflict`;
alternative-target editing is not yet enabled. A resolution uses ordinary supported
source operations or an explicit snapshot (`operations: null`) plus `resolves`,
or `operations: []` to keep the current projection.
The declaration must name the current accepted state and complete alternative set.
A reviewed whole-file replacement can choose another value. Several declarations
are atomic, and unnamed decisions survive. Inspection derives ancestor/descendant
`dependencies` from existing physical locations. Choosing an ancestor result that
would discard an unguarded descendant's selected material fails; guard those
decisions in the same package. Keeping an ancestor can resolve it alone, and a
child can resolve while its ancestor stays open. Configuration resolution and
additional operation kinds remain unsupported. Stale/incomplete guards
return the existing structured conflict response without discarding work.

## Persistence and upgrade

Schema 10 introduced immutable per-accepted-state decision snapshots in `accepted_conflicts`.
Schema 11 adds an optional physical parent path to their private entry encoding.
Coupled ancestor decisions reuse that encoding and require no schema upgrade.
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
Disposable migration tests and the [fresh schema 8 → 11 live-copy rehearsal](../migrations/009-nested-conflict-locations/rehearsal.md) pass; the [live server cutover](../migrations/009-nested-conflict-locations/live-cutover.md) is complete. Do not downgrade an authority
to a binary that can discard accepted alternatives. Storage snapshots are deliberately
simple; packing and compaction must preserve these dependencies and remain separate
work under [storage 001](../plans/canopy-storage/001-pack-object-storage.md).

## Validation and remaining work

HTTP tests cover whole-file ambiguity, same-byte alternatives, snapshot continuation,
deletion, stale saves, historical/paged inspection, authorization, partial resolution,
choice of a hidden value, guard failures, rollback and exact batch replay. The protocol
gate also creates a real conflict, edits through the filesystem synchronizer, and
checks Swift inspection and snapshot acknowledgement against that accepted state.

Next: independent source-range decisions, broader causal
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
partial resolution and 80 intervening source/snapshot
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

## Ancestor acceptance checkpoint

This checkpoint is [deployed](ancestor-conflicts-deployment.md) on schema 11.

Seven HTTP scenarios cover deletion, file replacement and hidden continuation,
snapshot movement, selected-child continuation, multiple enclosing decisions,
ancestor-only and child-only resolution, and atomic child resolution with ancestor
deletion. They verify dependency inspection, incomplete/stale guards, exact retry,
restart, historical reads and full storage integrity with schema 11 unchanged.

Validation: typecheck, all 779 product tests, the cross-language protocol gate and
CLI build passed. The documented intermittent CLI reconnect failure occurred on
the first full run; its file-level rerun and the next full run passed. Repository
relative-link checks introduced no new failures (24 existing unresolved links).

Merged-predecessor verification: 782 product tests, typecheck, CLI build and the
full cross-language protocol gate passed. HTTP tests cover source and snapshot
predecessors, same-file alternatives, original source-basis retention, intervening
snapshot edits, hidden continuation, restart and exact prefix replay. The Swift
live scenario now publishes both continued branches after uncertain acceptance.

## Snapshot acceptance checkpoint

Ordinary snapshot conflicts now become accepted alternatives rather than the old
rejected-update response. Binary replacement, deletion versus editing, entry-kind
changes and nested conflicts preserve exact candidate bytes. A submitted suffix
keeps its authored predecessor, including hidden alternatives and differences
between that predecessor and its accepted projection. Replay and restart retain
those identities and all unrelated accepted additions.

The snapshot merge still runs format rules first. Successful rule output outside
coupled choices is retained, including generated objects. Rules that detect a
coupled rename or collection conflict mark its directory scope; that scope stays
a whole-directory choice rather than silently duplicating a renamed page or
separating collection backing from its descriptor. Root decisions use an explicit
`root: true` location in the existing JSON conflict state. Child dependencies and
guarded resolution work across root and nested choices, and alternative object
reads retain their existing authorization boundary.

No SQLite schema or Wire grammar migration is needed. Both client languages already
accept this inspection shape. A server rollback must preserve support for root
choices once they have been accepted; do not run a prior server over that state.

The internal `ifMatch` and `onConflict` switches are removed. Ordinary ambiguity
must pass through accepted decision storage. Explicit `ifCurrent`, stale or
incomplete resolution guards, authorization, invalid candidates and governed
account-configuration policy still reject requests. Missing retained ancestry is
an explicit availability error, not a guessed merge or client-owned conflict.
Historical recovery artifacts still decode their old policy fields; new recovery
submissions use `ifCurrent`.

Coverage includes HTTP inspection/watch delivery, snapshot suffixes, restart and
exact replay, root and nested divergent renames, collection metadata, coupled
child resolution, format-rule output alongside binary ambiguity, and real
filesystem publication while a choice remains unresolved. The shared inspection
fixture also runs through Swift. Full product, typecheck, build and protocol gates
pass. Deployment evidence will be recorded after the live verification.
