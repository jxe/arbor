# Plan 007: Define server-assisted synchronization

> **Executor instructions**: Freeze the root-based accepted-update and merge contract before touching authority state or client networking. This is a specification-and-fixture milestone: do not implement the authority, deploy, add Swift, or introduce revision/DAG wire objects.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- spec/wire.md spec/client.md spec/system.md spec/fixtures packages/wire/src packages/authority/src packages/arbord/src/service.ts tests package.json`; then `git -C /Users/joe/src/hunch diff --stat a1e8379..HEAD -- App/Sources/Clamshell/PatchEngine.swift App/Tests/HunchUnitTests/ConflictMergerTests.swift`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 006
- **Category**: architecture/protocol
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Implementation status**: COMPLETE — the accepted-update contract is reflected in the spec and current TypeScript/Swift implementations, and the shared executable merge corpus covers additive Markdown, duplicate/replacement behavior, anchor fallback, frontmatter, fences, raw HTML, CRLF/mixed endings, PageID moves, binaries, nested boundaries, path-kind collisions, and exact replay semantics.
- **Verified at**: current working tree, 2026-08-24 (`bun run test:protocol`, `bun run test:sync-merge`, `bun run test`, `bun run typecheck`, `bun run build`, `git diff --check`)
- **Completion evidence**: `spec/fixtures/wire-update-intent.json` freezes canonical JSON/digest behavior across protocol clients, while `spec/fixtures/wire-merge.json` is exercised by the authority merger; both are validated by TypeScript and decoded by the Foundation-only Swift fixture tests.

## Why this matters

The authority already stores immutable file/directory objects, a current directory-root ref, and a linear reflog. Because the trusted self-host can read content, clients do not need a revision DAG or independent merge implementations. They need one explicit, retry-safe update submission that names the exact accepted base event and candidate root, while the authority needs a loss-averse merge contract. Accepted updates are server history; rejected candidates and conflict drafts remain client state.

## Current state

- `TreeDescriptor.ref`, `AuthorityTree.ref`, watch IDs, and historical locators already use immutable directory-root hashes.
- The authority accepts root updates through `POST .../updates`, records a private linear accepted-update sequence, and exposes neither `/push` nor accepted-history reads.
- Arbord placement state retains the last accepted update/root, exact pending request, local candidate, and complete client-owned conflict draft.
- Current sync returns current, accepts, merges, or reports a structured client-owned conflict according to the state machine below.
- Wire object fixtures freeze deterministic file/directory CBOR as the complete content-object vocabulary, while `wire-merge.json` freezes merge behavior without adding wire objects.
- Hunch `PatchEngine.mergeConflict` starts with the accepted survivor, salvages unseen alternate blocks, places them under their recorded live parent, climbs outward through recorded parent context when that parent is gone, and falls back to top level. `ConflictMergerTests` locks disjoint salvage, Mac/iPad union, parent-chain climb, live-parent placement, deduplication, and top-level fallback.
- Arbor adopts that preservation and approximate-placement idea, not its representation: there are no Clamshell block hashes, tombstone journals, or iCloud alternate files in the Arbor protocol.

## Target protocol

Discovery advertises mandatory `updates: "updates-v1"` for new native clients. Define JSON request/result shapes around unchanged CBOR objects. Request identity is derived from the semantic JSON rather than supplied as a header or second public resource:

```ts
type UpdateRequest = {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: EncodedObject[];
};

type AcceptedUpdate = {
  id: string;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
};

type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate }
  | { outcome: "accepted"; update: AcceptedUpdate }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary };

type ConflictError = {
  error: "conflict";
  message: string;
  retryable: false;
  current: AcceptedUpdate;
  base: ObjectHash;
  candidate: ObjectHash;
  draft: { root: ObjectHash; objects: EncodedObject[] };
  conflicts: UpdateConflict[];
};
```

The server requires `base.update` to identify a retained accepted update for this tree whose root is exactly `base.root`, then interprets `remote` as the current accepted root at evaluation time:

1. `candidate == remote`: return current without a duplicate accepted update, even if base is older.
2. `candidate == base.root`: return the current remote update without mutation.
3. `remote == base.root`: validate and accept candidate with one compare-and-swap.
4. Both changed: merge `base.root`, `candidate`, and `remote`; accept the merged root only after a final ref recheck.
5. Unsafe overlap: return `409 conflict` with a complete client-persistable draft containing every safe change; do not advance the accepted ref or create accepted history.

The authority constructs `{ base, candidate, tree, version: "updates-v1" }`, serializes that all-string I-JSON value with RFC 8785 canonical JSON rules, and hashes the exact UTF-8 bytes with SHA-256. Idempotency is scoped to `(tree, authenticated credential subject, derived digest)`. Accepted and merged outcomes store the digest directly on their accepted-update row and replay from that row; `current` and `409 conflict` remain stateless and safely recompute against the then-current accepted update. Object envelopes are excluded from identity because ordering and retransmission are transport details, but every supplied hash/byte pair is still verified. After Plan 010, the credential subject is a stable device. `/push` is removed from all servers and clients; there is no protocol downgrade.

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

Protected structures have narrower automatic behavior: distinct YAML frontmatter keys may merge, while different values for the same key conflict; changed fence delimiters or a result with unbalanced fences conflict; directory path/kind collisions, incompatible PageID moves, nested tree-boundary changes, and divergent binary/unknown files conflict. A conflict response applies all independent safe changes to a draft, includes a complete reachable draft snapshot, identifies the relevant paths/reasons, and names the base/candidate/current roots needed to inspect both alternatives. The client persists it outside authored content. The authority retains none of it, and neither side creates an authored `conflicted copy` file.

## Retention and authorization

The private accepted-update log contains an opaque update ID, tree, previous root, accepted root, authenticated subject/device, server acceptance time, and optional merge inputs/summary. Content identity remains only the accepted directory root. A repeated root still creates a distinct accepted update; watch `Last-Event-ID` therefore uses update IDs rather than root hashes. Retain every accepted root and its reachable objects indefinitely in v1, without exposing the log or old graphs as wire resources.

Every wire subject, including a writer, can resolve only currently readable graphs. Accepted updates remain private authority state: there is no accepted-history collection and no route for retrieving non-current accepted graphs. Rejected candidates and drafts are returned only in the immediate conflict response and never expand object authorization. The server must impose reasonable safety bounds before processing untrusted candidates, but exact numeric caps are implementation and deployment policy rather than a portable protocol-conformance surface.

## Scope

**In scope**: normative `POST .../updates` protocol/state-machine text, Markdown/path merge rules, private accepted history, derived request identity, client-owned conflicts, language-neutral request/result and merge fixtures, invalid cases, implementation handoff notes.

**Out of scope**: production code, schema migration, live Railway access, UI, Swift code, revision objects, general CRDT/DAG design.

## Steps

1. Update `spec/wire.md`, `spec/client.md`, and `spec/system.md` so refs remain directory roots and accepted updates own automatic convergence, linear history, exact retry, client-owned draft conflicts, and authorization.
2. Specify `POST .../updates`, request/result fields, opaque accepted-update identifiers, canonical-JSON request identity, discovery negotiation, stable errors/statuses, accepted-row replay, CAS recheck behavior, and watch semantics. Restore-to-an-old-root must emit a new accepted update/watch event.
3. Add JSON fixtures for current, accepted, merged, `409` conflict/draft, derived identity/replay, current-ref race, malformed/missing object, and absence of accepted-history/historical-object routes.
4. Add exact-source three-way merge fixtures before implementation. Cover additions on both sides; same-slot additions; nearest surviving anchors; missing-anchor outward walk; no-anchor fallback; exact duplicate additions; repeated identical lines; one-side deletion plus other-side addition/edit; different paragraph replacements; headings/nested lists; distinct/same frontmatter keys; code fences; raw HTML; CRLF/mixed endings; PageID moves; binaries; nested boundaries; and retry idempotence.
5. For each fixture, state whether the accepted root advances, which lines must survive, their allowable placement interval, the exact conflict reason if any, and what the draft contains. Do not over-specify sibling order where arrival order is intentionally observable.
6. Add a fixture/schema validation command that checks hashes, object reachability, expected inclusion/placement constraints, stable error vocabulary, and internal references without implementing merge behavior.

### Completed fixture stage

The executable corpus includes missing-anchor outward walks, no-anchor fallback, mixed line endings, compatible and incompatible PageID-preserving moves/renames, and explicit exact-replay vectors. Each Markdown vector runs through the generic no-added-line-omitted assertion as well as its case-specific placement/conflict expectations. The corpus passes in `bun run test:sync-merge` and decodes from the shared fixture in Swift.

## Verification

```sh
bun run test:protocol
bun test tests/unit/wire.test.ts
bun run typecheck
git diff --check
```

Expected: every fixture is internally valid, existing deterministic object hashes remain unchanged, and no production authority/client/arbord implementation changes.

## Done criteria

- [x] The wire still has only file and directory content objects; no revision/DAG object exists.
- [x] Update cases, CAS recheck, exact retry, retention, safety failures, and authorization are unambiguous.
- [x] Every Markdown fixture requires all additions from both sides to survive near stable context.
- [x] The fixture corpus covers anchor-fallback, PageID move/rename, mixed-ending, and explicit replay cases.
- [x] Conflict responses let the client persist every safe change and both unresolved alternatives without a server conflict-history resource or authored conflict copies.
- [x] Plans 008, 009, 013, and 015 can implement/consume the contract without inventing behavior.

## STOP conditions

- A protocol outcome depends on mtime, unsynchronized clocks, or implicit device ordering.
- An automatic Markdown case permits an added line from either side to disappear.
- Retrying an ambiguous request could create a distinct mutation.
- Read-only/public authorization would expose non-current or rejected content.
- The design requires a client-side merge engine or a new content-addressed revision object.

## Maintenance note

The authority's merge implementation may evolve only behind a new advertised updates version or fixture-compatible behavior. Hunch informs the loss-averse placement policy; Arbor does not adopt Clamshell journals, atomic block hashes, or Hunch's storage model.
