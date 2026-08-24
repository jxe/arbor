# Plan 009: Integrate arbord synchronization

> **Executor instructions**: Convert arbord and CLI synchronization to authority-owned accepted updates. Do not add a second merge implementation, deploy, write Swift, or auto-resolve a structured server conflict. Preserve local durability and every client-owned candidate.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/arbord packages/wire packages/core packages/stores packages/cli tests spec/fixtures package.json`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 008
- **Category**: integration/correctness
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Implementation status**: IMPLEMENTED LOCALLY — arbord persists exact pending requests and client-owned conflicts, consumes authority results without merging, validates downloaded objects during materialization, and preserves nested placements/local candidates across ordinary restart.
- **Verified at**: current working tree, 2026-08-24 (`bun run test:sync-merge`; `bun run test`, including `tests/integration/self-sync.test.ts`; `bun run test:e2e`; `bun run typecheck`; `bun run build`; `git diff --check`)
- **Hardening note**: exhaustive process-kill injection at every persistence boundary is optional follow-up hardening, not a completion gate for this plan.

## Why this matters

Arbord already knows the three roots the server needs: the last synchronized placement ref, the current local snapshot, and the authority's current ref. It should submit that durable intent and consume one authoritative merge result, rather than maintain ancestry, reproduce merge logic, or turn divergence into a whole-tree dead end.

## Current state

- `packages/arbord/src/service.ts` snapshots local materialization and treats `placement.ref` plus `placement.update` as the last accepted base.
- It durably submits exact candidates through `updates-v1`, consumes current/accepted/merged results, and persists complete client-owned conflict drafts.
- Reader-local mounts are excluded from snapshots/materialization and nested tracked trees are independent boundaries.
- Private placement/cache state belongs under the Arbor data home and never inside authored trees.

## Client contract

For each tracked placement, persist:

- last accepted root (`base`) and acceptance/watch cursor;
- current local candidate root and immutable objects;
- exact pending base, candidate, and required objects until a terminal result is durably applied;
- a complete locally persisted conflict response and portable draft snapshot;
- local generations created while a request or conflict is outstanding.

Submit `{ base: { root, update }, candidate, objects }` to `POST .../updates`; the authority derives the semantic request identity from canonical JSON. Reuse the same base/candidate intent after ambiguous transport failure, resending any required immutable objects. On `current`, `accepted`, or `merged`, validate and rehash the returned graph, materialize it through the existing crash-safe path, and advance placement base/update only after local application succeeds. On `409 conflict`, persist the entire response and complete draft snapshot locally before surfacing it, keep all later local generations, and do not create conflict-copy files. The authority retains none of this state. A later explicit resolution produces a normal new candidate against the response's current accepted update.

## Scope

**In scope**: persistent placement sync state, arbord/CLI/system integration, exact retry, server-result validation/materialization, conflict diagnostics/resolution plumbing, coordinated accepted-update migration, tests.

**Out of scope**: merge algorithms, authority schema, UI conflict editor, Swift, pairing, live deployment, new wire objects.

## Steps

1. Replace whole-tree divergence handling with a durable sync state machine that records base/local/request identity before network transmission and survives restart at every transition.
2. Submit missing immutable objects through `updates-v1`; never infer merge bases from mtime, current files, or server time, and never merge locally.
3. Validate returned object hashes, graph shape, tree boundaries, and declared roots before materialization. Preserve nested-placement exclusions on both upload and download.
4. Apply current/accepted/merged roots with existing destination-safe materialization and only then advance `placement.ref`; reconcile a crash between remote acceptance and local application by replaying the exact request.
5. Persist conflict roots, reasons, and the complete returned draft snapshot in client/placement state outside authored trees. Add CLI/system diagnostics that identify affected paths/reasons and provide explicit inspect/choose/edit/resubmit operations without leaking content or credentials into safe records.
6. Permit further local mutations while pending/conflicted. Rebase only through a new server sync after the previous result is known; never discard or overwrite an unsubmitted local generation.
7. Remove legacy `/push` and root-CAS negotiation from arbord and the TypeScript client. Every configured authority must advertise `updates-v1`; there is no downgrade path.
8. Add two-placement restart tests for one-sided upload/download, server merge, same-slot Markdown additions, request replay, conflict draft, continued local edits, nested trees, and explicit resolution. Deeper process-kill fault injection may be added later as hardening.

## Verification

```sh
bun run test:sync-merge
bun test tests/integration/cli-sync.test.ts tests/integration/authority/community-hosting.test.ts
bun run typecheck
bun run test:protocol
bun run build
git diff --check
```

Expected: two temporary arbord placements converge through authority results; every added Markdown line survives; exact ambiguous retries produce one accepted update; unsafe cases persist a complete client-owned draft and all newer local work without entering server history.

## Done criteria

- [x] Arbord persists and submits exact base/local/request intent without a merge engine.
- [x] Current, accepted, merged, and locally owned conflict results survive ordinary restart.
- [x] Remote graphs are rehashed and validated before local application.
- [x] Nested placements remain independent.
- [x] No local candidate is lost or turned into authored conflict-copy content.

## STOP conditions

- A base must be inferred from timestamps or mutable current files.
- Arbord would need to reproduce authority merge behavior.
- Advancing placement state before materialization can hide an unapplied accepted root.
- A conflict or pending request prevents preserving further local work.
- Any client or server path still depends on legacy `/push` or root-CAS synchronization.

## Maintenance note

Arbord owns scheduling, durable request state, validation, and materialization. The authority owns merge decisions and retained accepted history; keep that boundary visible in diagnostics and tests.
