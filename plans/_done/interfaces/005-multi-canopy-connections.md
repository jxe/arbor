# Interface 005: Use several Canopy accounts through one Arbor Sync

> Historical executor record. Implementation and migration completed on
> 2026-09-03; current behavior is normative in the linked specifications.

> **Executor instructions**: Follow the milestones and gates in order. The
> readiness milestones must be mergeable without converting the person's live
> default data home. Until the explicit cutover milestone, exercise the plural
> layout only in temporary `ARBOR_DATA_HOME`s and disposable Canopies. Stop on a
> failed gate rather than adding account aliases, federation, a shared
> credential, an aggregate declaration file, or an automatic startup migration.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 5344a52..HEAD -- \
>   spec.md spec/01-tree-operations.md spec/03-locators.md \
>   spec/04-accounts-and-devices.md spec/05-access-control.md conformance \
>   docs/local-system.md docs/arborsync-api.md docs/client.md docs/cli.md \
>   packages/stores packages/arborsync packages/canopy packages/wire \
>   packages/client packages/cli packages/render native tests migrations
> ```
>
> Reconcile changed ownership, schema, authorization, credential, and migration
> assumptions before implementation. Updating the `Planned at` commit alone is
> not reconciliation.

## Status

- **Priority**: P2
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: completed native Plan 010 and the implemented one-account,
  two-device account-configuration/self-sync foundation
- **Cutover additionally depends on**: migration 002 iPhone verification and
  decoder-compatibility closeout; both completed on 2026-09-03
- **Category**: interface, identity, configuration, migration
- **Planned at**: Arbor `5344a52`, 2026-09-03
- **Progress**: COMPLETE — milestones 0–8 and the authorized migration 003
  cutover completed for the persistent Railway Canopy, default Mac home, and
  iPhone on 2026-09-03. Public verification, daemon restart, a reversible
  canonical edit, authored-file equality, and deliberately-last live iPhone
  account pairing/re-placement passed.

## Outcome

One supervised local Arbor Sync daemon presents one combined experience while
connecting independently to several Canopy accounts, including several
accounts at one Canopy. The same stable profile `TreeID` may be associated with
each account. Each account has its own configuration `TreeID`, hosted tree
declarations, devices, credential, accepted history, ACLs, and Canopy-allocated
canonical paths. A local profile tree exists before its first account.

The reference local layout after cutover is:

```text
~/.arbor/
  placements.yaml
  accounts/
    tr_config_a/
      account.yaml
      trees.yaml
      devices.yaml
    tr_config_b/
      account.yaml
      trees.yaml
      devices.yaml
  .state/
    ...private state and managed replica paths...
```

Each directory under `accounts/` is the actual synchronized checkout of that
account's governed configuration tree. There is no synthesized aggregate
`trees.yaml`. Local filesystem placements exist only in `placements.yaml`.

## Fixed decisions

1. **Identity starts locally.** Opening a previously unidentified local profile
   root generates and durably records its `TreeID`. A configuration `TreeID`
   identifies one Canopy account connection. Claiming an account neither mints
   nor uploads the profile tree.
2. **No extra account taxonomy.** Do not introduce `principal`, `home`, roles,
   or hosting-account types. A community member always has a profile TreeID;
   its optional Canopy-local allocation field determines whether it also has
   an account there. Every account may host trees.
3. **One account checkout per configuration `TreeID`.** The directory name is
   the stable routing key. Origin cannot be the key because two accounts may
   share one Canopy and a Canopy URL may change.
4. **The account graph is exactly three flat YAML files.** `account.yaml` is
   `{ canopy, profile }`; `trees.yaml` is a direct `TreeID` map;
   `devices.yaml` is a direct `DeviceID` map. Author files have no format
   `version` and no wrapper maps.
5. **Canonical declarations contain full Canopy URLs.** Each `canonical` is a
   normalized HTTPS URL at the account's origin. Whether the account may use
   its path is Canopy policy. It remains mutable secondary naming.
6. **Community membership owns current-Canopy allocation.** A structured
   member requires `profile: arbor://<TreeID>/`; optional `handle` reserves the
   current Canopy's `/~handle` account locator for that identity. The bare
   handle repeats neither DNS nor scheme and is not portable account identity.
7. **Devices are account-scoped.** Omitted `administrator` means false. An
   ordinary device changes only its own safe fields; an administrator promotes,
   demotes, and revokes. At least one administrator remains.
8. **Placements are local.** No device entry or synchronized account file
   contains an OS path or projection. Pairing registers a device and never
   places a tree.
9. **Server activation does not inspect a device placement.** A declared tree
   may be initialized by an authenticated account administrator submitting its
   initial snapshot. The local daemon separately needs a local source before it
   can originate that snapshot.
10. **Readiness precedes cutover.** New abstractions, routing, parsers, and
    presentation may land behind the singleton behavior. No readiness commit
    rewrites the default data home.
11. **Migration is an artifact, not product behavior.** Follow
    [`migrations/README.md`](../../../migrations/README.md): no permanent
    `arbor migrate` command, no startup auto-migration, and no runtime package
    import from a migration directory.
12. **Native per-account pairing is Interface 006.** This milestone makes the
    runtime and credential model account-aware and preserves account-local
    pairing. [Interface 006](006-multi-canopy-pairing.md) owns one QR for one
    selected account, durable exact retry, and repeatable native account
    addition.

## Target authored files

An account checkout:

```yaml
# accounts/tr_config_b/account.yaml
canopy: "https://canopy-b.example"
profile: "tr_joe_profile"
```

```yaml
# accounts/tr_config_b/trees.yaml
tr_sketches:
  canonical: "https://canopy-b.example/~joe-b/sketches"
  access: []
```

```yaml
# accounts/tr_config_b/devices.yaml
dv_mac_b:
  label: "Joe's Mac"
  administrator: true
dv_phone_b:
  label: "Joe's iPhone"
```

The local placement file is grouped by account configuration `TreeID` and then
maps a canonical absolute path directly to a hosted `TreeID`:

```yaml
# ~/.arbor/placements.yaml
tr_config_a:
  "/Users/joe/Documents/Notes": "tr_notes"
tr_config_b:
  "/Users/joe/Documents/Sketches": "tr_sketches"
```

There is no top-level `placements` key. Initially emit scalar values. The
reader may also accept an explicitly specified extended value only once a real
placement-specific option exists:

```yaml
tr_config_b:
  "/Users/joe/Documents/Sketches":
    tree: "tr_sketches"
    projection:
      driver: sqlite
      mode: read-only
```

Do not add this wider form merely for future-proofing. Arbor-managed replicas
must receive explicit real paths beneath `.state`, not a pathless sentinel.

## Reconciled implementation boundary

The readiness implementation now has these boundaries at HEAD:

- `account-config-v2.ts`, `account-policy-v2.ts`, plural private records, and
  the account-keyed synchronizer implement the new graph without importing the
  v1 grammar.
- `account-config.ts`, `account-policy.ts`, `CommunityConfigStore`, and the old
  handle-shaped claim remain named v1 adapters. They are migration inputs, not
  code used to emit a fresh v2 account.
- Fresh and subsequent v2 claims use the complete Canopy account locator, keep
  the same local profile TreeID, preserve existing `placements.yaml`, and
  refuse a mixed v1/v2 home.
- REST, web, and native surfaces enumerate configuration-TreeID-keyed accounts.
  The pre-migration CLI write commands stay in the v1 adapter and fail rather
  than guessing when a plural checkout exists.
- `conformance/configuration-yaml.json` now describes only the flat v2 graph;
  local placement cases remain reference-implementation tests.
- Native code consumes safe REST/Wire account descriptors rather than parsing
  synchronized YAML. Its credential and retry stores are keyed by
  configuration TreeID; a Canopy `handle` is optional presentation metadata.

Preserve the proven immutable-object, update, watch, conflict, source fidelity,
credential secrecy, single-use pairing, and one-daemon supervision contracts.

## Milestones

### 0. Reconcile Interface 005 at HEAD

This document and the revised account spec are the reconciliation baseline.
Before implementation, inventory every singular account assumption and record
its replacement test. In particular, distinguish these keys everywhere:

- profile identity: profile `TreeID`;
- account/connection identity: configuration `TreeID`;
- network destination: normalized Canopy origin;
- current-Canopy allocation: optional community-member `handle`;
- account claim target: complete Canopy-allocated account locator;
- credential binding: account-scoped `DeviceID`.

**Gate**: no proposed map or cache is keyed only by origin when its values are
account-visible, and no local path is proposed inside synchronized content.

### 1. Freeze the revised portable and local grammars

Add TypeScript v2 configuration models, parsers, encoders, semantic diffs, and
shared test fixtures for the exact three-file graph. Native clients consume
the validated REST/Wire account projection and do not duplicate a YAML parser.
Keep the v1 model
isolated behind the temporary singleton compatibility adapter until cutover;
do not let new account code emit v1. Replace portable
configuration conformance vectors with:

- valid direct maps and omitted-administrator defaulting;
- two accounts that reference the same profile `TreeID`;
- several accounts at one origin;
- normalized full canonical URLs at the account Canopy;
- invalid wrappers, author `version` keys, old `community/profile/admins`
  shapes, `devices/` files, path-only canonicals, foreign origins, credentials,
  placements, aliases, duplicate keys, and unknown fields.

Add separate reference tests for `placements.yaml`: direct path maps, unknown
account/tree, duplicate paths across accounts, noncanonical or nonabsolute
paths, account/TreeID mismatch, malformed extended values, and safe retention
of the last valid snapshot.

**Gate**:

```sh
bun run test:protocol
bun test tests/unit/trees.test.ts tests/unit/wire tests/integration/self-sync.test.ts
swift test --package-path native/Packages/ArborWire
git diff --check
```

At this milestone the default data home still loads through the existing
singleton adapter; the new parser is tested against fixtures and temporary
homes only.

### 2. Introduce account identity behind the singleton adapter

Add one explicit account record type keyed by configuration `TreeID`. It owns
the Canopy origin, allocated account locator, profile TreeID, configuration checkout location,
account-scoped credential reference, current local DeviceID, and safe derived
status. Do not reuse the external database `ConnectionStore` or its
`system:connections` secret namespace.

Make Wire-client construction, remote tree-list caching, update queues,
watch/reconnect state, diagnostics, and credential lookup accept account
identity. Cache an account-visible response by configuration `TreeID` plus
endpoint/revision inputs, never origin alone. Keep a compatibility adapter that
presents the one existing account to unchanged callers.

**Gate**: all old singleton integration tests pass unchanged, plus a unit test
proves two accounts at one origin use different credentials and independent
caches.

### 3. Make Canopy account semantics match the new graph

Implement `account-config-v2` complete-graph validation and semantic
authorization. Change account-local pairing to append one entry to
`devices.yaml` with no placement. Change activation to require the current
credential to be an administrator of the declaring account, not to have a
server-visible placement.

Implement the local-first and optional existing-profile proof contract from
[the spec](../../../spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key):
a short-lived proof binds target origin, complete account locator, profile TreeID, configuration
TreeID, and expiry; the target verifies it once and stores no profile locator.
The account claim accepts no profile snapshot and creates no profile tree or
canonical boundary. Hosting the profile later uses ordinary declaration and
`base: null` activation. Keep the old atomic profile claim only in a named,
removable v1 compatibility adapter.

Test all authorization changes as current-root transitions: ordinary-device
label edit, forbidden promotion/revocation, administrator promotion/demotion,
last-admin rejection, deletion/credential revocation, retired-ID rejection,
and revocation winning a concurrent edit.

**Gate**:

```sh
bun test tests/unit/canopy tests/integration/canopy tests/integration/self-sync.test.ts
bun run test:protocol
git diff --check
```

Use disposable Canopies only. Do not deploy or migrate a persistent host here.

### 4. Add plural storage for fresh temporary homes

Teach a fresh opted-in temporary data home to create:

- `accounts/<ConfigurationTreeID>/` as the source-preserving synchronized
  checkout for each account;
- one local `placements.yaml`;
- account-keyed private state and credential references beneath `.state`.

Reject a directory whose name disagrees with the synchronized configuration
TreeID learned from authenticated account metadata. Watch each account checkout
and `placements.yaml` independently. A malformed file freezes only the affected
accepted projection while preserving safe diagnostics; it must not make other
accounts disappear.

Retain one process, one local REST origin, and one supervision identity. Do not
run a daemon per account.

**Gate**: a temporary home with two accounts at one origin and a third at
another origin survives restart, preserves exact YAML source, routes every
credential correctly, and never touches the default home.

### 5. Route trees and placements by account

Resolve every placed tree through the surrounding configuration `TreeID`.
`TreeID` alone is insufficient routing context because the same profile tree
may be referenced by several account graphs and account-visible operations at
one origin require different credentials.

Apply local placement edits independently of account configuration. Validate
all paths before changing the active set. Unplacing stops replication and
leaves files and remote state intact. Declaring, renaming, changing ACLs, or
canceling an uninitialized tree edits only the owning account's `trees.yaml`.
Ambiguous commands require an explicit account selector and never guess.

**Gate**: tests cover same-origin accounts, same profile across Canopies,
independent offline recovery, no cross-account declaration edit, duplicate path
rejection, managed replica paths, and one account failing without stalling the
others.

### 6. Make REST, CLI, web, and macOS presentation list-shaped

Expose a list of accounts containing safe configuration ID, Canopy, optional
Canopy-specific presentation name,
profile TreeID, credential availability, device ID, and derived status. Tree
descriptors and mutations carry enough account context to route same-origin
accounts. Preserve singular response compatibility only where it is
unambiguous and bounded; return a precise ambiguity error otherwise.

Present one profile identity with its Canopy accounts beneath it. Do not offer
profile switching within an account. Update tree declaration, placement,
unplacement, ACL, device-list, and revoke surfaces to show or require the
account when needed. Keep the current one-account QR payload working;
Interface 006 moves that action onto each account and makes repeated iOS scans
durable.

Update `docs/local-system.md`, `docs/arborsync-api.md`, `docs/client.md`, and
`docs/cli.md` only when the corresponding behavior is implemented, so reference
documentation continues to describe the running code rather than the plan.

**Gate**:

```sh
bun run typecheck
bun run test
bun run build
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborSync
```

Complete the applicable native package/app build commands documented at HEAD.

### 7. Qualify two Canopies without cutting over

In an isolated temporary home, create one local profile identity, claim and
host it on Canopy A through the standard declaration/activation flow, then use
the one-time proof to associate that same profile `TreeID` with an account on
Canopy B. Host different trees at full canonical URLs under both account
namespaces. Also create a second account at one of the same origins.

Prove:

- all account configuration checkouts independently round-trip and merge;
- the secondary account works without hosting or copying the profile tree;
- canonical and raw TreeID resolution agree for each hosted tree;
- restart and offline/online transitions do not cross credentials or queues;
- an administrator activates a declared tree from an initial snapshot without
  a synchronized placement;
- local placements resume from the correct account after restart;
- logs, errors, events, QR data, and fixtures expose no raw credential or proof.

Keep the test Canopies and home disposable. This is a release qualification,
not evidence that a persistent installation has migrated.

### 8. Build and rehearse the one-time migration artifact

Create the next available numbered directory under `migrations/` at execution
time. It must contain the common `README.md`, `run.ts`, `migrate.test.ts`, and
rehearsal evidence required by [`migrations/README.md`](../../../migrations/README.md).
It must not import runtime packages from its own directory or add a permanent
CLI/startup migration path.

The artifact must have explicit Canopy-root and local-data-home modes; it must
never guess the target kind from a partially matching directory. For every
selected Canopy root it must:

1. verify the exact database/schema stamp, configured public origin, object
   store, and complete set of governed account trees;
2. rewrite each v1 account root into flat `account.yaml`, `trees.yaml`, and
   `devices.yaml`, preserving account/configuration/profile/tree/DeviceIDs,
   credential bindings, ACL subjects, canonical boundaries, and authored
   labels while dropping every synchronized placement;
3. turn each path-only canonical boundary into a full URL at that account's
   configured Canopy origin, while omitting the legacy handle from v2
   `account.yaml` and preserving its allocation in community policy;
4. validate every v2 graph, store all immutable objects before the transaction,
   install one `restored` accepted root per changed configuration tree, update
   policy/schema stamps atomically, and emit only safe IDs and roots;
5. verify account authentication, device revocation, hosted-tree reachability,
   and canonical resolution after reopening under the production build.

For every selected local data home it must:

1. acquire the daemon/process lock and validate the exact legacy graph, current
   account metadata, configuration `TreeID`, credential reference, and source
   stamp;
2. snapshot and checksum the source home to an explicit recoverable backup;
3. stage `accounts/<ConfigurationTreeID>/` with converted `account.yaml`,
   `trees.yaml`, and `devices.yaml` while preserving semantic identity and
   authored scalar values where representable;
4. extract only the current machine's placement paths into staged
   `placements.yaml`, grouped by configuration `TreeID`;
5. stage account-keyed credential/private metadata without printing secrets;
6. validate the complete target and perform an atomic same-volume swap;
7. reopen through the production code, authenticate, pull, push a reversible
   probe, restart, and verify the backup can restore the source layout.

The runner must refuse mixed layouts, multiple plausible legacy accounts,
missing credentials, invalid or duplicated paths, configuration-ID mismatch,
unknown schema stamps, or a destination that already exists. Exact rerun after
success must report already migrated without mutation.

Rehearse on a sanitized copy of the real shape and on corrupt/partial fixtures.
Record timestamps, commands, source/target stamps, checksums, safe IDs, restart
evidence, and rollback evidence without raw credentials or private content.

**Gate**: migration tests and rehearsal pass, the default home remains
unchanged, and the artifact is independently reviewable.

### 9. Explicitly authorize and perform cutover

Stop before this milestone and ask for explicit approval naming the target data
home and persistent Canopy instances. Do not infer authorization from approval
of the plan or readiness code.

At cutover, follow the repository migration procedure's backup, rehearsal,
maintenance-mode deployment, verification, and retention order. In particular:

1. confirm migration 002's remaining client/decoder prerequisites are closed;
2. archive and checksum the live Canopy, restore two local rehearsal copies,
   and confirm the final report/root set still matches the rehearsal;
3. snapshot authored local files and `~/.arbor`, stop the supervised daemon,
   and ensure the iPhone is not writing;
4. deploy the new server into schema-stamped maintenance mode, run the reviewed
   Canopy-root migration, redeploy, and verify health and safe report roots;
5. run the reviewed local-data-home migration while the daemon is stopped;
6. start the new daemon and verify account enumeration, authentication,
   configuration roots, placements, canonical resolution, push/pull, and
   restart behavior;
7. update/re-place the iPhone last and verify its account-scoped credentials;
8. keep the checksummed server and local backups for the declared observation
   window and record the live evidence in the migration directory.

Rollback uses the artifact's rehearsed restore procedure while all new writers
are stopped. Do not attempt a mixed old/new writer period.

## Verification matrix

| Surface | Required evidence |
|---|---|
| Portable YAML | TypeScript and Swift conformance accept the same direct maps and reject old/ambiguous shapes |
| Account identity | two accounts at one origin and one profile across two Canopies remain distinct and routable |
| Authorization | ordinary/admin device semantic diffs, last-admin safety, revocation precedence, activation without placement |
| Local layout | fresh temporary plural home, source preservation, safe invalid-file fallback, restart |
| Placement | local-only paths, global duplicate rejection, explicit managed paths, unplacement without deletion |
| Network | account-keyed credentials, caches, watches, queues, diagnostics, offline recovery |
| Presentation | list-shaped REST/CLI/web/macOS state and explicit ambiguity handling |
| Migration | fixture tests, sanitized rehearsal, atomic swap, exact rerun, rollback, secret-safe evidence |

## Out of scope

- bulk or multi-account QR pairing beyond the implemented one-account-at-a-time
  Interface 006 flow;
- account recovery after all administrator devices are lost;
- profile ownership transfer or identity merger;
- account roles or a second account species;
- cross-Canopy canonical parent/child boundaries or server-to-server execution;
- moving an active hosted tree between Canopies;
- production high availability, DNS cutover, and remote tree deletion;
- several local placements of the same hosted tree on one device.

## Done criteria

- [x] The revised account/configuration grammar has a strict TypeScript model, replacement shared conformance vectors, and safe native REST/Wire projections.
- [x] A single daemon safely connects several configuration-TreeID-keyed accounts, including same-origin accounts.
- [x] Several accounts may reference one profile TreeID without copying or redefining it.
- [x] Every new profile begins with a durable local TreeID and gains a canonical URL only through ordinary declaration/activation.
- [x] Each account checkout is authoritative for its own declarations and devices; no aggregate declaration projection exists.
- [x] `placements.yaml` is local-only and groups canonical paths by account configuration TreeID.
- [x] Server activation uses account administration plus declaration, never a synchronized path.
- [x] REST, web, and macOS surfaces expose explicit account context; pre-migration CLI writes fail instead of guessing in a plural home.
- [x] Disposable same-origin and two-Canopy qualification passes before any persistent cutover.
- [x] The one-time migration artifact has tests, rehearsal evidence, rollback, and no runtime/CLI coupling.
- [x] Persistent cutover occurs only after separately recorded explicit authorization.
- [x] The migrated Mac and iPhone use account-scoped credentials and remain usable after restart.

## STOP conditions

- A readiness change would rewrite the default data home or persistent Canopy.
- Account-visible state is keyed only by origin, Canopy-local handle, profile TreeID, or a local directory label.
- A raw credential, pairing secret, profile proof, or local path would enter synchronized YAML, Wire content, logs, or diagnostics.
- One account can mutate another account's declarations, ACLs, devices, credential binding, or canonical namespace.
- The implementation needs an aggregate editable declarations file or source-rewriting fanout.
- A secondary Canopy must host or copy the profile tree merely to host account trees.
- Old and new writers would concurrently target the same persistent state.
- The migration cannot prove exact source format, atomic replacement, restart, and rollback.

## Handoff note

Milestones 0–9 and Interface 006 are implemented, the migration-002 decoder
compatibility window is closed, and migration 003 has cut over the authorized
persistent Canopy, default Mac home, and iPhone with recorded verification
evidence. Preserve the migration backups through the two-week observation
window; no implementation or cutover work remains for Interface 005.
