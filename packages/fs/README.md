# `@overstory/fs`

`@overstory/fs` reads a placed folder as logical nodes, watches it, and converts
between the folder and protocol trees. `WorkspaceFS` reads, discovers and watches;
it never writes. The update machine writes accepted trees into the folder with
`materializeTree` (`protocol-tree.ts`), and editors write the folder as ordinary
files that the watcher then observes.

## Logical-node invariants

- A node has one extensionless logical path plus optional `bodyPath` and `directoryPath`.
- `x.md` is `/x`'s preferred body. A sibling `x/` supplies children.
- `x/_index.md` is the body only when `x.md` is absent. Having both body files produces a `duplicate-body-representation` diagnostic.
- Every physical directory has complete operational Markdown. Reads append ordinary links for otherwise-unmentioned immediate children without materializing a body.
- Directory content revisions cover exact stored body bytes plus canonically ordered immediate-child descriptors. Child-set changes change the revision; filesystem enumeration order does not.
- Every physical path is containment-checked against the real workspace root. Atomic-write staging names (`.arbor-txn-`, `.arbor-write-`) are ignored by listing and the watcher.
- Full-byte revisions and parsed body revisions are separate, so a frontmatter-only change still changes the byte revision.

## Discovery

Startup performs one symlink-safe discovery walk and shares its immutable result with page-ID loading, search indexing, and generated collection types. Discovery never follows symlinks. It omits Overstory-private or generated directories (`.git`, `node_modules`, `.arbor`, `Trash`, `.build`, and `DerivedData`); other hidden working directories, including `.claude`, remain ordinary workspace content.

## Watching

The watcher debounces each logical path, reads it, and emits one `FsEvent`: `created`, `updated`, `deleted`, `moved`, or a `diagnostic`. A Markdown page whose `id:` reappears at a new path within the delete window is reported as one `moved` event with `previousPath`, not as a delete plus a create.

## Public surface

`WorkspaceFS.open(root, { stateDirectory })` returns an instance with `resolve`, `read`, `list`, `subscribe`, `startupDiscovery`, `discoverRecursively` and `setExcludedRoots`. Filesystem-wide browsing opens it with `discovery: "none"` (no scan, no watch); `"shallow"` scans one level without watching.
