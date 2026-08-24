# Plan 014: Build the offline Swift replica

> **Executor instructions**: Prove local data safety and complete provider behavior with networking disabled. Do not import ArborWire, contact an authority, add Quagmire, or expose the replica as an editable Files folder.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native/Packages/ArborKit native/Packages/ArborReplica spec/format.md spec/client.md spec/system.md spec/fixtures packages/fs packages/arbord tests`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 007 and 012
- **Category**: storage/correctness
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

Offline safety must not depend on successful synchronization. The replica needs the same logical-node, exact-source, directory-document, identity, recovery, and structural semantics as arbord while storing private journals, local history, and indexes outside authored trees.

## Storage boundary

Create `ArborReplica` without SwiftUI or networking. Separate:

- app-private materialized trees;
- immutable wire objects plus local materialized/pending/last-accepted root heads and an optional accepted-event cursor;
- PageID-keyed log-before-materialization recovery journals;
- rebuildable search/backlink indexes and caches;
- safe preferences/control records.

No iCloud/CloudKit entitlement or live Files-app folder is allowed. Journals, local history metadata, device identity, indexes, and caches never enter authored wire objects.

## Provider behavior

- Exact Markdown source plus `baseContentRevision`; parse internally and return exact accepted source.
- Provider-owned complete directory Markdown with canonical unmatched-child order and no read-time materialization.
- Revision guard covers stored source plus immediate child descriptors.
- PageID-preserving create/rename/move/copy/Trash/restore and collision refusal.
- Asset import with immutable unique names, readiness, hashing, and traversal rejection.
- Children, search, backlinks, ordinary files, collections, diagnostics, local history, and Recover through ArborKit.
- Each acknowledged mutation has durable intent, materialization, immutable objects, and a new local root/history entry. History restore creates an ordinary new local mutation/root; it does not rewind a ref or create DAG ancestry.

## Scope

**In scope**: Foundation package, local file/object/journal/index stores, ReplicaWorkspaceProvider, shared fixtures, fault-injection tests.

**Out of scope**: network sync/merge, pairing, app UI, Quagmire, voice, Hunch conversion, macOS arbitrary-folder provider.

## Steps

1. Freeze private directory ownership and transaction sequence. Use atomic replacement and explicit fsync/durable admission appropriate to each platform.
2. Implement immutable file/directory object storage using the existing wire bytes plus private linear local-history records. Keep separate current materialized root, pending local root, and last authority-accepted base; do not add a wire revision object.
3. Implement PageID-keyed recovery journal and replay for crash points before/after materialization and local-root update. Compact only after equivalent durable object graph and local-history coverage.
4. Implement logical node resolution and complete directory documents from shared language-neutral fixtures.
5. Implement structural operations, Trash/restore, assets, history/recovery, search/backlinks, and rebuildable indexes.
6. Implement ArborKit provider/session behavior, synchronous generation admission, ordered writes, flush, external/system replacement boundary, and terminal close.
7. Add property/idempotence and restart/failure tests; no correctness sleep.

## Verification

```sh
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/ArborKit
bun run test:protocol
git diff --check
```

Expected: shared node/directory/PageID fixtures agree with TypeScript; injected crashes at journal/materialization/object/ref/move/Trash stages recover without losing acknowledged intent; indexes can be deleted/rebuilt.

## Done criteria

- [ ] Full replica browsing/editing works with networking disabled.
- [ ] Every acknowledgement is crash-recoverable.
- [ ] Moves retain PageID and recovery identity.
- [ ] Private state is absent from authored wire snapshots.
- [ ] No iCloud/CloudKit/Files coauthoring path exists.

## STOP conditions

- A mutation can acknowledge before local root/object/history durability.
- Page moves require relocating history keyed by mutable path.
- Swift cannot reproduce complete directory behavior from shared fixtures.
- A private database/journal appears in a snapshot.

## Maintenance note

Plan 015 may add networking only around this completed local contract. It must not weaken acknowledgement or make offline close depend on the authority.
