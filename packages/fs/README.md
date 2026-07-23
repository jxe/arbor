# `@arbor/fs`

`@arbor/fs` is Arbor's only server-side authority for workspace-content I/O. Arbord owns search, collections, generated types, and link healing, but it resolves and mutates materialized content through `WorkspaceFS`.

## Logical-node invariants

- A node has one extensionless logical path plus optional `bodyPath` and `directoryPath`.
- `x.md` is `/x`'s preferred body. A sibling `x/` supplies children.
- `x/_index.md` is the body only when `x.md` is absent. Both body files produce `duplicate-body-representation` and block content and structural mutation.
- A sibling body and directory move, copy, rename, trash, and restore as one unit.
- Destinations never overwrite, merge, or acquire an automatic suffix.
- Every physical path is containment-checked against the real workspace root. Transaction staging names are private, same-filesystem siblings and are ignored by the watcher.
- Full-byte revisions are the compare-and-swap boundary. Parsed body revisions are separate recovery information and cannot hide frontmatter-only changes.

## Discovery

Startup performs one symlink-safe discovery walk and shares its immutable result with page-ID loading, search indexing, and generated collection types. Discovery never follows symlinks. It omits Arbor-private or generated directories (`.git`, `node_modules`, `.arbor`, `Trash`, `.build`, and `DerivedData`); other hidden working directories, including `.claude`, remain ordinary workspace content.

## Coordinators

Two state machines cooperate:

1. A node coordinator, keyed by durable page ID when known and logical path otherwise, serializes document generations. It owns recent authored byte revisions, durable generation, watcher echo settlement, unsettled-stomp reassertion, and shutdown draining.
2. The workspace mutation coordinator serializes mutation batches and acquires affected node coordinators in stable logical-path order. It preflights the full batch before recording intent or moving a source.

A document generation performs:

```text
resolve + byte CAS
  → append block intent
  → prepare and fsync sibling temporary
  → repeat byte CAS
  → atomic replacement
  → mark journal materialized
  → watcher echo or settlement timeout
  → one logical event
```

Once a generation has settled, disk changes are authoritative external observations. Even a byte revision found in the authored-revision ring is never automatically overwritten after settlement. During the unsettled window only, a known older authored revision is a stomp and the newest generation is reasserted.

## Mutation recovery

Each batch has a private intent record with `prepared`, `committing`, `committed`, or `interrupted` state.

- Before `committing`, restart removes prepared temporaries.
- From `committing`, restart rolls known source/staged/destination states forward.
- Missing or unfamiliar states stop recovery and retain the intent plus every discoverable version under an `interrupted-fs-transaction` diagnostic.
- Watcher events for staging and intermediate paths are suppressed. Consumers receive the logical batch only after commit.

Tests should use temporary workspace and state directories and inject faults at named transition points. Important sequences include rapid document generations, rename during pending save, external atomic replacement, metadata-only rewrites, settled old-byte rewrites, partial hybrid-node moves, directory-row rewrites, and shutdown drain.

## Public surface

`WorkspaceFS.open(root, { stateDirectory })` returns an instance with `resolve`, `read`, `list`, `writeMarkdown`, `writeFile`, `mutate`, `recovery`, `restoreBlock`, `subscribe`, and `drain`. `mutate` accepts a discriminated `FsMutation` batch and returns a transaction ID plus logical created, updated, moved, and deleted paths. Failed preconditions throw `FsConflictError` with structured details suitable for HTTP 409 responses.
