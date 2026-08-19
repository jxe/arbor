# TreeHopper native implementation plans

These are active executor handoffs for the new, parallel TreeHopper app. They
replace neither the product roadmap nor the canonical native architecture in
[`README.md`](README.md). Completed implementation belongs in
[`../records/history.md`](../records/history.md), not in this queue.

Each executor must read the assigned plan fully, honor its STOP conditions,
run every verification gate, and update the status here. Plans 001–005 were
originally written against Arbor `84fc705` and Hunch `4c35f37`; each plan has a
live drift check and must be reconciled before execution.

## Decisions carried by this plan set

- Build a new app in `/Users/joe/src/arbor/native`; do not rename or fork the
  Hunch app target.
- Use **TreeHopper** as the working product/app name because it is already the
  Arbor browser name. Freeze the final name and reverse-DNS identifiers before
  creating signed builds or persistence keys; Arbor's docs still call the name
  provisional.
- The pre-publication foundation is implemented: Arbor accepts exact Markdown
  source plus `baseContentRevision` and owns complete-directory Markdown;
  Quagmire and Hunch use one neutral document-link row, H1–H6, raw fallback,
  observed target presentation, safe system replacement, and a specified
  stable-`BlockID` lifecycle. Publish that finished boundary as the first
  `0.1.0`; there is no intermediate public Hunch-specific row API or planned
  immediate `0.2.0`.
- Keep exactly two native workspace providers: arbord on macOS and a direct
  local/iCloud file provider on iOS or in deliberate arbord-less mode. Do not
  create a backend plugin framework.
- Make complete directory indexes provider-owned Markdown, not client-composed
  editor state. The first eligible standalone link to an immediate child owns
  its placement; missing children are appended as ordinary links; the first
  authored write materializes the complete document. Link ordering is content,
  while physical move/rename/copy/Trash remains structural. The existing
  `contentRevision`/`baseContentRevision` guard the stored body plus immediate
  physical-child descriptors, and unmatched children use canonical logical-path
  UTF-8 byte order. Source, search, backlinks, rendering, serving, and any future
  export all consume that same operational document. A directory-backed
  collection may expose this as an About/index facet, but its rows and virtual
  tables do not become index links.
- Make exact source the only authored content payload. Reads expose authoritative
  `document.source`; writes submit `source` plus `baseContentRevision`; arbord
  and the direct Swift provider parse it internally for validation, indexing,
  search, backlinks, recovery, rendering, and hosted output. Parsed blocks are
  derived read conveniences, never client-authored wire truth.
- Keep Quagmire's existing contextual mention rule. The implemented local 0.1
  boundary represents H1-H6 exactly while its creation UI remains H1-H3, and
  replaces `.subpage` with a neutral document-link row carrying an authored
  attributed label plus an opaque reference. Ephemeral target metadata and a
  fixed per-reference set of the row's existing actions let Hunch reproduce its
  current behavior while TreeHopper exposes the full set for stored or implicit
  directory Markdown when authority permits, and omits or visibly interrupts
  ineligible actions before their specified source-mutation boundary. Its raw
  fallback retains unsupported Markdown without silent structured normalization.
  Quagmire specifies how `BlockID` survives edit, move, nesting, undo,
  split, merge, paste, duplicate, and cross-document operations. It remains
  format-neutral: no Markdown dependency, source snapshot, range, source
  handle, or generic metadata bag enters the package.
  Quagmire and Hunch migrated together locally; Plan 001 publishes that exact
  boundary and switches Hunch to it remotely. No parallel `.subpage`
  compatibility row remains.
- Preserve Hunch's durability semantics, not its application identity or exact
  `.history/*.jsonl` representation. The Arbor cloud journal is versioned,
  PageID-keyed, and tested identically in Swift and TypeScript.
- Never let arbord and a direct Swift provider author the same macOS subtree at
  the same time. Never apply Arbor wire replication and iCloud replication as
  symmetric writers over the same mutable subtree.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [001](001-publish-quagmire.md) | Publish the final Quagmire 0.1.0 and prove remote consumption | P1 | M | implemented foundation | TODO |
| [002](002-found-treehopper-native.md) | Freeze identity and found the new TreeHopper app | P1 | L | 001 | TODO |
| [003](003-bridge-quagmire-to-arbor.md) | Connect Quagmire to exact Arbor source through a thin host | P1 | L–XL | 001, 002 | TODO |
| [004](004-build-arbor-cloud-durability.md) | Specify and implement Hunch-grade Arbor iCloud durability | P1 | XL | 002; integrates after 003 | TODO |
| [005](005-complete-native-parity-and-migration.md) | Complete native parity, import Hunch safely, and qualify release | P2 | XL | 003, 004 | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale).

## Dependency notes

- The implemented foundation is recorded in [`../records/history.md`](../records/history.md):
  Arbor commit `05bcf35` established exact-source/provider-owned directory
  documents, and Hunch commit `ef37cc6` completes the local Quagmire/Hunch
  boundary and review fixes. It performed no extraction or TreeHopper
  integration.
- Plan 001 extracts and publishes exactly that proven local Quagmire boundary
  as 0.1.0. Release/history work cannot redesign it.
- Plan 002 establishes product identity, package topology, provider/session
  contracts, and a read-only browser against the published package and completed
  Arbor contract.
- Plan 003 retains the later integration work only: a private host-owned source
  ledger keyed by stable Quagmire IDs, references, mentions, session admission,
  action mapping, and TreeHopper editor integration. It does not change Arbor
  core or Quagmire's public model.
- Plan 004's format/fixture work may begin after Plan 002, but its application
  integration waits for Plan 003's session/host boundary.
- Plan 005 is intentionally last: feature parity and real-data import are unsafe
  until both document mapping and cross-device durability pass independently.

## Findings considered and rejected

- **Turn Hunch into TreeHopper in place:** rejected because its flat page graph,
  bundle/defaults/cache identity, URL-keyed navigation, and Clamshell lifecycle
  would make Arbor's heterogeneous node model look like a storage adapter.
- **Publish the old Hunch-specific subpage API as 0.1 and follow immediately with
  0.2:** rejected. The known neutral row, H1-H6, raw fallback, and Hunch migration
  landed locally before extraction, so the first public 0.1 is the intended
  shared boundary.
- **Copy Clamshell unchanged into Arbor:** rejected because URL/path-keyed page
  coordination and path-mirrored history are wrong for stable PageID moves, and
  its exact sidecar syntax is not required.
- **Use CloudKit as a second canonical database:** rejected because the product
  contract keeps materialized Markdown canonical and the user asked for
  iCloud-quality file synchronization, not a proprietary content authority.
- **Run arbord and direct Swift persistence together on macOS:** rejected because
  two first-party intent authorities cannot classify each other's writes safely.
- **Treat a directory-index link as containment:** rejected. An ordinary link,
  the first eligible standalone link representing an immediate child, and the
  child's physical/tree containment remain distinct facts.
- **Annotate every managed child link:** rejected because the first eligible
  standalone link to each immediate child is deterministic. Missing children
  can be appended without new syntax; any future negative exception marker must
  be justified by a real need rather than added to every normal link.
- **Keep directory completeness in each client:** rejected because the old
  synthetic projection is not reliably invertible under arbitrary prose/link
  reorder. Arbord and the direct Swift provider return the complete operational
  Markdown and guard writes with body-plus-child-set revision state.
- **Send parsed blocks as the authored Arbor mutation:** rejected because
  client-produced semantics cannot preserve exact unknown Markdown or serve as
  trusted input to indexing, backlinks, rendering, and recovery. Providers own
  parsing; clients author exact source.
- **Put Markdown source tracking into Quagmire:** rejected because stable editor
  identity is the reusable capability. The TreeHopper host can privately map a
  `BlockID` to any parser-specific source record without making the editor
  package Markdown-specific.
- **Create an `ArborDocumentAdapter`:** rejected because it would become a
  second canonical document model. The thin host needs only a Markdown codec,
  a private source-reuse ledger, and the existing workspace session.
