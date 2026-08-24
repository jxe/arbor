# Plan 009: Integrate arbord synchronization

> **Executor instructions**: Convert arbord and CLI synchronization to the authority-owned `sync-v1` protocol. Do not add a second merge implementation, deploy, write Swift, or auto-resolve a structured server conflict. Preserve local durability and every retained candidate.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/arbord packages/wire packages/core packages/stores packages/cli tests spec/fixtures package.json`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 008
- **Category**: integration/correctness
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

Arbord already knows the three roots the server needs: the last synchronized placement ref, the current local snapshot, and the authority's current ref. It should submit that durable intent and consume one authoritative merge result, rather than maintain ancestry, reproduce merge logic, or turn divergence into a whole-tree dead end.

## Current state

- `packages/arbord/src/service.ts` snapshots local materialization, treats `placement.ref` as the last synchronized base, and reads the remote current root.
- It pushes when remote equals base, pulls when local equals base, and reports conflict when both changed.
- Reader-local mounts are excluded from snapshots/materialization and nested tracked trees are independent boundaries.
- Private placement/cache state belongs under the Arbor data home and never inside authored trees.

## Client contract

For each tracked placement, persist:

- last accepted root (`base`) and acceptance/watch cursor;
- current local candidate root and immutable objects;
- exact pending sync request ID and intent digest until a terminal result is durably applied;
- optional retained server attempt/draft/conflict references;
- local generations created while a request or conflict is outstanding.

Submit `{ requestID, base, local, objects }` to `sync-v1`. Reuse the identical request after ambiguous transport failure. On `current`, `accepted`, or `merged`, validate and rehash the returned graph, materialize it through the existing crash-safe path, and advance placement base/acceptance only after local application succeeds. On `conflict`, fetch/validate the draft, keep all local generations, expose structured reasons and alternatives, and do not create conflict-copy files. A later explicit resolution produces a normal new local candidate and syncs against the response's remote root/acceptance.

## Scope

**In scope**: persistent placement sync state, arbord/CLI/system integration, exact retry, server-result validation/materialization, conflict diagnostics/resolution plumbing, legacy migration negotiation, tests.

**Out of scope**: merge algorithms, authority schema, UI conflict editor, Swift, pairing, live deployment, new wire objects.

## Steps

1. Replace whole-tree divergence handling with a durable sync state machine that records base/local/request identity before network transmission and survives restart at every transition.
2. Submit missing immutable objects through `sync-v1`; never infer merge bases from mtime, current files, or server time, and never merge locally.
3. Validate returned object hashes, graph shape, tree boundaries, and declared roots before materialization. Preserve nested-placement exclusions on both upload and download.
4. Apply current/accepted/merged roots with existing destination-safe materialization and only then advance `placement.ref`; reconcile a crash between remote acceptance and local application by replaying the exact request.
5. Persist conflict attempt/draft metadata outside authored trees. Add CLI/system diagnostics that identify affected paths/reasons and provide explicit inspect/choose/edit/resubmit operations without leaking content or credentials into safe records.
6. Permit further local mutations while pending/conflicted. Rebase only through a new server sync after the previous result is known; never discard or overwrite an unsubmitted local generation.
7. Negotiate legacy root-CAS only for already-configured authorities during the bounded Railway migration. New/native configuration requires advertised `sync-v1`; remove downgrade support after Plan 011 records rollout completion.
8. Add two-placement restart/fault tests for one-sided push/pull, server merge, same-slot Markdown additions, request replay, accepted-before-local-crash, ref race, conflict draft, continued local edits, nested trees, and explicit resolution.

## Verification

```sh
bun run test:sync-merge
bun test tests/integration/cli-sync.test.ts tests/integration/community-hosting.test.ts
bun run typecheck
bun run test:protocol
bun run build
git diff --check
```

Expected: two temporary arbord placements converge through authority results; every added Markdown line survives; exact ambiguous retries produce one accepted history entry; unsafe cases retain the server draft and all newer local work.

## Done criteria

- [ ] Arbord persists and submits exact base/local/request intent without a merge engine.
- [ ] Current, accepted, merged, and conflict results survive restart and crash injection.
- [ ] Remote graphs are rehashed and validated before local application.
- [ ] Nested placements remain independent.
- [ ] No local candidate is lost or turned into authored conflict-copy content.

## STOP conditions

- A base must be inferred from timestamps or mutable current files.
- Arbord would need to reproduce authority merge behavior.
- Advancing placement state before materialization can hide an unapplied accepted root.
- A conflict or pending request prevents preserving further local work.
- Legacy downgrade could occur silently for a newly configured native client.

## Maintenance note

Arbord owns scheduling, durable request state, validation, and materialization. The authority owns merge decisions and retained accepted history; keep that boundary visible in diagnostics and tests.
