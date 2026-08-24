# Plan 015: Synchronize native replicas through Arbor

> **Executor instructions**: Add synchronization around the already-safe local replica. Swift submits exact root-based intent and consumes the authority's merge/draft results; it must not port the TypeScript merge engine. Preserve further local work while offline, pending, or conflicted. Do not add Quagmire or broad product features.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native/Packages/ArborWire native/Packages/ArborReplica native/Packages/ArborKit packages/arbord spec/fixtures tests plan/native`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 009, 011, 013, and 014
- **Category**: synchronization/correctness
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Reconciled at**: Arbor `01776d6`, 2026-08-24
- **Completed**: 2026-08-24

## Reconciled protocol decision

- Plan 015 requests the optional complete returned accepted snapshot on `updates-v1`, validates it, and applies it without graph-fetch races or a historical-object endpoint.
- `file-patches-v1` is specified now but deferred to Plan 021. This plan continues uploading complete changed file objects and does not depend on patch capability.

## Why this matters

This milestone proves the replacement for iCloud: full offline local safety plus server-assisted convergence through the trusted Arbor authority. The native client should be simpler than the server. It durably records a base and local root, retries one exact request, validates the returned graph, and presents unresolved choices; local editing never waits for network success.

## Sync contract

Add `ReplicaSyncCoordinator` as an actor over ArborReplica and ArborWire:

- read the replica's last authority-accepted `base`/acceptance cursor and current durable `local` root;
- persist the exact `{ base, candidate }` semantic intent and required objects before upload;
- submit immutable file/directory objects through `updates-v1`;
- reuse the exact request after ambiguous transport outcomes;
- validate/re-hash the graph returned by `current`, `accepted`, or `merged`, materialize it durably, and only then advance the replica's accepted base and watch cursor;
- on `conflict`, validate and retain base/local/remote/draft roots plus structured reasons/alternatives, and present the draft without manufacturing conflict-copy files;
- continue admitting new local roots while a request or conflict is outstanding; never fold them silently into an already-sent request;
- resolve through an explicit local edit/choice and new sync request against the conflict response's remote root;
- coalesce redundant scheduling without dropping any acknowledged local generation.

Swift does not find ancestors or merge Markdown/trees. Plan 008's authority is the only implementation of the Hunch-informed additive rule. Native tests assert observable invariants from shared scenarios: every added line appears, returned placement satisfies the fixture's allowed context interval, unsafe alternatives remain retrievable, and exact retry does not duplicate history.

## App/account integration

- Add Keychain-backed device credential storage in the app layer.
- Scan the versioned pairing QR, show/confirm the short code, claim a distinct device credential, list/revoke devices, and forget local credentials explicitly.
- List account-visible trees and place/download one into private replica storage.
- Expose offline, locally pending, request pending, uploading, downloading, current, auto-merged, approximate-placement, conflict, authentication failure, and revoked states through ArborKit.
- Show automatic merge provenance compactly: accepted server root, local/remote additions, and any fallback placements. Do not expose raw credential/protocol internals in ordinary UI.
- Background/termination drains local admission only; safe close never waits for the network.

## Scope

**In scope**: Swift sync coordinator, protocol scenario consumer, returned-graph validation, credential/pairing app services, minimal sync/conflict/account UI, isolated local/live test trees.

**Out of scope**: Swift merge engine, Quagmire/editor, broad browser actions, Hunch feature parity/conversion, public sharing/access editor, production content tree.

## Steps

1. Implement durable sync-attempt state around ArborReplica's base/local roots. Inject crashes before request persistence, during upload, after server acceptance, during graph download, during materialization, and before base advancement.
2. Implement idempotent `updates-v1` submission using the authority-derived canonical-JSON request digest. Bound retries and preserve the semantic intent and required objects across restart; never change base or candidate merely because the outcome is ambiguous.
3. Decode current/accepted/merged/conflict results through ArborWire, fetch missing accepted-result objects, validate the complete draft snapshot carried by a conflict response, rehash every byte, validate graph shape/boundaries, and reject malformed alternatives before local application.
4. Integrate accepted/merged roots into the replica without changing its local acknowledgement boundary. If local edits were admitted after the sent candidate, preserve them as the next candidate rather than overwriting them with the result.
5. Implement conflict state and explicit resolution plumbing. Apply the server draft as a comparison/editing basis while retaining the current local root and remote alternatives; permit continued local work and submit resolution as a new normal candidate.
6. Consume shared protocol/merge scenarios as black-box authority tests. Cover one-sided sync, union of Mac/iPad Markdown additions, same-slot additions, outward-anchor fallback, no-anchor fallback, duplicate-looking lines, deletion/edit ambiguity, frontmatter conflict, binary/path conflict, approximate placement, exact replay, and current-ref race. Assert inclusion and allowed placement, not a client-generated merge hash.
7. Add pairing/Keychain/account-visible-tree services and minimal native state/provenance presentation.
8. Build a three-peer harness: two Swift replicas and one arbord placement against a temporary authority. After local gates pass, use only an isolated private Railway test tree; do not touch the future Hunch destination.

## Verification

```sh
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborReplica
bun run test:sync-merge
bun run test:protocol
git diff --check
```

Also run sequential app tests/builds. Expected: all peers converge on the authority's accepted root for automatic cases; every added Markdown line survives near allowed context; unsafe cases preserve the draft and both alternatives; force-quit after a final offline edit recovers locally; revoked credentials stop remote access without harming local content.

Completed evidence: `ArborSync` passed seven tests covering private placement, one-sided synchronization, newer local-tail preservation, durable conflict choice, every request/upload/download/base-advance fault boundary, pre/post merged-graph materialization recovery, and two live Swift replicas converging through a disposable authority. The unified protocol gate exercised the optional complete returned snapshot, pairing/confirmation/revocation, exact retry, conflicts, and the live peer merge; the existing arbord self-sync and shared merge-fixture gates remained green. The app can scan or paste the versioned pairing payload, stores a distinct ThisDeviceOnly Keychain credential, lists/revokes/forgets devices, lists writable account trees, places one into private replica storage, mounts its provider, and triggers sync without making local admission wait for the network. Sequential macOS tests and an iOS 27 simulator build-for-testing passed.

## Done criteria

- [x] Swift contains no Markdown/tree merge implementation and consumes every `updates-v1` outcome.
- [x] Local safety is unchanged when the authority is unavailable.
- [x] Exact ambiguous successful replay produces one accepted update and no duplicate history row.
- [x] Pairing produces a distinct revocable Keychain credential.
- [x] Arbord and two Swift replica qualifications converge through the disposable authority and shared merge contract.
- [x] Conflict/pending state permits further local roots and explicit resolution.

## STOP conditions

- Swift must reproduce a server merge decision to continue.
- Safe app close depends on network success.
- An ambiguous request is retried with a new ID or different intent.
- Applying a server result can overwrite acknowledged edits made after the submitted root.
- A returned merge can omit an added line or a conflict path cannot retrieve both alternatives.

## Maintenance note

Network scheduling, UI wording, and download batching are replaceable. Durable request intent, returned-graph validation, continued local admission, and the server/client ownership boundary are compatibility behavior.
