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

## Membership

`IgnorePolicy` (`ignore-policy.ts`) decides which local paths belong to the tree, as
[directory format §7](../../docs/overstory-spec/02-directory-format.md#7-tree-membership-and-ignore-files)
specifies. Discovery, listing, resolution, watching, snapshots and materialization all
take their decisions from one policy; a new consumer of the folder's contents receives
that policy (or a result it already filtered) and never keeps its own list of names.

- `policy.decision(treePath, isDirectory)` returns `included`, `mandatory`, or `ignored`,
  with the ignore file and rule that decided an `ignored` path.
- Mandatory exclusions (`.git`, `node_modules`, `.arbor`, `Trash`, `.build`,
  `DerivedData`, transaction temporaries, iCloud placeholders, nested mounts) cannot be
  negated. `IGNORED_WORKSPACE_DIRECTORIES` remains only for the watcher's static globs.
- `.arborignore` and `.gitignore` use Git's grammar through a small matcher of our own.
  Separate per-file instances of the `ignore` package cannot apply a deeper file's
  negation to an ancestor another file excluded, and it matches case-insensitively by
  default. The TypeScript and Swift (`CanopyWorkingTree/IgnorePolicy.swift`) matchers
  both run `tests/fixtures/ignore-policy/cases.json`. Unlike Git, `?` and bracket
  expressions match one Unicode character rather than one byte.
- Git is never invoked. `.git/info/exclude`, `core.excludesFile` and global ignore files
  are not read, so a placement's tree does not depend on the machine.
- An ignore file that is not UTF-8 applies no rules and appears in `policy.diagnostics`
  (`ignore-file-not-utf8`, naming the file only); `WorkspaceFS` emits it as a
  `diagnostic` event.
- A policy reads each rule file once. Load a new policy to see edits.

Rules decide local membership only. A synchronizer also keeps paths that the folder's
last-held root already contains: `membershipSkip(policy, tracked)` builds the walk filter
`snapshotDirectory` and `materializeTree` take, leaving out an ignored path unless
`tracked` (`trackedEntries(root, load)`) has an entry of the same kind there.
`materializeTree` never deletes a path the filter leaves out.

## Discovery

Startup performs one symlink-safe discovery walk and shares its immutable result with page-ID loading, search indexing, and generated collection types. Discovery never follows symlinks and admits exactly the paths the policy includes; other hidden working directories, including `.claude`, remain ordinary workspace content.

## Watching

The watcher debounces each logical path, reads it, and emits one `FsEvent`: `created`, `updated`, `deleted`, `moved`, or a `diagnostic`. A Markdown page whose `id:` reappears at a new path within the delete window is reported as one `moved` event with `previousPath`, not as a delete plus a create.

Events are filtered through the current policy. A change at an ignored path is never a node event; `subscribeIgnored` reports its physical tree path to a synchronizer that may still track it. An edit to any `.arborignore` or `.gitignore` reloads the policy and rediscovers once, then emits `updated` at `/` as a tree-level invalidation.

## Public surface

`WorkspaceFS.open(root, { stateDirectory })` returns an instance with `resolve`, `read`, `list`, `subscribe`, `subscribeIgnored`, `ignorePolicy`, `startupDiscovery`, `discoverRecursively` and `setExcludedRoots`. Resolution treats an excluded path as missing. Filesystem-wide browsing opens it with `discovery: "none"` (no scan, no watch), where any local path stays addressable and only listings follow the policy; `"shallow"` scans one level without watching.
