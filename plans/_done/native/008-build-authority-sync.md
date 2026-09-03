# Plan 008: Build accepted updates and authority synchronization

> **Executor instructions**: Implement `updates-v1`, the sole automatic merge engine, private linear accepted-update history, and a deterministic one-way schema upgrade against temporary/local authorities. Conflict state belongs entirely to clients; derive request identity from canonical semantic JSON and attach successful replay evidence directly to accepted rows. Do not deploy or touch the live Railway volume. Plan 011 owns backup, isolated-copy rehearsal, deployment, and operational rollback.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/authority/src packages/wire/src/updates packages/wire/src/client.ts packages/wire/src/objects.ts spec/04-wire.md conformance tests/integration/authority tests/unit/authority tools package.json`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 007
- **Category**: architecture/correctness/migration
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Implementation status**: COMPLETE — `updates-v1`, private accepted history, canonical-JSON request identity, accepted-row replay, authority-owned merging, stateless conflicts, current-graph-only object access, TypeScript client support, the executable shared merge corpus, transactional concurrency races, and current-schema validation are implemented and verified. The temporary legacy upgrade path was exercised by Plan 011 and then removed from the maintained runtime.
- **Verified at**: Arbor `875f52b`, 2026-08-24 (`bun run test:sync-merge`, `bun run test`, `bun run test:protocol`, `bun run test:e2e`, `bun run typecheck`, `bun run build`, `git diff --check`, two four-host Hetzner suites, isolated restored-volume migration/restart, and exact Railway migration/clean-runtime restart verification)
- **Production status**: live on Railway. The migration release preserved exact production roots, identities, access, public output, and objects; the clean runtime at `875f52b` restarted successfully with the migration compatibility paths absent.

## Why this matters

One trusted authority can merge plaintext once and give TypeScript and Swift the same accepted result. This removes the proposed revision DAG and duplicate cross-language merge engines while preserving offline work, auditable accepted history, retry safety, and explicit client-owned conflicts.

## Current state

- `WireAuthority` stores current directory-root refs and private linear accepted updates while retaining the existing `reflog` evidence. State-changing request digests live on the accepted rows; there is no replay table.
- `POST .../updates` validates candidate graphs, serializes per-tree races, merges when needed, compare-and-swaps `trees.ref`, and records acceptance transactionally; `/push` is absent.
- All wire object authorization reaches only currently readable graphs, including for writers. Accepted history is not exposed as a collection; rejected candidates and drafts are never retained.
- A new authority creates the current schema transactionally. Opening an existing authority asserts the exact current tables, columns, indexes, foreign keys, and required accepted-update/device invariants; an old schema fails with a one-time-migration instruction and is not modified. The production-only one-way upgrade was deliberately confined to the deployed migration release retained in Git history.

## Component contract

Implement the Plan 007 request/result state machine while retaining root refs:

- authenticate and validate request size/shape before graph work;
- derive the RFC 8785 canonical semantic-request digest and deduplicate `(tree, credential subject, digest)` before mutation;
- rehash every supplied object and validate directory shape, names, boundaries, cycles, and limits;
- load base/local/remote graphs only through authorized retained roots or newly supplied objects;
- accept one-sided changes or run the authority-owned three-way merge;
- recheck current root in the same transaction as acceptance; retry merge a bounded number of times or return a structured current-ref result;
- atomically store the accepted update, its request digest, and the current ref;
- on conflict, return a complete client-persistable draft and structured alternatives without advancing the ref or retaining any authority-side conflict, candidate, or draft state.

Accepted updates include an opaque update ID, previous and accepted root, credential subject/device, and server time. A merged update additionally records base/candidate/remote and a versioned summary. These rows are not content objects. Watch event IDs use the update ID, not the root hash, so restoring a previously accepted root is observable as a new event.

## Reliability-oriented module boundaries

Keep one runtime process, but make each behavioral state space independently understandable and directly testable. `@arbor/wire` owns only shared objects, update types, strict JSON/base64 transport, canonical semantic identity, and the TypeScript client. Server-only behavior lives in `@arbor/authority`:

- `updates/decision.ts` exhaustively chooses current, accept, or merge from three identities;
- `updates/reconcile.ts` invokes merging only for genuine three-way divergence;
- `updates/merge.ts` owns deterministic graph and Markdown behavior;
- `updates/store.ts` owns private accepted history, current-schema creation, digest replay lookup, and the atomic ref/reflog/accepted-row commit;
- `authority.ts` coordinates validation, immutable-object durability, and bounded races;
- `host.ts` adapts HTTP/authentication to typed calls without implementing update policy.

Package and test layout enforce the dependency direction: `@arbor/authority` depends on `@arbor/wire`, never the reverse. Unit tests mirror transport, intent, decision, merge, and store boundaries; integration tests cover only their composition.

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

Store accepted updates and optional state-changing request digests together; enforce uniqueness for `(tree, subject, request digest)`. Preserve the existing `trees.ref` meaning. Accepted history remains internal operational state and is not a wire collection. The object route authorizes only objects reachable from currently readable roots. There are no replay, attempt, conflict, draft, alternative, accepted-history, or historical-object resources.

Apply reasonable implementation/deployment safety bounds to requests, graphs, and Markdown work. Safety failures and conflicts retain nothing. Exact numeric caps are not part of `updates-v1` compatibility. Retain every accepted root and its reachable objects indefinitely in v1.

## Scope

**In scope**: authority schema/API, merge engine, current-root reachability, private accepted-update/request-digest metadata, TypeScript wire client types, a temporary deterministic one-way upgrade for Plan 011, current-schema validation, and local integration/fault tests.

**Out of scope**: arbord placement behavior, pairing UI, live Railway mutation, backup/restore orchestration, Swift/native client and UI, general CRDTs, revision objects.

## Steps

1. Implement the pure merge engine against every Plan 007 fixture. Add property tests for no omitted additions, graph validity, fixed-input determinism, replay idempotence, and base/local/remote identity cases.
2. Extend local authority storage with opaque update IDs and accepted-update metadata, including the derived digest for state-changing requests. Preserve existing root refs and migrate reflog evidence; test `A → B → A` as three ordered updates.
3. Implement `updates-v1` discovery and `POST .../updates` with authentication, RFC 8785 semantic-intent hashing, object/graph validation, limits, one-sided cases, merge, bounded current-ref race handling, and transactional acceptance.
4. Keep accepted history and old accepted graphs off the wire. Prove writers as well as public/read subjects cannot retrieve non-current accepted bytes and nobody can retrieve rejected/draft bytes through server state.
5. Extend the TypeScript `WireClient` with strict accepted-update/result/conflict types and exact request reuse after ambiguous transport outcomes. Conflicts return as typed `409` values; do not add client merge behavior. Plan 013 independently implements the matching Foundation-only Swift wire package from shared fixtures.
6. For the migration release, make authority startup upgrade legacy schema and reflog evidence deterministically and idempotently. It adds the required accepted-update/device records without changing any TreeID, current root, canonical path, access rule, existing credential validity, or public output. Exercise that exact startup path on legacy fixture data and the restored production volume; after Plan 011 verifies the live upgrade, remove the compatibility path and leave exact current-schema creation/assertion rather than a permanent migration framework.
7. Add restart, transaction-failure, concurrent-update, semantic-request replay, client-persistable conflict, current-only authorization, obsolete-replay-table cleanup, and repeated one-way-upgrade integration tests.

## Verification

```sh
bun run test:sync-merge
bun test tests/integration/authority/update-host.test.ts tests/integration/authority/community-hosting.test.ts
bun run typecheck
bun run test:protocol
git diff --check
```

Expected: all fixture additions survive in accepted/draft Markdown; fixed-input merge hashes repeat; an ambiguous state-changing request replay returns the original result; migrated public Markdown/HTML and exact current refs match pre-migration; every wire subject is denied non-current access.

## Done criteria

- [x] `updates-v1` handles current, accept, merge, conflict, replay, and race cases transactionally.
- [x] The authority is the only merge implementation.
- [x] Linear accepted updates survive restart without changing root-ref semantics; rejected conflicts never appear in them.
- [x] Markdown property/fixture tests detect any omitted local or remote addition.
- [x] No wire subject can enumerate accepted history or retrieve non-current/rejected content.
- [x] The temporary legacy startup upgrade was idempotent and preserved exact identities, refs, access, credentials, objects, and public output through the live Railway migration; its compatibility code was then removed from the maintained runtime.

## STOP conditions

- A merge result can omit an added Markdown line or silently choose one unsafe structural side.
- A current-ref race can commit a result computed against a stale remote root.
- Exact request replay can create a second history entry or different result.
- Rollback cannot restore byte-identical refs and current output.
- Any wire route would enumerate accepted history or make old/rejected objects readable.

## Maintenance note

Retain accepted updates indefinitely in v1. Never retain rejected candidates, conflict responses, or drafts. During the first alpha, any merge-policy change must remain fixture-compatible or update the client, arbord, and authority contract in lockstep; do not distribute server merge internals into clients. Mixed-version negotiation is a post-alpha decision. Do not reintroduce dormant startup migrations: schema changes require an explicit, rehearsed migration release followed by another clean-runtime deployment.
