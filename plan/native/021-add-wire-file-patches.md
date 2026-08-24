# Plan 021: Add verified wire file patches

> **Executor instructions**: Implement the already-specified `file-patches-v1` transport extension after native synchronization and editor admission are stable. Preserve root-based semantic intent and authority-owned merging. Do not turn patches into path mutations, an alternate document API, or a client merge engine.
>
> **Drift check**: `git diff --stat 01776d6..HEAD -- packages/wire packages/authority native/Packages/ArborWire native/Packages/ArborReplica native/Packages/ArborSync native/Packages/ArborQuagmire spec tests plan/native`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 015 and 016
- **Category**: protocol/performance
- **Planned at**: Arbor `01776d6`, 2026-08-24

## Why this matters

An immutable file object changes hash when any byte changes. Root/object deduplication therefore avoids uploading unchanged files but still uploads an entire large Markdown file after a one-paragraph edit. `file-patches-v1` lets the authority reconstruct and verify that one changed object from a retained-base file plus small UTF-8 byte replacements, without changing the candidate root or moving merge logic into clients.

## Contract

Implement the normative extension in `spec/wire.md`:

- advertise `file-patches-v1` per resolved authority/tree capability;
- encode ordered, non-overlapping byte replacements over decoded file payloads;
- require the base file object to be reachable from the retained request base;
- reconstruct canonical file bytes, rehash them, and require the declared result hash;
- feed reconstructed objects into the existing graph validation/storage path;
- keep `filePatches` excluded from semantic request identity;
- prefer the smaller of a complete object and its verified patch representation;
- retain full-object fallback for new, binary, poorly patchable, or capability-mismatched files.

## Steps

1. Add shared positive and hostile fixtures: single paragraph, CRLF, multibyte UTF-8 boundaries, insertion/deletion/replacement, multiple edits, fallback threshold, overlap, bounds, overflow, wrong base/result hashes, unreachable base, and duplicate result objects.
2. Add TypeScript codecs and authority reconstruction with strict quotas and base-reachability validation.
3. Add independent Swift patch planning/encoding from ArborReplica snapshots and exact ArborQuagmire admissions. Do not make Quagmire or ArborKit understand wire envelopes.
4. Persist the chosen exact transport body in durable sync-attempt state so restart/retry behavior remains unchanged.
5. Add accounting tests showing a small paragraph edit in a multi-megabyte Markdown file uploads replacement bytes plus directory objects rather than the complete file.
6. Run disposable-authority compatibility with patch-capable and legacy/full-object clients in both directions.

## Verification

```sh
bun run typecheck
bun run test:protocol
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborSync
swift test --package-path native/Packages/ArborQuagmire
git diff --check
```

Expected: patched and full-object forms produce identical candidate/accepted roots and idempotency identity; every hostile envelope is rejected before state change; legacy clients remain compatible; measured upload excludes the complete large file payload.

## Done criteria

- [ ] Patch and complete-object transports are semantically interchangeable.
- [ ] Base reachability and all byte-range/hash invariants are enforced.
- [ ] Small large-file edits demonstrably avoid complete-file upload.
- [ ] Ambiguous retry and accepted history remain exactly-once.
- [ ] No path mutation or merge behavior enters the patch codec.

## STOP conditions

- Patch application can read an object outside the retained base graph.
- Result bytes can enter validation/storage without matching the declared object hash.
- Request identity changes based on patch partitioning or transport choice.
- A client must understand authority merge placement to produce a patch.

## Maintenance note

Patch selection heuristics and diff algorithms are replaceable. Byte-addressing, base reachability, canonical re-encoding, result-hash verification, full-object fallback, and exclusion from semantic request identity are compatibility behavior.
