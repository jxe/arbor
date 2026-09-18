# Apps 004: Resource policy, execution authority, and coordinated account cutover

## Status and scope

**P1 · PLANNED · first in Apps execution sequence.** This replaces the unimplemented
named-mutation-permission proposal under the same stable plan identifier. No old
permission namespace or unused query/mutation API compatibility is required.
Depends on current governed account configuration and ordinary accepted updates,
not the unfinished Apps 003 compiler. Blocks [Apps 005](005-source-resolution-and-sidecar.md)
and the permissions portion of [Apps 006](006-durable-authoring.md).

Normative contracts: [access control](../../spec/05-access-control.md),
[account configuration](../../spec/04-accounts-and-devices.md), and
[source resolution](../../spec/03-locators.md#7-source-resolution). Current source, tests,
`git status`, and schema constants are authoritative implementation evidence.
This plan schedules Joe's coordinated live upgrade; writing this plan is not a
live deployment. Preserve dirty editors and unrelated work throughout execution.

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

Read `packages/core/src/protocol.ts`, `packages/merge/src/account.ts`,
`packages/canopy/src/account-policy.ts`, `host.ts`, access/group evaluation,
update acceptance and watch/object handlers. Inspect `tests/unit/account-config-v2.test.ts`,
`tests/unit/canopy/group-access.test.ts`, source acceptance tests, Swift ArborWire
and configuration consumers, conformance account fixtures, and `migrations/README.md`.
Inventory current deployed schema/version and actual configuration identities;
do not reuse the obsolete schema 6 assumption in the former plan.

## Implementation sequence

1. **Shared contract and effective policy.** Add language-neutral vectors and
   paired TS/Swift types for rules, safe redacted entries, resource scopes and
   effective operation descriptions. Remove named mutation permission targets.
   Keep scalar `AccessLevel` only as a whole-tree summary. Define canonical rule
   key `(who, via, within)`, duplicate rejection, deterministic serialization,
   scope segment matching, operation expansion and unknown-operation rejection.
   Preserve group/person distinction and link-secret secrecy.
2. **Governed configuration.** Extend strict parser/serializer and policy merge;
   support non-hosting entries without reserving or unhosting a tree. Preserve
   canonical-origin and administrator invariants. Normalize omitted scope for
   merge identity. Concurrent narrowing/deletion must not union back authority;
   conflicts enforce restrictive effective policy until exact authorized resolution.
   Test stale-device edits and removal/re-add separately; no new grant identity.
3. **Authority engine.** Centralize current caller, code attestation, policy owner,
   underlying authority and declared requirements. Owner ACLs grant access;
   non-owner policy only delegates authority independently established from the
   owner. Detect/deny circular delegation. Bind `me` to the configuration account.
   Issue opaque bounded runtime authorization without general credentials; token
   claims cannot outlive revocation. Explicit privileged cross-code invocation
   starts a new context; library imports acquire no independent grants.
4. **All data boundaries.** Audit tree inventory/descriptors, bootstrap, current
   and historical snapshots, object fetch, source/schema reads, conflict inspection,
   updates, receipt replay, and watches. Whole-object reachability must not leak
   unrelated nodes through a scoped grant. Reject unsupported scoped projection
   rather than return a whole tree. Check submitted intent and accepted effects,
   including merge-created alternatives, cascades, moves, deletes, resolution and
   schema edits. Create-only must not replace existing content. Validate before
   work and atomically recheck policy at acceptance. Guard failure recomputes;
   a guard never grants write. Preserve ordinary update identity and replay rules.
5. **Observation and revocation.** Order event disclosure against accepted policy
   changes. Reauthorize replay and queued events; prevent out-of-scope path/hash
   leakage. Add runtime invalidation for configuration, group, device/session and
   underlying ACL changes. A broken channel fails closed until refresh. Test a
   revoked stream while buffered data and an update are racing. Define scoped
   observation projection or reject it explicitly; whole-tree watch needs read.
6. **Administration and UI.** Consent produces a concrete configuration diff with
   caller, executable, resources and operations. Safe effective descriptions power
   UI only, never authorization. Update CLI/config editing and Swift decoding;
   do not expose execution tokens or other accounts' private policies.

## Coordinated Joe configuration and Canopy migration

Implement a new numbered offline migration using the NEXT available identifier.
Do not edit retained historical migrations or silently migrate on server startup.

1. Inventory Joe's accepted configuration tree(s), roots/update IDs, devices,
   placements and queued configuration edits read-only. Identify actual Canopy
   deployment, binaries and clients. Capture unsaved/recovery state and exact
   configuration bytes before requesting Joe's manual app restart gate.
2. Produce a reviewable conversion: old `subject/access` maps to `who/allow`
   without `via`; preserve profile/group/link identities, canonical URLs and
   effective read/write. Do not invent executable grants. Preserve non-policy
   bytes where possible and record intentional YAML changes. Verify all accounts,
   not merely Joe, even if inventory confirms Joe is the sole user.
3. Back up database, immutable objects, configuration history, local private state
   and authored manifests per `migrations/README.md`. Verify archive checksums,
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
   the documented operator procedure. Upgrade Canopy, merge executable, schema,
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

Run focused account/access/Canopy tests, then `bun run typecheck`, `bun run test`,
`bun run test:protocol`, `bun run build`, affected Swift package suites including
ArborWire and ArborSyncClient, the explicit migration suite, repository relative-link
check and `git diff --check`. Run applicable UI tests only where maintained; the
web build is currently excluded per DEVELOPMENT.md. Document actual commands/results.

Done requires deployed/rehearsed permission equivalence for old rules, no scoped
leakage or forged code identity, matched installed clients, Joe's preserved
configuration/content identities and successful revocation/rollback evidence.
Move this plan to `_done/applications/` only after the live gate and soak; update
status and indexes with measured evidence. Block cutover on unrecoverable pending
edits, missing backups, unknown active client or a scope check that cannot be proved.
