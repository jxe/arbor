# Correctness and reliability 003: Make untracked rollup mutations restart-safe

> **Drift check:** inspect `FilesystemService.executeMutation`,
> `ProjectionProviderHost` prepared property writes,
> `MutationJournal`, and the managed `Workspace` mutation path. Stop if
> untracked file-rollup receipts and prepared-file recovery are already durable
> across process restart.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** Correctness and reliability 002 for safe journal appends
- **Progress:** TODO
- **Written against:** `450d2a4`

## Problem

CSV, JSON, and JSONL row writes prepare and fsync a sibling file, validate its
complete logical contents, compare the current source revision, and publish by
rename. Managed workspaces place the enclosing mutation inside their durable
journal. `FilesystemService`, which owns paths outside managed workspaces,
retains completed receipts only in an in-memory map.

A process exit can therefore lose retry identity after a successful rename or
leave a positively identifiable prepared sibling without a durable record that
explains whether it should be committed or removed. Retrying under the same
mutation ID can no longer distinguish replay from a new request.

## Required behavior

1. Give `FilesystemService` a durable mutation journal under its existing
   private untracked-filesystem state. Reuse the common request-hash, pending,
   materialized, completed, and receipt semantics rather than inventing another
   receipt format.
2. Persist intent before preparing the candidate. Persist enough exact target,
   source revision, stable key, and temporary-file identity to recognize only
   Arbor's own prepared sibling after restart.
3. After the final source comparison, durably mark the expected/materialized
   effect before acknowledging success. Complete the exact receipt before it is
   returned to the caller.
4. On replay, return an identical completed receipt for an identical request and
   reject reuse of the mutation ID with a different request hash.
5. On startup, recover or remove only a temporary file named in a valid journal
   record. Never glob-delete arbitrary editor-created siblings. If source state
   no longer proves a safe commit, retain the authoritative source, remove the
   known temporary, and expose an actionable interrupted-mutation diagnostic.
6. Preserve the current cooperative-writer boundary. Revision checks serialize
   Arbor writers; do not claim an impossible conditional rename against
   non-cooperating external editors.
7. Define bounded receipt retention only after proving that pruning cannot make
   a supported retry ambiguous. Do not silently age out pending records.

## Scope

Expected files include:

- `packages/arborsync/src/fs-service.ts`;
- `packages/fs/src/journal.ts` if the shared durable record needs a narrowly
  reusable prepared-file field;
- `packages/stores/src/collections.ts` only to expose a safe prepare/commit/
  abandon lifecycle;
- focused unit and integration tests with process-restart or reconstructed
  service instances.

Out of scope: changing exact-source formatting, weakening CAS, creating a
filesystem-wide lock, database receipt replacement, or deleting unidentified
temporary-looking files.

## Verification

Inject interruptions at intent persisted, prepared file fsynced, source checked,
rename completed, effect materialized, and receipt completed. Prove:

- pre-rename interruption preserves the old source and cleans only the recorded
  temporary;
- post-rename interruption replays the original receipt without applying the
  mutation twice;
- request-hash mismatch is rejected after restart;
- an external source change wins over an abandoned prepared candidate; and
- JSON, JSONL, and CSV formatting-preserving writes retain current behavior.

Run:

```sh
bun test Tests/integration/collections.test.ts Tests/unit/journal.test.ts
bun test Tests/integration Tests/unit
bun run typecheck
git diff --check
```

## Done criteria

- [ ] Untracked file-rollup intent, materialization, and receipt survive restart.
- [ ] Exact replay returns the original receipt; mismatched replay fails closed.
- [ ] Startup cleanup touches only positively identified Arbor prepare files.
- [ ] Current exact-source validation, formatting preservation, and CAS remain intact.
- [ ] Fault-injection tests cover every durability boundary.

## STOP conditions

- Recovery would require guessing whether an unidentified sibling belongs to
  Arbor.
- A shared journal change would alter managed-workspace replay semantics beyond
  the narrow reusable record extension.
- The proposed pruning policy can forget a mutation while clients may still
  retry it.
