# @ovst/object-store

Immutable, hash-sharded storage for protocol objects. Reads verify hashes.
Durable writes flush files and atomically link them into place; disposable
staging uses atomic publication without fsync. Reachability walks follow
directory graphs from a root. `holdsObject` and `absentFrom` check presence
without reading. overstoryd and the merge sidecar share one store
and stage generated objects separately; see [the merge tool](../../docs/architecture/overstoryd/merge-tool.md#objects-authority-and-failure).
The Swift twin is `OverstoryObjectStore`.

Objects may also be packed (overstoryd 001): records in immutable files under
`packs/`, indexed in `packs/index.sqlite3` (a member of a zstd frame of about
1 MiB holding one document's versions, or, for an object that large, zstd or
raw alone).
Reads, presence checks and freshening fall back to packs when there is no
loose file; writes are always loose. `ObjectStore.pack` moves loose objects
into a pack and removes their files only after reading every one back.
