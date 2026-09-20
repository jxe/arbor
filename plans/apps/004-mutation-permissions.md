# Apps 004: Resource policy, execution authority, and coordinated account cutover

## Status and scope

**P1 · IN PROGRESS · deployed 2026-09-18; integration and soak remain.** This replaces the unimplemented
named-mutation-permission proposal under the same stable plan identifier. No old
permission namespace or unused query/mutation API compatibility is required.
Depends on current governed account configuration and ordinary accepted updates,
not the unfinished Apps 003 compiler. Blocks [Apps 005](005-source-resolution-and-sidecar.md)
and the permissions portion of [Apps 006](006-durable-authoring.md).

Normative contracts: [access control](../../spec/05-access-control.md),
[account configuration](../../spec/04-accounts-and-devices.md), and
[locator resolution](../../spec/03-locators.md#4-resolution-rules). Current source, tests,
`git status`, and schema constants are authoritative implementation evidence.
This plan schedules Joe's coordinated live upgrade; writing this plan is not a
live deployment. Preserve dirty editors and unrelated work throughout execution.

## Worktree checkpoint (2026-09-18)

The implemented boundary is summarized in [status.md](../../status.md) and the supported scope rules in [the reference implementation](../../docs/reference-implementation.md#resource-policy)
and Migration 011 (migration 011, deleted after cutover; see git history). Shared TS/Swift
rules, resource parsing/indexing, execution tokens, guarded effects, replay checks,
revocation streams and offline schema/configuration preparation are implemented.
Restrictive policy-conflict acceptance and restart, exact administrator resolution,
Native consent/review and configuration preservation, safe access responses, and
watch cancellation cleanup are also implemented. The production-copy rehearsal and coordinated cutover are complete; see the
Migration 011 live evidence. Remaining work is interactive consent/conflict
validation, required provider integration in Apps 005/006, rollback observation
and soak.

## Target and frozen decisions

`trees.yaml` remains resource-keyed. Rules have `who`, optional `via: TreeID`,
`allow`, and optional `within` (default `/`, subtree excluding nested trees).
`who` is `me`, `everyone`, profile/group-profile, or access-link digest. No `via`
means ordinary access usable through code as well. `via` restricts authority to
host-attested code, never a caller assertion. No module/export grant IDs or new
`grants.yaml` are introduced. Non-hosting policy entries omit `canonical` and
cannot claim ownership or widen the account's existing access.

Author/user requirements contribute combined, attenuated authority while retaining
provenance. Private author access is not automatically loaned to every caller.
Host configuration binds the sponsoring account. Consent edits account configuration;
code changes within the envelope retain grants, expansions require new coverage.
Administrator devices alone edit policy initially. Public queries using ordinary
public reads need no additional code grant. Revocation affects retries and streams.

## Inspect before editing

Read `packages/protocol/src/model/protocol.ts`, `packages/canopyd-merge/src/account.ts`,
`packages/canopyd/src/account-policy.ts`, `host.ts`, access/group evaluation,
update acceptance and watch/object handlers. Inspect `tests/unit/account-config-v2.test.ts`,
`tests/unit/canopyd/group-access.test.ts`, source acceptance tests, Swift Overstory
and configuration consumers, conformance account fixtures, and `packages/canopyd/migrations/README.md`.
Inventory current deployed schema/version and actual configuration identities;
do not reuse the obsolete schema 6 assumption in the former plan.

## Remaining implementation/rehearsal boundaries

The deleted checkpoint document (git history: `docs/resource-policy-implementation.md`) recorded completed
implementation and verification. Before enabling the first sidecar application:

- Exercise Native consent/revocation and exact configuration conflict resolution on
  the isolated production copy, including stale editors and queued device writes.
- Connect Apps 005 host/session/code-activation attestations to token issuance and
  authority-watch invalidation. There is intentionally no public mint endpoint.
- Verify that the app's requested effects fit the supported scoped snapshot subset.
  Unsupported operation/resolution forms and scoped whole-object/watch projection
  currently reject. Implement exact provider enforcement in Apps 005/006 before
  exposing those forms; never substitute broad write/read to make them work.
- Rehearse matched server, merge worker, CLI and Native binaries with the additive
  `policy` access response and the new configuration grammar. Verify ordinary CLI
  sharing assignments replace only their selected root rule; explicit `--clear-access`
  removes all rules. Cross-account policy transfer remains explicitly unsupported.

## Coordinated Joe configuration and canopyd migration

Implement a new numbered offline migration using the NEXT available identifier.
Do not edit retained historical migrations or silently migrate on server startup.

1. Inventory Joe's accepted configuration tree(s), roots/update IDs, devices,
   placements and queued configuration edits read-only. Identify actual canopyd
   deployment, binaries and clients. Capture unsaved/recovery state and exact
   configuration bytes before requesting Joe's manual app restart gate.
2. Produce a reviewable conversion: old `subject/access` maps to `who/allow`
   without `via`; preserve profile/group/link identities, canonical URLs and
   effective read/write. Do not invent executable grants. Preserve non-policy
   bytes where possible and record intentional YAML changes. Verify all accounts,
   not merely Joe, even if inventory confirms Joe is the sole user.
3. Back up database, immutable objects, configuration history, local private state
   and authored manifests per `packages/canopyd/migrations/README.md`. Verify archive checksums,
   counts and restoreability. Rehearse on an isolated production copy with no
   outbound execution/provider effects. Migration atomically installs new accepted
   config roots/policy indexes/schema and retains reconstructable old roots.
   Decide and test the compatible historical account-policy reader boundary; old
   historical roots cannot be reinterpreted as current grants.
4. Test old/new binaries on pre/post data. New startup rejects old schema until
   migration; old writers must not rewrite the new policy into the legacy shape.
   Reconcile or stop queued configuration writes before cutover. Ship matched
   TS/Swift/CLI parsers and merge-worker policy support before resuming clients.
5. Prepare concrete deployment and rollback artifacts, then quiesce writers through
   the documented operator procedure. Upgrade canopyd, merge executable, schema,
   Joe's accepted configuration and clients as one coordinated cutover. Do not
   delete/recreate account or resource TreeIDs, reset content history, or re-pair
   devices merely to migrate policy. Preserve ordinary content trees byte-for-byte.
6. Verify live accepted configuration identity and bytes, derived policy, readable
   and denied object paths, an authorized/denied guarded write, revocation during
   a watch, retry after revocation and client reconnect. Use dedicated test data
   for write probes. Compare local placements against accepted roots; a UI badge
   is not proof. Record exact artifacts and manual restart evidence.
7. Rollback restores a matched binary/database/object/config set. If new writes
   occurred, quiesce and preserve/reconcile them before restore; never blindly
   erase them. Retain backups until an explicit rollback-window close and soak.

## Verification and completion

Focused tests cover direct and `via` access, public code reads, `me`, group/link
rules, anonymous calls, combined authority, imported-code non-escalation, scope
escape and nested trees, non-owner delegation/revocation, stale updates, receipts,
queued watch events, safe metadata, parser/merge concurrency and policy migration.
Use process/restart tests for persisted policy and invalidation reconnect.

Run focused account/access/canopyd tests, then `bun run typecheck`, `bun run test`,
`bun run test:protocol`, `bun run build`, affected Swift package suites including
Overstory and ArborSyncClient, the explicit migration suite, repository relative-link
check and `git diff --check`. Run applicable UI tests only where maintained; the
web build is currently excluded per DEVELOPMENT.md. Document actual commands/results.

Done requires deployed/rehearsed permission equivalence for old rules, no scoped
leakage or forged code identity, matched installed clients, Joe's preserved
configuration/content identities and successful revocation/rollback evidence.
Delete this plan only after the live gate and soak; update
status and indexes with measured evidence. Block cutover on unrecoverable pending
edits, missing backups, unknown active client or a scope check that cannot be proved.
