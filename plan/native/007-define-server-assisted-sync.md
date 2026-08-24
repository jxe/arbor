# Plan 007: Define server-assisted synchronization

> **Executor instructions**: Freeze the root-based sync, history, conflict, and merge contract before touching authority state or client networking. This is a specification-and-fixture milestone: do not implement the authority, deploy, add Swift, or introduce revision/DAG wire objects.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- spec/wire.md spec/client.md spec/system.md spec/fixtures packages/wire/src/authority.ts packages/wire/src/client.ts packages/arbord/src/service.ts tests package.json`; then `git -C /Users/joe/src/hunch diff --stat a1e8379..HEAD -- App/Sources/Clamshell/PatchEngine.swift App/Tests/HunchUnitTests/ConflictMergerTests.swift`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 006
- **Category**: architecture/protocol
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

The authority already stores immutable file/directory objects, a current directory-root ref, and a linear reflog. Because the trusted self-host can read content, clients do not need a revision DAG or independent merge implementations. They need one explicit, retry-safe request that names the last accepted base and the local candidate, while the authority needs a loss-averse merge contract and retained evidence for anything it cannot accept automatically.

## Current state

- `TreeDescriptor.ref`, `AuthorityTree.ref`, watch IDs, and historical locators already use immutable directory-root hashes.
- `WireAuthority.push` compare-and-swaps a root and appends `(tree_id, ref, previous_ref, changed_at)` to `reflog`.
- Arbord placement state already retains the last synchronized root and can distinguish local, base, and current remote roots.
- Current sync accepts a root when remote equals base, pulls when local equals base, and reports a whole-tree conflict when both changed.
- Wire object fixtures already freeze deterministic file/directory CBOR. They must remain the complete content-object vocabulary.
- Hunch `PatchEngine.mergeConflict` starts with the accepted survivor, salvages unseen alternate blocks, places them under their recorded live parent, climbs outward through recorded parent context when that parent is gone, and falls back to top level. `ConflictMergerTests` locks disjoint salvage, Mac/iPad union, parent-chain climb, live-parent placement, deduplication, and top-level fallback.
- Arbor adopts that preservation and approximate-placement idea, not its representation: there are no Clamshell block hashes, tombstone journals, or iCloud alternate files in the Arbor protocol.

## Target protocol

Discovery advertises mandatory `sync: "sync-v1"` for new native clients. Define JSON request/result shapes around unchanged CBOR objects:

```ts
type SyncRequest = {
  requestID: string;
  base: ObjectHash;
  local: ObjectHash;
  objects: EncodedObject[];
};

type SyncResult =
  | { status: "current"; root: ObjectHash; acceptance: string }
  | { status: "accepted"; root: ObjectHash; previous: ObjectHash; acceptance: string }
  | { status: "merged"; root: ObjectHash; previous: ObjectHash;
      acceptance: string; merge: MergeSummary }
  | { status: "conflict"; attempt: string; base: ObjectHash; local: ObjectHash;
      remote: ObjectHash; remoteAcceptance: string; draft: ObjectHash;
      conflicts: SyncConflict[] };
```

The server first requires `base` to be a retained accepted root for this tree, then interprets `remote` as the current accepted root at evaluation time:

1. `local == remote`: return current without a duplicate acceptance, even if base is older.
2. `local == base`: return the current remote root without mutation.
3. `remote == base`: validate and accept local with one compare-and-swap.
4. Both changed: merge `base`, `local`, and `remote`; accept the merged root only after a final ref recheck.
5. Unsafe overlap: retain the candidate and a writer-only draft containing every safe change; do not advance the accepted ref.

Idempotency is scoped to `(tree, authenticated credential subject, requestID)`. Reusing the ID with the same semantic intent—exact `base` and `local` roots—returns the stored result; different base/local intent returns `mutation-mismatch`. Object envelopes may be retransmitted only when every repeated hash has identical bytes. After Plan 010, the credential subject is a stable device. An authority that does not advertise `sync-v1` may be used only by explicitly legacy clients during migration; native Arbor must not silently downgrade.

## Markdown additive merge contract

The Markdown body rule is inspired by Hunch's auto-restore and conflict salvage, but operates on exact source lines rather than Hunch journal records or block hashes:

- Preserve unchanged byte slices and copy added source lines verbatim; do not parse and reserialize the whole document.
- Compute each side's additions relative to the common base. Every added line/run from either side must appear in the result.
- Place an added run between its nearest surviving unchanged predecessor and successor. If either direct anchor disappeared, walk outward through shared context; prefer the same paragraph/list/heading region, then the end of the document.
- When both sides add at the same slot without more context, keep already-accepted remote lines first and incoming local lines second. Server arrival order may affect sibling order; it must not affect inclusion.
- Collapse an exact duplicate addition only when the surrounding anchors establish that it is the same addition. Repeated identical lines in different positions are not duplicates.
- Treat a modified line/run as removed base text plus added replacement text. If both sides supply different replacements, retain both replacements near the old location. If one deletes and the other changes, retain the changed text.
- Honor a deletion only when the other side did not add or modify content in the deleted region. Ambiguity is resolved toward preservation.
- Preserve line endings on copied slices. When the merger must synthesize a separator, use the base document's dominant ending, then the remote document's, then LF.
- Prefer a nearby duplicate or end-of-region fallback over omitting content. The merge summary records approximate/fallback placements for audit and UI explanation.

Protected structures have narrower automatic behavior: distinct YAML frontmatter keys may merge, while different values for the same key conflict; changed fence delimiters or a result with unbalanced fences conflict; directory path/kind collisions, incompatible PageID moves, nested tree-boundary changes, and divergent binary/unknown files conflict. A conflict draft applies all independent safe changes and keeps the local candidate at each unresolved location while retaining the remote alternative in structured metadata. It never creates an authored `conflicted copy` file.

## Retention and authorization

The accepted history is a linear authority log containing an opaque acceptance ID, tree, previous root, accepted root, authenticated subject/device, server acceptance time, and optional merge inputs/summary. Content identity remains only the accepted directory root. A repeated root still creates a distinct acceptance entry; watch `Last-Event-ID` and history cursors therefore use acceptance IDs rather than root hashes. Retain accepted roots, unresolved local candidates, drafts, conflict alternatives, and their reachable objects indefinitely in v1.

Public/read access can resolve only the current graph. Enumerating history, retrieving non-current graphs, or fetching drafts/candidates requires effective write access. The server must impose documented object-count, graph-depth, path-count, byte, and merge-CPU limits before retaining untrusted candidates.

## Scope

**In scope**: normative protocol/state-machine text, Markdown/path merge rules, authorization/retention/idempotency rules, language-neutral request/result and merge fixtures, invalid cases, implementation handoff notes.

**Out of scope**: production code, schema migration, live Railway access, UI, Swift code, revision objects, general CRDT/DAG design.

## Steps

1. Update `spec/wire.md`, `spec/client.md`, and `spec/system.md` so refs remain directory roots and `sync-v1` owns automatic convergence, retained history, draft conflicts, exact retry, and authorization.
2. Specify all request/result fields, opaque acceptance/attempt identifiers, discovery negotiation, stable error codes, idempotency scope, limit failures, CAS recheck behavior, watch semantics, and history pagination. Restore-to-an-old-root must emit a new acceptance/watch event.
3. Add JSON fixtures for current, accept, merged, conflict/draft, replay, mutation mismatch, current-ref race, malformed/missing object, unauthorized history, and exceeded limits.
4. Add exact-source three-way merge fixtures before implementation. Cover additions on both sides; same-slot additions; nearest surviving anchors; missing-anchor outward walk; no-anchor fallback; exact duplicate additions; repeated identical lines; one-side deletion plus other-side addition/edit; different paragraph replacements; headings/nested lists; distinct/same frontmatter keys; code fences; raw HTML; CRLF/mixed endings; PageID moves; binaries; nested boundaries; and retry idempotence.
5. For each fixture, state whether the accepted root advances, which lines must survive, their allowable placement interval, the exact conflict reason if any, and what the draft contains. Do not over-specify sibling order where arrival order is intentionally observable.
6. Add a fixture/schema validation command that checks hashes, object reachability, expected inclusion/placement constraints, stable error vocabulary, and internal references without implementing merge behavior.

## Verification

```sh
bun run test:protocol
bun test tests/unit/wire.test.ts
bun run typecheck
git diff --check
```

Expected: every fixture is internally valid, existing deterministic object hashes remain unchanged, and no production authority/client/arbord implementation changes.

## Done criteria

- [ ] The wire still has only file and directory content objects; no revision/DAG object exists.
- [ ] Sync cases, CAS recheck, exact retry, retention, limits, and authorization are unambiguous.
- [ ] Every Markdown fixture requires all additions from both sides to survive near stable context.
- [ ] Conflict drafts retain every safe change and both unresolved alternatives without authored conflict copies.
- [ ] Plans 008, 009, 013, and 015 can implement/consume the contract without inventing behavior.

## STOP conditions

- A protocol outcome depends on mtime, unsynchronized clocks, or implicit device ordering.
- An automatic Markdown case permits an added line from either side to disappear.
- Retrying an ambiguous request could create a distinct mutation.
- Read-only/public authorization would expose non-current or rejected content.
- The design requires a client-side merge engine or a new content-addressed revision object.

## Maintenance note

The authority's merge implementation may evolve only behind a new advertised sync version or fixture-compatible behavior. Hunch informs the loss-averse placement policy; Arbor does not adopt Clamshell journals, atomic block hashes, or Hunch's storage model.
