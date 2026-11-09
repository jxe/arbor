# @ovst/object-store

Immutable, hash-sharded storage for protocol objects. Reads verify hashes.
Durable writes append to the store's journal (one write and one
`fdatasync` per call, then the pack index); disposable staging publishes
loose files atomically without fsync. Reachability walks follow
directory graphs from a root. `holdsObject` and `absentFrom` check presence
without reading. overstoryd and the merge sidecar share one store
and stage generated objects separately; see [the merge tool](../../docs/architecture/overstoryd/merge-tool.md#objects-authority-and-failure).
The Swift twin is `OverstoryObjectStore`.

Objects may also be packed (overstoryd 001): records in immutable files under
`packs/`, indexed in `packs/index.sqlite3` (a member of a zstd frame of about
1 MiB holding one document's versions, or, for an object that large, zstd or
raw alone).
Reads, presence checks and freshening fall back to packs when there is no
loose file. A journal (`packs/journal-<uuid>.pack`) is a pack durable writes
append raw records to; `Packs.recover` indexes records a lost commit left out.
`ObjectStore.pack` moves loose and journaled objects into a compressed pack
and removes loose files only after reading every one back.
