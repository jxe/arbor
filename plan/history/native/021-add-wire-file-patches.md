# Plan 021: Send editor patches in immediate authority updates

> **Executor instructions**: Implement `file-patches-v1` using the just-verified patch from a completed ArborQuagmire admission when an authority update can be frozen immediately after local durability. Otherwise use the ordinary complete-object candidate. Also send sparse object envelopes and implement conditional returned snapshots. Preserve root-based semantic intent and authority-owned merging. Do not retain or compose editor-patch lineages solely to recover this optimization later.
>
> **Drift check**: `git diff --stat 01776d6..HEAD -- packages/core packages/fs packages/arbord packages/wire packages/authority native/Packages/ArborClient native/Packages/ArborKit native/Packages/ArborProviders native/Packages/ArborReplica native/Packages/ArborSync native/Packages/ArborWire native/Packages/ArborQuagmire spec tests plan/native`

## Status

- **Priority**: P1 — next synchronization work
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 015 and 016
- **Category**: protocol/performance
- **Planned at**: Arbor `01776d6`, 2026-08-24; reconciled around immediate editor-originated patches on 2026-08-25
- **Completed**: 2026-08-25 in `50fe817` through `6f05ca5`

## Why this matters

An immutable file object changes hash when any byte changes. Root/object deduplication avoids uploading unchanged files but still uploads an entire large Markdown file after a one-paragraph edit. ArborQuagmire already knows the exact ordered UTF-8 replacements made by that admission. Immediately after the provider has made the edit durable, Arbor can use those verified replacements to freeze a small authority request instead of rediscovering the same change from complete files.

The authority request still names the complete candidate root. “Send just the patch” means that `filePatches` replaces the changed file payload; the request also carries new directory objects on the path to that file and any other candidate objects not reachable from the retained base. The patch is a transport representation, never authored identity or a merge instruction.

## Required data flow

```text
Quagmire transaction
  -> WorkspaceDocumentPatch(baseContentRevision, UTF-8 edits)
  -> provider verifies and durably admits the exact resulting source
  -> provider maps this admission to base/result file-object hashes
  -> sync coordinator immediately freezes one sparse updates-v1 body
       eligible: candidate root + directory objects + filePatch
       otherwise: candidate root + sparse complete objects
  -> authority reconstructs and hashes the changed file object
  -> existing graph validation and authority merge
```

Quagmire and ArborQuagmire remain storage- and wire-neutral. The provider and sync coordinator perform the one-shot mapping after the local durability boundary. A crash or delay before the attempt is frozen loses only the patch optimization; the durable local candidate remains available for an ordinary full-object sync.

No Quagmire model change is required. Its immutable `BlockID`, semantic `DocumentChange` values, and synchronous `persistCommit` callback already give ArborQuagmire enough identity and timing; ArborQuagmire's private source ledger supplies the exact raw-source mapping. Do not add Arbor revisions, byte ranges, wire hashes, or generic metadata bags to `Block`. Revisit Quagmire only if implementation proves that a storage-neutral commit identifier is required by more than one host.

## Contract

### 1. Carry the just-admitted patch across the provider boundary

- Add optional guarded UTF-8 source edits to local `writeMarkdown` requests. Keep the complete resulting `source`; arbord applies the edits to the exact current source and requires their result to equal `source` before using them.
- Override `admit(patch:)` in both `ArbordDocumentSession` and `ReplicaDocumentSession`; do not let the protocol-extension default apply the patch and discard its origin before the provider sees it.
- Return or emit a one-shot confirmed-admission value containing the stable node identity, resulting local generation/root, base file-object hash, result file-object hash, and decoded-payload edits. `baseContentRevision` alone is not a wire object hash.
- Local durability is completed and acknowledged independently of authority availability. The immediate sync handoff happens afterward.
- Do not add a durable multi-generation patch-lineage store. Once the exact sync body is frozen, existing durable attempt storage owns retry. If no eligible body is frozen, later sync snapshots the latest candidate normally.

### 2. Use a patch only for an immediately eligible update

The immediate patch attempt is eligible only when:

- there is no unresolved/frozen sync attempt;
- the tree was current before this one local admission, so the patch's base file is reachable from the retained `base.root`;
- the candidate root/generation still exactly matches the confirmed admission;
- no provider adjustment, external edit, structural race, or other local mutation intervened;
- applying the patch to the decoded base payload produces the declared result file-object hash; and
- the encoded patch is smaller than the complete result object.

If any condition fails—including offline or delayed scheduling—freeze or later create the normal sparse full-object update. Do not compose several editor checkpoints or send a patch against an intermediate local file absent from the retained authority base.

### 3. Send sparse candidate envelopes

- Walk the retained `base.root` and candidate root together.
- Omit unchanged objects reachable from the retained base; the authority already retains them.
- Include changed directory objects and complete new, binary, or unpatchable file objects.
- For the one eligible Markdown result object, include its verified `filePatch` instead of its complete object.
- Persist the exact serialized request body before transmission. Ambiguous retries replay that frozen body even if newer editor generations arrive.

### 4. Implement `file-patches-v1`

- encode ordered, non-overlapping byte replacements over decoded file payloads;
- require the base file object to be reachable from the retained request base;
- reconstruct canonical file bytes, rehash them, and require the declared result hash;
- feed reconstructed objects into the existing graph validation/storage path;
- keep `filePatches` excluded from semantic request identity; and
- retain complete-object fallback for every ineligible case.

### 5. Return snapshots only when needed

Add the transport hint `returnSnapshot: "if-result-differs"`:

- if a successful/current response names the submitted candidate root, omit `snapshot`; the client validates that identity and advances its accepted base without downloading bytes it already has;
- if the returned accepted root differs from the candidate because the remote was current or the authority merged, return the complete accepted snapshot;
- on conflict, return the complete current accepted snapshot alongside the existing complete draft;
- preserve `returnSnapshot: true` for clients that always require a complete successful/current snapshot, and preserve omission for clients that request none.

The hint remains excluded from semantic request identity.

## Steps

1. Add shared positive and hostile fixtures for the one-shot handoff, eligibility/fallback, sparse envelopes, `if-result-differs` responses, CRLF, multibyte UTF-8 boundaries, insertion/deletion/replacement, fallback threshold, overlap, bounds, overflow, wrong base/result hashes, unreachable bases, and duplicate result objects.
2. Extend `writeMarkdown` across the REST spec, shared TypeScript protocol, Swift ArborClient model, native provider, and arbord validation so the exact source and optional verified editor edits cross the macOS local boundary together.
3. Add confirmed-admission handoffs from ArborReplica and arbord to their sync coordinators. Test that failure or process exit at every handoff point preserves the local candidate and merely causes full-object fallback.
4. Implement retained-base/candidate graph differencing so TypeScript and Swift clients freeze sparse exact attempt bodies.
5. Add TypeScript/Swift codecs and authority reconstruction with strict quotas, base-reachability checks, and canonical result-hash verification.
6. Trigger immediate nonblocking sync after an eligible local receipt. Preserve the scheduler's single frozen attempt and fall back rather than queueing/composing patch provenance.
7. Implement `returnSnapshot: "if-result-differs"` in shared wire types, both clients, the host, and native response application.
8. Add accounting tests showing a small paragraph edit in a multi-megabyte Markdown file uploads replacement bytes plus changed directory objects, does not upload the complete file, and does not download a snapshot when accepted unchanged. Prove offline and overlapping-edit cases use the complete-object path.
9. Run the lockstep alpha client, arbord, and authority against the disposable-authority harness using both eligible patch requests and ordinary full-object fallbacks.

## Verification

```sh
bun run typecheck
bun run test:protocol
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/ArborSync
swift test --package-path native/Packages/ArborQuagmire
git diff --check
```

Expected: an immediately eligible editor admission becomes a verified file-patch request; every delayed, offline, overlapping, or otherwise ineligible admission safely becomes a sparse complete-object request; both forms produce identical candidate/accepted roots and idempotency identity; an unchanged acceptance downloads no snapshot under `if-result-differs`.

## Done criteria

- [x] A just-confirmed Quagmire patch becomes the authority file patch on both macOS and iOS when all immediate-eligibility checks hold.
- [x] Losing or declining the optimization never loses local work and always retains complete-object fallback.
- [x] Patch and complete-object transports are semantically interchangeable.
- [x] Sparse requests omit unchanged base-reachable objects while remaining graph-valid at the authority.
- [x] Base reachability and all byte-range/hash invariants are enforced.
- [x] `if-result-differs` omits only snapshots the client can prove it already has.
- [x] Ambiguous retry and accepted history remain exactly-once.
- [x] No path mutation, patch lineage, or merge behavior enters the patch codec.
- [x] Quagmire's public block/document model remains storage-neutral and at exact `0.1.0`.

## STOP conditions

- Patch application can read an object outside the retained base graph.
- Result bytes can enter validation/storage without matching the declared object hash.
- A local save acknowledgment depends on authority availability.
- A patch is queued or composed after its immediate eligibility has been lost instead of using complete-object fallback.
- A patch is sent against an intermediate local file object not reachable from the retained accepted base.
- Request identity changes based on patch partitioning, sparse-envelope contents, snapshot hint, or transport choice.
- A client must understand authority merge placement to produce a patch.

## Maintenance note

Patch selection heuristics are replaceable. The immediate eligibility rule, byte-addressing, base reachability, canonical re-encoding, result-hash verification, complete-object fallback, frozen retry bodies, and exclusion from semantic request identity are compatibility behavior.
