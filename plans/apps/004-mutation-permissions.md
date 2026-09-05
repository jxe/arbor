# Apps 004: Authorize reviewed mutations without whole-tree write access

> **Executor instructions:** Read this plan completely before editing. Follow
> the normative contract in `spec/05-access-control.md`,
> `spec/07-executable-documents.md`, and `spec/08-authoring-api.md`; do not
> redesign its vocabulary or collapse caller permission into executable write
> authority. Run every verification gate. If a STOP condition occurs, report
> it instead of improvising. When the work is complete, move this file to
> `plans/_done/applications/004-mutation-permissions.md`, preserve the Apps 004
> identifier, update `plans/README.md`, and record verification evidence
> in `plans/_done/outcomes.md`.
>
> **Drift check (run first):**
> `git diff --stat 615ffb7..HEAD -- spec packages native conformance tests examples/supplies plans/apps status.md docs`
> and
> `git status --short -- spec packages native conformance tests examples/supplies plans/apps status.md docs`
> If the access types, account-configuration format, mutation authoring
> signature, manifest design, or Canopy mutation route changed, reconcile the
> excerpts below against live source before proceeding. Treat a semantic
> mismatch as a STOP condition.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH — this changes an authorization boundary and a cross-language
  Wire contract.
- **State:** PLANNED
- **Depends on:** [Apps 003](003-development-compiler-and-editor-tooling.md)
  for the reviewed executable-document manifest and compiler activation path.
- **Blocks:** the multi-user hosted acceptance gate in
  [Apps 001](001-supplies-executable-site.md) and mutation tools in
  [Apps 002](002-canopy-hosted-agents.md).
- **Category:** applications / security
- **Planned at:** commit `615ffb7`, 2026-09-04

## Target result

A subject with read access to an executable Arbor tree can invoke only the
reviewed named mutations for which its ACL grants a tree-scoped mutation
permission. It cannot submit arbitrary accepted updates or write directly to
nodes or backing stores. Whole-tree `write` continues to authorize accepted
updates and every tree-local named mutation.

Mutation permission is only the caller gate. The active compiled manifest
still confines the mutation's transaction domain, trees, write prefixes, and
operations, while ownership, authorship, membership, and current-state checks
remain inside the runner-owned transaction. External effects retain their
separate future capability and consent contract.

The user-facing umbrella label is **Can contribute**. The protocol operation is
**invoke**, the ACL values are **mutation permissions**, and `write` continues
to mean unrestricted candidate-tree updates. Do not add `mutate` or
`contribute` to the ordered `AccessLevel` union.

## Frozen portable contract

One ACL entry remains attached to one `everyone`, profile, group-profile, or
access-link subject:

```yaml
access:
  - subject:
      kind: profile
      tree: tr_alice_profile
    access: read
    permissions:
      - contribute
      - react
```

`access` remains required and is `read` or `write`. `permissions` is optional;
omission means an empty list. Permission names are lower-case ASCII
`[a-z][a-z0-9-]*`; `none`, `read`, and `write` are reserved. Names are scoped
by the executable tree, are unique within a rule, and preserve authored order
in YAML. Effective active permissions are the set union across all valid
presented subjects and are sorted in Wire descriptors; stored inert names
remain visible only in safe administrative access entries. `write` satisfies every
tree-local mutation permission without enumerating implied names.

Executable authoring uses a declared, described permission value:

```ts
const contribute = permission("contribute", {
  title: "Contribute",
  description: "Add content and edit contributions you are allowed to edit",
})

export const updatePractice = mutation(
  suppliesData,
  inputSchema,
  { requires: contribute },
  async ({ user, tx }, input) => {
    // Data-dependent authorization remains inside this transaction.
  },
)
```

The existing `mutation(source, schema, handler)` overload defaults to
whole-tree `write`. One mutation has exactly one caller requirement. Permission
definitions and per-handle requirements are reviewed manifest facts, not
caller-controlled strings. An ACL name absent from the active manifest is inert
and produces an administrative diagnostic.

`useCanInvoke(handle)` reports only whether the current caller satisfies the
active handle's coarse ACL requirement. The host rechecks every call; this
value does not predict row-dependent handler authorization and is never
authorization evidence.

## Current state

- `packages/core/src/protocol.ts` defines
  `AccessLevel = "none" | "read" | "write"`; `AccessRule` and `AccessEntry`
  carry only `subject` and `access`.
- `packages/stores/src/account-config-v2.ts:accessRules` uses exact-field
  parsing and rejects everything except `subject` and `access`.
- `packages/canopy/src/access.ts:AccessControl` computes a scalar maximum and
  has separate `canRead`, `canWrite`, and `canAdminister` decisions.
- `packages/canopy/src/host.ts` currently gates
  `POST /.arbor/trees/{TreeID}/mutate` with
  `account && canopy.canWrite(...)`, so a
  reader and an access-link-only caller cannot invoke any named mutation.
- `packages/data/src/authoring.ts:mutation` has only the three-argument form.
  `RegisteredMutationRuntime` receives trusted `ArborUser | null`, but retry
  lookup currently derives its subject only from the user profile or the
  string `anonymous`.
- `packages/canopy/src/schema.ts` stores one scalar `access` value per ACL
  entry and currently stamps schema version 6. Existing databases refuse a
  mismatched version and require an explicit offline migration.
- `native/Packages/ArborWire/Sources/ArborWire/WireModels.swift` models
  `WireAccessEntry.access` as a string and has no permission list.
- `conformance/wire-values.json` is the shared TypeScript/Swift descriptor and
  access-entry fixture.
- `examples/supplies/Practice.tsx` and `examples/supplies/List.tsx` already
  demonstrate transactional ownership/authorship checks. Preserve those
  checks when adding the coarser caller permission.

The normative target is already recorded in:

- `spec/05-access-control.md` — ACL shape, effective union, write dominance,
  and the three authorization boundaries;
- `spec/07-executable-documents.md` — mutation requirement, manifest, route,
  retry, and consent semantics;
- `spec/08-authoring-api.md` — `permission`, the mutation overload, and
  `useCanInvoke`; and
- `spec/01-tree-operations.md` — effective permissions in tree descriptors.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| TypeScript typecheck | `bun run typecheck` | exit 0, no diagnostics |
| Product tests | `bun run test` | exit 0, all unit/integration tests pass |
| Protocol parity | `bun run test:protocol` | exit 0, shared TypeScript/Swift fixtures and live protocol tests pass |
| Swift Wire | `swift test --package-path native/Packages/ArborWire` | exit 0 |
| Web build | `bun run build:web` | exit 0 |
| Browser acceptance | `bun run test:e2e` | exit 0 |
| Documentation whitespace | `git diff --check` | no output |

## Scope

### In scope

- Portable types and validation in `packages/core/src/protocol.ts` and its
  existing protocol validators.
- Strict current account configuration in
  `packages/stores/src/account-config-v2.ts`; touch the temporary v1 decoder
  only if it still participates in live Canopy startup when this plan runs.
- Canopy ACL persistence/evaluation in `packages/canopy/src/access.ts`,
  `model.ts`, `schema.ts`, `canopy.ts`, `account-policy-v2.ts`, and `host.ts`.
- One offline Canopy schema migration under the next unallocated
  `migrations/NNN-mutation-permissions/` identifier, including its focused
  migration test and rehearsal instructions.
- Authoring/runtime support in `packages/data/src/authoring.ts`,
  `mutation.ts`, `host.ts`, and their public exports.
- The compiler and manifest files delivered by Apps 003, but only for
  permission definitions, per-handle requirements, diagnostics, and
  `useCanInvoke` metadata.
- TypeScript and Swift Wire/client models that encode or decode access entries
  and tree descriptors.
- `packages/cli/src/index.ts` and `packages/render/src/configuration.ts` for
  explicit named-permission administration and **Can contribute** presentation.
- Shared conformance fixtures, focused unit/integration/protocol/browser tests,
  the Supplies acceptance corpus, current implementation status, and
  reference-implementation documentation.

### Out of scope

- Path-scoped ACLs; use nested trees for a new access boundary.
- Deny rules, permission expressions, roles, inheritance, or an ACL policy
  language. Existing group-profile subjects can bundle grants.
- Mutation-only access without read access.
- Direct raw writes by a mutation-permission holder.
- Moving row ownership, authorship, or workflow checks into `trees.yaml`.
- External network, credential, payment, email, calendar, or agent effects.
- The deferred model-hash-only accepted-update grant.
- A generic capability framework shared with backing/compiler/runtime feature
  capabilities. Use the specific `MutationPermission` vocabulary.

## Implementation steps

### 1. Extend the portable access model in TypeScript and Swift together

Add a validated `MutationPermission` string type and optional per-rule
permission list to `AccessRule` and `AccessEntry`. Add a required effective
`permissions` list to tree descriptors, sorted and duplicate-free. Keep
`AccessLevel` unchanged.

Update `conformance/wire-values.json` first with:

- a reader with `contribute` and `react`;
- a writer whose implied permissions are not enumerated;
- an empty effective list;
- invalid names, duplicates, unsorted descriptor values, and a link access
  entry that still reveals no digest.

Update TypeScript validators/tests and Swift `Codable` models/tests in the same
change. A missing ACL-entry `permissions` field decodes as empty; a descriptor
must carry the effective list once the protocol cutover occurs.

**Verify:** `bun test tests/unit/protocol.test.ts && swift test --package-path native/Packages/ArborWire`
→ all shared valid values decode identically and every invalid vector fails.

### 2. Parse, serialize, persist, and migrate ACL permissions

Extend the strict v2 `trees.yaml` parser and canonical serializer. Reject
unknown fields, malformed/reserved names, and duplicates. Preserve the authored
order in YAML while treating permissions as a set for policy comparison.

Store permissions relationally, keyed to the existing ACL entry, rather than
as comma-separated text or unvalidated JSON. Bump `CANOPY_SCHEMA_VERSION` once.
Create the next available offline migration using `migrations/README.md`: it
must back up first, add the permission relation empty for every existing ACL,
preserve all existing IDs/rules/accepted roots, update the schema stamp only
after validation, and be idempotently diagnosable on rerun. Never auto-migrate
at Canopy startup.

Update account-policy comparison so reordered permission lists do not create a
semantic policy difference, while canonical authored output remains stable.

**Verify:** run the new migration test plus
`bun test tests/unit/account-config-v2.test.ts tests/unit/canopy/schema-migration.test.ts`
→ existing rules round-trip with empty permissions, populated rules round-trip,
and malformed configuration and mismatched schemas fail closed.

### 3. Compute effective mutation permissions

Replace scalar-only internal access evaluation with one effective result:

```ts
type EffectiveTreeAccess = {
  access: "none" | "read" | "write"
  permissions: readonly MutationPermission[]
}
```

Union explicit permissions across direct profile, valid group-profile,
`everyone`, and the presented access link. Preserve current profile/group rules:
a person profile that lists members is not a group. `write` satisfies every
tree-local permission at the decision point but does not expand the returned
list. Retain `canRead` and `canWrite` as thin callers of this single evaluator
so their answers cannot drift.

Add `canInvoke(account, tree, requirement, linkDigest)` or an equivalently
explicit method. It requires read access and returns true for whole-tree write
or an exact active permission. Unknown/inert permissions fail closed.

**Verify:** `bun test tests/unit/canopy/group-access.test.ts`
plus new focused access tests → cover direct, group, everyone, link, union,
write dominance, missing permission, malformed name, revocation, and the
person-profile non-expansion regression.

### 4. Compile permission declarations and mutation requirements

Implement `permission(name, { title, description })` as an opaque authoring
value and add the four-argument mutation overload without weakening the
existing three-argument form. The compiler must collect definitions by source
tree, reject conflicting metadata for one name, attach exactly one caller
requirement to each mutation handle, and include definitions and requirements
in the coherent reviewed manifest and consent statement.

Do not include permission grants in a handle's semantic request digest: ACL
state is reauthorized on every call, while the handle code version and source
bindings already identify executable intent. A permission-definition or
requirement change must change the coherent compiled version.

Implement `useCanInvoke(handle)` from trusted current access plus active handle
metadata. Hydration may reuse its initial value for presentation, but the server
must reauthorize submission.

**Verify:** run Apps 003's compiler fixtures plus focused authoring tests → the
old overload requires write, declared permissions reach the manifest, conflicts
fail compilation, public bundles contain descriptions but no handler code, and
`useCanInvoke` changes after access-context invalidation.

### 5. Enforce permission at the hosted mutation boundary

Replace the unconditional `account && canWrite` route gate with the active
handle requirement and `canInvoke`. Perform tree readability, coherent
document/handle resolution, active-manifest membership, and permission checks
before transaction entry without disclosing private handle or tree existence.
Input validation remains before data access.

Pass a trusted internal replay principal separately from `ArborUser | null`:
authenticated calls use the profile TreeID, access-link-only calls use an
internal digest-derived identity, and ordinary anonymous calls use a stable
anonymous identity. Never expose link digests or this internal principal to
authored handlers, results, logs, or transcripts. Recheck authorization before
returning a stored receipt so revocation applies to retries too.

Keep runner-owned transactions and handler checks unchanged. A denied call
must create no receipt, reserve no cursor, and publish no observation.

**Verify:** focused Canopy host and Supplies mutation integration tests → a
reader with the right permission succeeds, a reader without it fails, a writer
succeeds, revocation blocks the next call/retry, two replay principals do not
collide, and denied calls leave data/receipts/cursors unchanged.

### 6. Expose and administer permissions consistently

Return explicit permissions in safe administrative `AccessEntry` values and
effective sorted permissions in descriptors. Update TypeScript/Swift clients,
CLI JSON output, and the sharing configuration UI together.

The ordinary sharing UI should offer **Can view**, **Can contribute**, and
**Can edit everything** when the active tree declares a `contribute`
permission. Advanced permissions use their manifest titles/descriptions and
remain explicit; do not invent a role editor. Link entries continue to hide
both secret and digest.

**Verify:** focused rendering/CLI tests and shared protocol tests → YAML, CLI,
web, TypeScript, and Swift agree on the same grants and never leak link
material.

### 7. Prove the contract with Supplies

Declare only permissions exercised by the existing corpus. Use `react` for the
reaction mutation and `contribute` for suitable contribution mutations. Keep
owner-only sharing/renaming and authorship checks in their handlers; if a
mutation represents materially broader authority, leave it write-only rather
than stretching `contribute`.

Add a two-subject browser scenario: both can read; one has `contribute`/`react`
without write and can perform only the allowed actions; the other cannot. Show
that the contributor cannot submit an accepted update or invoke a write-only or
moderation-equivalent mutation. Revoke the permission and prove the already-open
document stops treating the handle as invocable and the server rejects a stale
submission.

Update `status.md` and `docs/reference-implementation.md` only after the
corresponding implementation and cross-language tests pass.

**Verify:** `bun run test:e2e` → the complete permission, denial, direct-write,
and revocation scenario passes.

## Test plan

- Model unit tests after `tests/unit/protocol.test.ts`,
  `tests/unit/account-config-v2.test.ts`, and
  `tests/unit/canopy/group-access.test.ts`.
- Model hosted route tests after
  `tests/integration/canopy/update-host.test.ts` and data authorization tests
  after `tests/integration/supplies-mutations.test.ts`.
- Extend `conformance/wire-values.json` and both its TypeScript and Swift
  consumers; do not create language-specific substitute fixtures.
- Cover all ACL subjects, union semantics, write dominance, unknown/inert
  permissions, parser rejection, link secrecy, anonymous/link/profile retry
  scoping, revocation, denied-call non-effects, legacy three-argument mutations,
  compile conflicts, `useCanInvoke`, and row-level denial after coarse success.
- Add a migration test that compares pre/post authored roots, ACL entry IDs,
  rule levels, account/device state, foreign keys, and schema stamp.
- Finish with all commands in the Commands table.

## Done criteria

- [ ] `AccessLevel` remains exactly `none | read | write`.
- [ ] Current YAML round-trips unchanged; permissions round-trip and validate.
- [ ] Effective permission union and write dominance pass for every subject
  kind without widening group semantics.
- [ ] TypeScript and Swift consume the same permission-aware conformance
  vectors.
- [ ] A read-only Supplies subject can invoke an explicitly permitted mutation
  but cannot submit an accepted update or invoke another mutation.
- [ ] Handler ownership/authorship checks still deny unauthorized rows after
  coarse ACL authorization succeeds.
- [ ] Revocation prevents new calls and receipt retrieval without creating a
  second effect.
- [ ] The offline Canopy migration passes backup, integrity, preservation, and
  rerun checks; startup never mutates an old schema.
- [ ] `useCanInvoke` is presentation-only and every server call reauthorizes.
- [ ] Link secrets/digests and internal replay principals never enter safe
  access output, handler context, public errors, logs, or transcripts.
- [ ] `bun run typecheck`, `bun run test`, `bun run test:protocol`,
  `swift test --package-path native/Packages/ArborWire`, `bun run build:web`,
  `bun run test:e2e`, and `git diff --check` all pass.
- [ ] The plan is moved to completed history and status/reference docs record
  only behavior actually verified.

## STOP conditions

Stop and report instead of improvising if:

- Apps 003 has not produced one coherent reviewed manifest and activation path;
- implementing permissions would require caller-selected handle requirements,
  targets, write prefixes, or permission strings;
- a permission cannot be rechecked before transaction entry and stored-receipt
  return;
- link-only or anonymous invocation cannot receive a stable internal replay
  scope without exposing secret material;
- the next migration identifier is already allocated, the current schema
  version is no longer 6, or the repository's offline migration procedure has
  changed;
- Swift and TypeScript cannot adopt the same Wire shape in one protocol change;
- a mutation needs multiple permissions, a deny rule, path-scoped ACLs, or an
  external effect to satisfy the first concrete Supplies scenario; or
- any implementation step would overwrite unrelated working-tree changes.

## Maintenance notes

Permission names are durable policy vocabulary. Reviewers should scrutinize a
later code change that attaches an existing permission to a broader mutation,
even when the ACL file itself is unchanged. Manifest review and consent must
make that widening visible.

If repeated applications later need roles, first gather two concrete sets of
permissions that must be administered together. A role may then become an
authoring/UI bundle that expands to permissions; it must not replace the
tree-scoped permission identities or the per-mutation requirement.
