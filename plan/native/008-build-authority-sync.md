# Plan 008: Build accepted updates and authority synchronization

> **Executor instructions**: Implement `updates-v1`, the sole automatic merge engine, retained linear accepted-update history, and a deterministic one-way schema upgrade against temporary/local authorities. Conflict state belongs entirely to clients; retain bounded private idempotency replay only for non-conflict outcomes. Do not deploy or touch the live Railway volume. Plan 011 owns backup, isolated-copy rehearsal, deployment, and operational rollback.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/wire/src/authority.ts packages/wire/src/host.ts packages/wire/src/client.ts packages/wire/src/objects.ts spec/wire.md spec/fixtures tests/integration tools package.json`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 007
- **Category**: architecture/correctness/migration
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Implementation status**: COMPLETE LOCALLY — `updates-v1`, accepted history, authority-owned merging, stateless conflicts, writer-only retained-object access, TypeScript client support, the executable shared merge corpus, transactional concurrency/idempotency races, and repeated legacy-fixture startup upgrade are implemented and verified. Plan 011 owns restored-volume, Hetzner, and Railway rollout evidence.
- **Verified at**: current working tree, 2026-08-24 (`bun test`, `bun run test:protocol`, `bun run typecheck`, `bun run build`, `git diff --check`)
- **Production status**: no Railway state was accessed or changed; Plan 011 remains gated on the live Hetzner exercise.

## Why this matters

One trusted authority can merge plaintext once and give TypeScript and Swift the same accepted result. This removes the proposed revision DAG and duplicate cross-language merge engines while preserving offline work, auditable accepted history, retry safety, and explicit client-owned conflicts.

## Current state

- `WireAuthority` stores current directory-root refs, linear accepted updates, and bounded successful-response replay records while retaining the existing `reflog` evidence.
- `POST .../updates` validates candidate graphs, serializes per-tree races, merges when needed, compare-and-swaps `trees.ref`, and records acceptance transactionally; `/push` is absent.
- Current public/read authorization reaches only the current graph. Current writers can retrieve non-current accepted graphs; rejected candidates and drafts are never retained.
- Opening an authority performs a deterministic, idempotent one-way startup upgrade. Production safety comes from Plan 011's volume backup, isolated restored-copy rehearsal, and old-image/volume rollback rather than a second migration implementation.

## Component contract

Implement the Plan 007 request/result state machine while retaining root refs:

- authenticate and validate request size/shape before graph work;
- deduplicate `(tree, credential subject, Idempotency-Key)` before mutation;
- rehash every supplied object and validate directory shape, names, boundaries, cycles, and limits;
- load base/local/remote graphs only through authorized retained roots or newly supplied objects;
- accept one-sided changes or run the authority-owned three-way merge;
- recheck current root in the same transaction as acceptance; retry merge a bounded number of times or return a structured current-ref result;
- atomically store the accepted update, bounded private idempotency result, and current ref;
- on conflict, return a complete client-persistable draft and structured alternatives without advancing the ref or retaining any authority-side conflict, candidate, or draft state.

Accepted updates include an opaque update ID, previous and accepted root, credential subject/device, and server time. A merged update additionally records base/candidate/remote and a versioned summary. These rows are not content objects. Watch event IDs use the update ID, not the root hash, so restoring a previously accepted root is observable as a new event.

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

Add explicit tables/indexes for accepted updates, bounded successful-outcome idempotency records, and accepted-root reachability as needed. Preserve the existing `trees.ref` meaning. `GET .../updates` exposes only paginated accepted history to writers. The existing object route exposes non-current accepted objects only to current writers. There are no attempt, conflict, draft, alternative, or historical-object resources.

Apply reasonable implementation/deployment safety bounds to requests, graphs, Markdown work, and private replay storage. Safety failures and conflicts retain nothing. Exact numeric caps are not part of `updates-v1` compatibility. Retain accepted history indefinitely in v1.

## Scope

**In scope**: authority schema/API, merge engine, accepted-root reachability, accepted-update and bounded idempotency metadata, TypeScript wire client types, deterministic one-way startup upgrade, local integration/fault tests.

**Out of scope**: arbord placement behavior, pairing UI, live Railway mutation, backup/restore orchestration, Swift/native client and UI, general CRDTs, revision objects.

## Steps

1. Implement the pure merge engine against every Plan 007 fixture. Add property tests for no omitted additions, graph validity, fixed-input determinism, replay idempotence, and base/local/remote identity cases.
2. Extend local authority storage with opaque update IDs, accepted-update metadata, bounded request idempotency, and authorization-safe accepted-root reachability. Preserve existing root refs and migrate reflog evidence; test `A → B → A` as three ordered updates.
3. Implement `updates-v1` discovery and `GET/POST .../updates` with authentication, `Idempotency-Key`, exact intent digest, object/graph validation, limits, one-sided cases, merge, bounded current-ref race handling, and transactional acceptance.
4. Extend the existing object authorization so writers can traverse retained accepted roots. Prove public/read subjects cannot retrieve non-current accepted bytes and nobody can retrieve rejected/draft bytes through server history.
5. Extend the TypeScript `WireClient` with strict accepted-update/result/conflict types and exact request reuse after ambiguous transport outcomes. Conflicts return as typed `409` values; do not add client merge behavior. Plan 013 independently implements the matching Foundation-only Swift wire package from shared fixtures.
6. Make authority startup upgrade legacy schema and reflog evidence deterministically and idempotently. It adds the required accepted-update/device records without changing any TreeID, current root, canonical path, access rule, existing credential validity, or public output. Exercise that exact startup path on legacy fixture data; do not build a separate dry-run/apply/rollback product.
7. Add restart, transaction-failure, concurrent-update, merge-timeout, request-replay, mutation-mismatch, client-persistable conflict, authorization, replay-expiry, and repeated one-way-upgrade integration tests.

## Verification

```sh
bun run test:sync-merge
bun test tests/integration/wire-host.test.ts tests/integration/community-hosting.test.ts
bun run typecheck
bun run test:protocol
git diff --check
```

Expected: all fixture additions survive in accepted/draft Markdown; fixed-input merge hashes repeat; ambiguous request replay returns the original result; migrated public Markdown/HTML and exact current refs match pre-migration; unauthorized non-current access fails.

## Done criteria

- [x] `updates-v1` handles current, accept, merge, conflict, replay, and race cases transactionally.
- [x] The authority is the only merge implementation.
- [x] Linear accepted updates survive restart without changing root-ref semantics; rejected conflicts never appear in them.
- [x] Markdown property/fixture tests detect any omitted local or remote addition.
- [x] Public/read-only users cannot retrieve non-current or rejected content.
- [x] Repeating the legacy startup upgrade is idempotent and preserves exact identities, refs, access, credentials, and public output; no Railway state was accessed.

## STOP conditions

- A merge result can omit an added Markdown line or silently choose one unsafe structural side.
- A current-ref race can commit a result computed against a stale remote root.
- Exact request replay can create a second history entry or different result.
- Rollback cannot restore byte-identical refs and current output.
- History authorization would make old/rejected objects readable to current public audiences.

## Maintenance note

Retain accepted updates indefinitely in v1. Never retain rejected candidates, conflict responses, or drafts. Any merge-policy change must remain fixture-compatible or advertise a new updates version; do not distribute server merge internals into clients.
