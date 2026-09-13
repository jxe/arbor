# Reliability 007: Stabilize the ordinary Wire contract around accepted conflicts

## Status and agreed scope

**DONE, 2026-09-13.** Core contract implemented and verified following design review. External
clients need a stable Wire API before Canopy chooses its conflict backend.
Coordinate the core contract with [Arbor Sync 001](../../arborsync/001-file-bytes-are-the-object.md)
and its one-time object-format migration. The object-directory extraction is later.

This replaces the previous protocol-first plan: conflict exploration, regions,
alternatives, resolution operations, and editor intent are deliberately deferred
to versioned optional extensions. Do not freeze those schemas or ship dormant
review UI now. No Jujutsu terms or Pijul graph identities belong in core Wire.

## Core behavior

- Ordinary updates submit a complete candidate projection against an exact
  accepted base. The accepted update identity is distinct from its root hash.
- Every accepted root is an ordinary, materializable directory graph. Conflicts
  never require marker files, alternative filenames, or special graph objects.
- Accepted state can signal unresolved conflicts independently of its projection.
  A metadata-only accepted transition advances update/cursor even when root is
  unchanged. Clients preserve the signal through durable state and watches.
- Leaving projected content unchanged does not resolve unresolved alternatives.
  A future backend must preserve them during ordinary updates and distinguish
  explicit resolution through its optional extension.
- Conflict inspection/resolution is a discoverable versioned capability. A
  client without it can synchronize ordinary projections and indicate review is
  needed. Unknown optional extensions must not change core update meaning.
- Current Canopy continues returning structured 409 for unsafe merges until a
  reification backend is implemented. Do not claim acceptance support is live.

## Implementation

1. Update normative specs and matching TypeScript/Swift models and fixtures for
   the minimal accepted-conflict signal and extension boundary. Keep detailed
   conflict protocols out of the core contract.
2. Preserve accepted metadata across descriptor, result, watch, durable client
   state, and root-unchanged transitions. Add focused cross-language fixtures.
3. Coordinate format/version semantics with Arbor Sync 001. Reject unsupported
   mutation formats explicitly rather than interpreting them as older requests.
4. Run focused Wire/client tests and the relevant DEVELOPMENT.md gates. Record
   implemented versus future behavior accurately in status.md and reference docs.
5. Prepare/rehearse the shared migration before live cutover. Do not introduce
   the previous optional-editor-intent or projected-resolution request union.

## Later work

Choose a backend using edits inside conflicts, moves, independent later edits,
partial resolution, stale review, restart, retention, authorization, and bounded
history fixtures. The backend owns retention of alternatives absent from the
ordinary root. Its exploration/resolution extension may depend on its model;
its ordinary update/projection behavior must preserve the core contract.

Existing rejected-update and local-divergence review remains owned by
[Reliability 004](../../reliability/004-contextual-canopy-conflict-resolution.md).

## Verification

Read [DEVELOPMENT.md](../../../DEVELOPMENT.md). Run bun run typecheck, bun run test,
bun run test:protocol, bun run test:sync-merge, applicable Swift package tests,
the repository-wide relative-link check, and git diff --check. Native editor
checks use tools/test-arbor-quagmire-local.sh, never raw editable SwiftPM tests.
Move this plan to plans/_done/reliability only after its core contract work is
verified; backend and extension work remain future work.

## Completion evidence

TypeScript and Swift expose optional `conflicted` accepted metadata and optional
versioned extension identifiers. Shared state-machine fixtures advance an accepted
update/cursor at an unchanged root without blocking ordinary editing; a native
coordinator test verifies persistence through restart. Descriptor/watch validation
requires agreement with the final accepted transition. Daemon placement metadata
and native control state retain the signal. Canopy still rejects unsafe merges;
it does not yet store unresolved alternatives.

The protocol gate, 55 working-tree tests, focused merge tests, typecheck, and both
signed native builds pass. Product verification retains one pre-existing expanded
child-title failure reproduced on unchanged HEAD. This core contract shipped with
migration 005; backend selection and its optional extension remain the separate
future design spike in the active plan index.
