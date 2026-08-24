# Plan 008: Build authority synchronization and retained history

> **Executor instructions**: Implement `sync-v1`, the sole automatic merge engine, retained linear history, and writer-only conflict drafts against temporary/local authorities. Do not deploy or touch the live Railway volume. Migration must be explicit, dry-runnable, reversible, and content-preserving.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/wire/src/authority.ts packages/wire/src/host.ts packages/wire/src/client.ts packages/wire/src/objects.ts spec/wire.md spec/fixtures tests/integration tools package.json`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 007
- **Category**: architecture/correctness/migration
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

One trusted authority can merge plaintext once, retain every candidate, and give TypeScript and Swift the same result. This removes the proposed revision DAG and duplicate cross-language merge engines while preserving offline work, auditable history, retry safety, and explicit conflicts.

## Current state

- `WireAuthority` already stores current directory-root refs and a linear `reflog` with previous/current roots.
- `push` already validates supplied object graphs, compare-and-swaps the expected root, updates `trees.ref`, and appends history.
- Current reachability authorization is based on the current tree graph; rejected/non-current content has no first-class writer-only route.
- Opening an authority performs older schema reconciliation automatically, but this milestone must not silently migrate real sync/history state.

## Component contract

Implement the Plan 007 request/result state machine while retaining root refs:

- authenticate and validate request size/shape before graph work;
- deduplicate `(tree, credential subject, requestID)` before mutation;
- rehash every supplied object and validate directory shape, names, boundaries, cycles, and limits;
- load base/local/remote graphs only through authorized retained roots or newly supplied objects;
- accept one-sided changes or run the authority-owned three-way merge;
- recheck current root in the same transaction as acceptance; retry merge a bounded number of times or return a structured current-ref result;
- atomically store the result, linear history/audit row, idempotency result, and current ref;
- on conflict, retain candidate/draft/alternatives and return their stable identifiers without advancing the ref.

History records include an opaque acceptance ID, previous and accepted root, credential subject/device, and server time. Merge acceptance additionally records base/local/remote and a versioned summary. These rows are not content objects. Watch event IDs use the acceptance ID, not the root hash, so restoring a previously accepted root is observable as a new event.

## Merge engine

Create one reusable server package/module that implements the Plan 007 fixtures:

- recursively merge directories and correlate PageID-preserving renames/moves;
- apply disjoint changes directly while respecting independently versioned nested `TreeID` boundaries;
- merge Markdown frontmatter with protected-key conflict rules;
- merge Markdown bodies as exact line runs, using nearest surviving before/after anchors and outward fallback;
- keep accepted remote additions before incoming local additions when both occupy one unresolved slot;
- prefer preservation/possible duplication over omission and annotate approximate placements;
- reject invalid fence structure instead of emitting malformed Markdown;
- return structured conflicts for unsafe path/kind/move/frontmatter/binary/boundary cases;
- build a draft root containing all safe changes and local-at-conflict content, with remote alternatives retained outside authored content.

The merger must be deterministic for a fixed `(base, local, remote, mergeVersion)` input and idempotent under exact request replay. It does not need to produce the same sibling order when two devices arrive in the opposite order; the authority's accepted sequence is legitimate history.

## Storage and authorization

Add explicit tables/indexes for accepted history metadata, idempotency records, retained sync attempts, conflict records, and root reachability/retention as needed. Preserve the existing `trees.ref` meaning. Writer-only routes expose paginated accepted history, attempt details, draft graphs, and conflict alternatives. Public/read subjects can fetch only the current graph.

Bound request objects, encoded bytes, graph nodes/depth, Markdown bytes/lines, path operations, retained attempts per tree/device, and wall/CPU work. Limit failures must retain nothing unless the exact request was already committed. Retain accepted history and unresolved candidates indefinitely in v1; garbage collection is a later explicit design.

## Scope

**In scope**: authority schema/API, merge engine, current/history/draft reachability, audit/idempotency metadata, TypeScript wire client types, explicit migration/rollback tool, local integration/fault tests.

**Out of scope**: arbord placement behavior, pairing UI, live Railway mutation, Swift/native UI, general CRDTs, revision objects.

## Steps

1. Implement the pure merge engine against every Plan 007 fixture. Add property tests for no omitted additions, graph validity, fixed-input determinism, replay idempotence, and base/local/remote identity cases.
2. Extend local authority storage with opaque acceptance IDs, accepted-history metadata, request idempotency, retained attempts/drafts/conflicts, and authorization-safe root reachability. Preserve existing root refs and migrate reflog evidence; test `A → B → A` as three ordered acceptances.
3. Implement `sync-v1` discovery and endpoint handling with authentication, exact intent digest, object/graph validation, limits, one-sided cases, merge, bounded current-ref race handling, and transactional acceptance.
4. Implement writer-only history/attempt/draft/object access. Prove a public/read subject cannot retrieve deleted, rejected, draft, or alternative bytes even if it knows their hashes.
5. Extend the TypeScript `WireClient` with strict sync/result/history/conflict APIs and exact request reuse after ambiguous transport outcomes. Do not add client merge behavior.
6. Build an explicit migration tool with `--dry-run`, `--apply`, and rollback-manifest modes. It validates every legacy current root, adds required history/schema records without changing the root, and restores byte-identical refs/output on rollback. Authority startup must not silently run it.
7. Add restart, transaction-failure, concurrent-sync, merge-timeout, request-replay, mutation-mismatch, retained-conflict, authorization, migration, and rollback integration tests.

## Verification

```sh
bun run test:sync-merge
bun run test:authority-migration
bun test tests/integration/wire-host.test.ts tests/integration/community-hosting.test.ts
bun run typecheck
bun run test:protocol
git diff --check
```

Expected: all fixture additions survive in accepted/draft Markdown; fixed-input merge hashes repeat; ambiguous request replay returns the original result; migrated public Markdown/HTML and exact current refs match pre-migration; unauthorized non-current access fails.

## Done criteria

- [ ] `sync-v1` handles current, accept, merge, conflict, replay, race, and limit cases transactionally.
- [ ] The authority is the only merge implementation.
- [ ] Linear accepted history and retained conflicts survive restart without changing root-ref semantics.
- [ ] Markdown property/fixture tests detect any omitted local or remote addition.
- [ ] Public/read-only users cannot retrieve non-current or rejected content.
- [ ] Dry-run makes no writes; apply and rollback are deterministic; no Railway state was accessed.

## STOP conditions

- A merge result can omit an added Markdown line or silently choose one unsafe structural side.
- A current-ref race can commit a result computed against a stale remote root.
- Exact request replay can create a second history entry or different result.
- Rollback cannot restore byte-identical refs and current output.
- History authorization would make old/rejected objects readable to current public audiences.

## Maintenance note

Retain history and unresolved candidates indefinitely in v1. Any merge-policy change must remain fixture-compatible or advertise a new sync version; do not distribute server merge internals into clients.
