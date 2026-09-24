# @overstory/object-store

Immutable, hash-sharded storage for protocol objects. Reads verify hashes.
Durable writes flush files and atomically link them into place; disposable
staging uses atomic publication without fsync. Reachability walks follow
directory graphs from a root. `holdsObject` and `absentFrom` check presence
without reading. canopyd and the merge sidecar share one store
and stage generated objects separately; see [the merge tool](../../docs/architecture/canopyd/merge-tool.md#objects-authority-and-failure).
The Swift twin is `OverstoryObjectStore`.
