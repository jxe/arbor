# Interface 005: Use multiple Canopy accounts through one Arbor Sync

> **Executor instructions**: Follow the milestones and gates in order. Run
> every verification command and confirm the expected result before advancing.
> If a STOP condition occurs, stop and report instead of inventing federation,
> distributed transactions, a shared credential, or a second local daemon.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat ab139c6..HEAD -- \
>   spec/01-tree-operations.md spec/04-accounts-and-devices.md spec/05-access-control.md conformance \
>   docs/local-system.md docs/arborsync-api.md docs/client.md docs/cli.md \
>   packages/stores packages/arborsync packages/client packages/cli packages/render \
>   native/Packages/ArborSync native/Packages/ArborClient native/ArborApp \
>   tests/unit/trees.test.ts tests/integration/self-sync.test.ts \
>   tests/integration/cli-sync.test.ts tests/integration/canopy/update-host.test.ts
> ```
>
> Compare any changed in-scope code with the current-state evidence below. If
> the ownership boundary, configuration graph, pairing protocol, or native
> credential model has already changed incompatibly, stop and reconcile this
> plan before implementation.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: completed native Plan 010 and the implemented account-configuration/self-sync foundation
- **Category**: interface, configuration, migration
- **Planned at**: commit `ab139c6`, 2026-08-29
- **Progress**: PLANNED

## Target result

One supervised local Arbor Sync daemon can connect to several Canopy accounts,
including several accounts at one origin, and independently synchronize trees
owned by those accounts. `${ARBOR_DATA_HOME:-~/.arbor}/trees.yaml` is the one
user-editable local tree manifest. Each Canopy account retains its own private,
server-governed account-configuration tree, device membership, credential,
accepted history, ACLs, and canonical namespace.

The macOS Arbor app can create one QR bundle for selected connected accounts.
One scan registers the iPhone separately with every selected account, using a
distinct account-scoped `DeviceID` and credential for each claim. Partial
success is durable and retryable. Registration does not automatically place or
download every tree; the iPhone chooses placements afterwards from a combined,
account-grouped list.

## Fixed product and architecture decisions

These decisions are requirements, not open implementation questions:

1. **One local daemon, several remote accounts.** Do not start one Arbor Sync
   process or use one `ARBOR_DATA_HOME` per Canopy.
2. **Configuration `TreeID` is connection identity.** Origin, handle, label,
   and directory names are mutable or non-unique. Persist and route a Canopy
   account connection by its private account-configuration `TreeID`.
3. **One user-editable local `trees.yaml`, several governed remote graphs.**
   The local file is a semantic aggregate/projection. It is not one Arbor tree
   replicated byte-for-byte to every Canopy. Comments and cross-account order
   are local; tree declaration and placement semantics route to the owning
   account configuration.
4. **Canopy remains account-local.** Retain the rule that a placement inside an
   account configuration names that account's Canopy origin. Do not let one
   account configuration reserve trees, rewrite boundaries, or administer ACLs
   on another Canopy.
5. **No cross-server nested canonical boundaries.** Independent trees may be
   visible in one reader-local workspace, but a canonical child tree and its
   canonical parent must be hosted by the same Canopy for this milestone.
6. **Credentials and devices are account-scoped.** Pairing one physical
   installation creates a fresh credential and `DeviceID` per account. Do not
   reuse a raw credential or a remotely visible global installation identifier
   across accounts.
7. **Pairing bundles are orchestration, not a Wire transaction.** Arbor Sync
   creates and claims ordinary short-lived, single-use Canopy pairing offers.
   Success on one account is not rolled back because another account is
   offline, rejects, or expires.
8. **Registration and placement remain separate.** A pairing claim initially
   adds the device with no placements. The person explicitly selects trees to
   materialize on the iPhone afterwards.
9. **Preserve version-1 pairing during migration.** Existing single-account QR
   payloads remain decodable while version 2 is introduced and qualified.
10. **Do not overload external data connections.**
    `packages/stores/src/connections.ts` is the named PostgreSQL connection
    store behind `system:connections/<name>`. Introduce an explicitly named
    Canopy-account store; do not repurpose `ConnectionStore` or its secret
    namespace.

## Aggregate `trees.yaml` contract

The normative specification pass may refine scalar names, but it must preserve
this structure and deletion semantics:

```yaml
version: 2
trees:
  tr_example:
    connection: tr_account_configuration
    server: https://garden.example
    declaration:
      kind: shared-subtree
      canonicalPath: /~joe/example
      access: []
    placement:
      path: /Users/joe/Documents/Example
```

- `connection` is the owning account-configuration `TreeID` and is immutable
  after an active tree is associated with it.
- `server` is the normalized current Canopy origin projected from the
  connection record. A direct edit may select a connection only when creating
  a new declaration; it may not silently transfer an active tree.
- `declaration` projects that account's governed `trees.yaml` entry. Canopy
  continues to own validation and accepted state for `kind`, `canonicalPath`,
  and `access`.
- Missing `placement` means this device does not materialize the tree.
- `placement: {}` requests an implementation-managed durable writable replica.
- `placement.path` is the current device's canonical absolute filesystem path.
- Removing `placement` stops local replication without deleting files, remote
  identity, ACLs, history, or the declaration.
- Removing an active declaration remains invalid. Removing an uninitialized
  reservation retains the current governed cancellation semantics.
- A valid edit spanning several connections becomes independent updates to the
  relevant configuration trees. Accepted connections stay accepted; offline
  connections retain local pending intent; authorization/protocol rejection
  restores that connection's accepted projection and emits a precise
  diagnostic.
- A syntactically invalid whole file retains the previous valid active
  aggregate, matching the existing live-configuration safety rule.
- Duplicate `TreeID`s, duplicate local paths, an unknown connection, a
  connection/origin mismatch, and a cross-Canopy canonical parent/child
  relationship are blocking diagnostics. Arbor Sync never guesses routing.

The private implementation may retain exact account-configuration source and
immutable objects under `.state/accounts/<ConfigurationTreeID>/`. Those are
private replicas, not additional user-editable configuration checkouts. Remote
source-preserving edits must continue preserving unrelated comments and order
inside each governed account graph even though cross-account ordering in the
aggregate file is local.

## Pairing bundle contract

Version 2 is a local Arbor pairing envelope. It does not replace either Canopy
Wire pairing endpoint:

```json
{
  "version": 2,
  "connections": [
    {
      "configurationTree": "tr_account_configuration",
      "origin": "https://garden.example",
      "account": "ac_example",
      "handle": "joe",
      "communityURL": "arbor://garden.example/",
      "pairing": {
        "id": "pa_example",
        "secret": "<short-lived one-use secret>",
        "confirmationCode": "123456",
        "expiresAt": 1788012345000
      }
    }
  ]
}
```

Requirements:

- Sort entries by configuration `TreeID` before encoding and reject duplicate
  configuration IDs or duplicate pairing identities.
- Normalize and validate each HTTPS origin. Bind every pairing entry to the
  account metadata fetched with the credential that created it.
- Include no existing account/device credential, access-link secret, private
  state path, local placement path, or unrelated configuration.
- Derive one six-digit bundle confirmation code from a shared canonical
  encoding of the complete ordered version-2 payload. Both devices calculate
  it independently. Continue validating each Canopy claim's returned
  per-account confirmation code against its entry.
- Generate and durably save each new account credential before its claim, as
  version 1 does. Persist the generated `DeviceID`, credential reference, and
  claim state per connection so an uncertain response retries the exact claim.
- Exact retry after a lost response uses the same pairing ID, secret,
  `DeviceID`, label, and credential digest. An expired or definitively rejected
  entry obtains a fresh offer for only that connection.
- QR generation must enforce a bounded payload size. If selected accounts do
  not fit, the Mac asks the person to select fewer accounts; do not introduce a
  public secret-bearing broker URL or upload pairing secrets elsewhere.
- The default Mac selection is all credential-available connections, but the
  sheet lists community/account identity and permits deselection before offer
  creation.

## Current state to reconcile

The executor must open and confirm these facts before editing:

- `spec/04-accounts-and-devices.md` (configuration graph and YAML) defines one
  `account.yaml`/`trees.yaml`/`devices/` graph per account. `trees.yaml` owns
  declarations and ACLs; the current device file owns placements.
- `packages/canopy/src/account-policy.ts:73-88` rejects undeclared placements
  and placements whose server differs from `account.community`. Preserve that
  protection.
- `packages/stores/src/server-config.ts:6-170` stores one
  `system/community.md` record and one data-home-keyed OS credential.
- `packages/stores/src/account-config.ts:219-274` stores one current device and
  loads one physical root configuration checkout.
- `packages/stores/src/trees.ts:63-120` joins that single configuration and
  singleton community record into the local placement registry.
- `packages/arborsync/src/service.ts:726-775,897-914` fetches one account for
  the system projection and exposes a singular `configuredWire()` helper.
- `packages/arborsync/src/service.ts:1398-1439` is already partly plural: it
  iterates placements, creates a client per endpoint, and caches remote tree
  lists by origin. Its credential lookup remains singleton and must become
  connection-specific; caching solely by origin is insufficient when two
  accounts at one Canopy see different tree sets.
- `packages/arborsync/src/server.ts:418-458` returns one `deviceID` and exposes
  singular claim, pairing, and forget bootstrap routes.
- `packages/cli/src/index.ts:305-330,475-579` installs one root checkout,
  replaces the singleton community record, and chooses a credential from the
  target origin. Promotion and placement must instead resolve an owning
  connection, requiring an explicit account selector when more than one
  connected account at an origin can administer the operation.
- `native/Packages/ArborSync/Sources/ArborSync/Credentials.swift:6-50` keys one
  Keychain credential only by origin. It cannot represent two accounts at the
  same Canopy.
- `native/Packages/ArborSync/Sources/ArborSync/Credentials.swift:71-121` accepts
  one origin/pairing, creates one `DeviceID` and credential, and saves before
  claiming. Preserve the save-before-claim and exact-retry safety properties
  while pluralizing them.
- `native/ArborApp/ArborAppModel.swift:343-385,524-543` reads singular local
  credential/account state and creates one QR payload.
- `tests/integration/self-sync.test.ts` is the existing two-device, one-Canopy
  synchronization pattern. `tests/integration/canopy/update-host.test.ts` is
  the pairing/revocation protocol pattern. Add a distinct two-Canopy fixture;
  do not weaken these tests or turn their one-account assertions into vague
  aggregate assertions.

## Commands and expected results

| Purpose | Command | Expected on success |
|---|---|---|
| Focused TypeScript | `bun test tests/unit/trees.test.ts tests/integration/multi-canopy-connections.test.ts tests/integration/self-sync.test.ts tests/integration/cli-sync.test.ts tests/integration/canopy/update-host.test.ts` | exit 0; all focused tests pass |
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| Full TypeScript | `bun run test` | exit 0; all unit and integration tests pass |
| Protocol | `bun run test:protocol` | exit 0; TypeScript/Swift conformance passes |
| Build | `bun run build` | exit 0 |
| Swift ArborSync | `swift test --package-path native/Packages/ArborSync` | exit 0; all tests pass |
| Swift ArborClient | `swift test --package-path native/Packages/ArborClient` | exit 0; all tests pass |
| macOS app | `xcodebuild test -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' -derivedDataPath /tmp/arbor-multi-canopy-macos CODE_SIGNING_ALLOWED=NO` | exit 0 |
| iOS app | `xcodebuild build-for-testing -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/arbor-multi-canopy-ios CODE_SIGNING_ALLOWED=NO` | exit 0 on the existing iOS 27 simulator |
| Diff hygiene | `git diff --check` | exit 0, no whitespace errors |

Run macOS and iOS Xcode commands sequentially. Use only the existing iOS 27
simulator; if it is unavailable, stop and report rather than creating another.

## Scope

### In scope

- Normative and reference contracts:
  - `spec/01-tree-operations.md`
  - `spec/04-accounts-and-devices.md`
  - `conformance/configuration-yaml.json`
  - `docs/local-system.md`
  - `docs/arborsync-api.md`
  - `docs/client.md`
  - `docs/cli.md`
  - `docs/reference-implementation.md`
  - `README.md`
- Local account/configuration stores and migration:
  - `packages/stores/src/account-config.ts`
  - `packages/stores/src/server-config.ts` or its explicitly named replacement
  - `packages/stores/src/trees.ts`
  - `packages/stores/src/private-state.ts`
  - `packages/stores/src/index.ts`
  - new focused Canopy-account store/projection modules under `packages/stores/src/`
- Local daemon, clients, CLI, and account UI:
  - `packages/arborsync/src/service.ts`
  - `packages/arborsync/src/server.ts`
  - `packages/arborsync/src/tree-manager.ts`
  - focused sync-state modules when connection identity must be persisted
  - `packages/client/src/index.ts`
  - `packages/cli/src/index.ts`
  - `packages/render/src/App.tsx` and focused presentation types/styles
- Native connection, pairing, placement, and presentation code:
  - `native/Packages/ArborSync/`
  - focused Local Arbor REST additions in `native/Packages/ArborClient/`
  - `native/ArborApp/ArborAppModel.swift`
  - `native/ArborApp/ArborRootView.swift`
  - focused native tests and fixtures
- Focused unit, integration, protocol, and migration tests under `tests/` and
  `conformance/`, including a new
  `tests/integration/multi-canopy-connections.test.ts`.

### Out of scope

- Cross-Canopy canonical parent/child boundaries, redirects, aliases, or remote
  resolution federation.
- One account configuration governing another Canopy's reservations, ACLs, or
  accepted refs.
- Atomic commit, rollback, or consensus across Canopies.
- Shared raw credentials, shared remotely visible installation identity, or
  credential transfer between accounts.
- Automatically placing every tree during pairing.
- Claim recovery, disputes, all-device-loss recovery, or administrator reset.
- Moving one active `TreeID` between Canopies.
- Canopy high availability, replication, backup/restore, or server migration.
- Reusing `packages/stores/src/connections.ts`, which remains exclusively the
  external/PostgreSQL connection store.
- Completing Interface 004's browser E2E before this account and pairing
  surface settles. Interface 004 follows this milestone.

## Git workflow

- Branch: `codex/interface-005-multi-canopy-connections`
- Use focused commits at milestone gates. Match the repository's imperative
  message style, for example `Advance sync base beneath local edit tails`.
- Do not push, deploy, pair a real device, migrate the default Arbor home, or
  touch production Canopy data without explicit operator authorization.
- Preserve unrelated working-tree changes and stage only files owned by this
  plan.

## Milestone A: Specify and implement plural account connections

### A1. Update the contracts before runtime behavior

Revise the configuration, Wire, local-system, client, CLI, and REST documents
to state the fixed decisions above. Keep the portable Canopy account graph
account-local. Specify the aggregate version-2 local `trees.yaml` separately
from the private governed graph so readers cannot mistake it for one
cross-server synchronized tree.

Keep `conformance/configuration-yaml.json` focused on the portable governed
account graph. Add a separate `conformance/local-trees-yaml.json` for valid
aggregate entries, pathless placement, unplaced declared trees, duplicate
TreeID/path, unknown connection, connection/origin mismatch, forbidden
active-tree transfer, and invalid YAML retaining the last valid aggregate.

**Verify**: `bun run test:protocol` -> all existing and new conformance cases pass
before runtime call sites switch.

### A2. Replace the singleton community store with an account-scoped store

Introduce a store whose API lists, gets, adds, removes, and reports credential
availability for Canopy accounts keyed by configuration `TreeID`. Store safe
records under `.state/accounts/<ConfigurationTreeID>/` and raw credentials in
the OS credential store using a connection-specific key. Persist current
`DeviceID` per account.

Keep provisional bootstrap credentials connection-attempt-scoped until the
server returns the configuration `TreeID`; then atomically promote them to the
stable connection key. Never overwrite another account at the same origin.

Provide a one-way, idempotent migration from `system/community.md`, its current
credential reference, root `.state/device.json`, and the root configuration
checkout. Validate the configuration snapshot and credential/account binding
before committing migration. Preserve a recoverable backup beneath
`.state/migration/`; do not merge ambiguous or conflicting destinations.

**Verify**: focused store/migration tests prove zero-, one-, two-, and
same-origin-two-account cases; interrupted migration resumes exactly; a
collision fails without deleting source state or secrets.

### A3. Aggregate connections without yet changing pairing UX

Teach `loadTreeRegistry`, `TreeManager`, system projection, synchronization,
remote browsing, conflict resolution, and account operations to resolve a
credential by connection, not merely origin. Cache remote lists by connection
identity; two credentials at one origin may see different trees.

Expose safe `system:` account records without secrets. `GET /v1/trees` remains
one aggregate tree list and may contain several `account-configuration`
descriptors. Replace singular helpers such as `configuredWire()` with explicit
`clientForConnection`/`connectionForTree` boundaries. Preserve the current
one-daemon lifecycle and loopback-host protections.

Update CLI connection behavior:

- `arbor connect <server>` adds or refreshes the authenticated account returned
  by that credential.
- `arbor forget`/disconnect identifies one configuration connection; omission
  is allowed only when exactly one exists.
- An existing tree resolves its owning connection by `TreeID`.
- A new canonical promotion chooses by canonical server when one connected
  account can administer it; require an explicit configuration/account option
  on ambiguity rather than selecting by iteration order.

**Verify**: the new two-Canopy integration test synchronizes one writable tree
through each connection, takes Canopy A offline while B continues, restarts
Arbor Sync, and proves refs, accepted updates, authored bytes, credentials, and
diagnostics stay connection-correct.

## Milestone B: Make one aggregate `trees.yaml` the editing surface

### B1. Build a source-preserving aggregate projection

Parse and watch version-2 `${ARBOR_DATA_HOME}/trees.yaml`. Materialize every
declared remote tree from every connected account once, annotated with its
owning connection and current-device placement. Retain exact remote
account-configuration sources privately so an aggregate edit can apply a
source-preserving YAML transformation to only the owning account graph.

Do not rebuild the aggregate file blindly on every remote observation. Patch
owned entries while preserving unrelated local comments and ordering. Define a
deterministic insertion position for newly observed trees. Persist enough
projection provenance privately to distinguish the last accepted remote
semantics, current aggregate semantics, and pending local intent after restart.

**Verify**: unit tests cover comment/order preservation, two accounts changing
independently, remote insertion, local placement removal, pathless placement,
active declaration deletion rejection, and restart with pending intent.

### B2. Route aggregate edits into ordinary configuration-tree updates

Diff by `TreeID` and connection. For each changed connection, update its private
account-configuration workspace and use the existing accepted-update sync path.
Do not add a global execution ID, acknowledgement protocol, or cross-server
transaction. Existing per-tree pending/conflict durability owns each account
configuration update.

When an update succeeds, project accepted state. When offline, keep that
connection's intended state pending. On a definitive authorization/protocol
rejection, restore only that connection's accepted fields and emit a diagnostic
that names the connection and tree without exposing credentials.

The local aggregate must reject a tree whose canonical ancestor resolves to a
different Canopy. Reader-local filesystem composition remains allowed and must
not be mistaken for a canonical parent/child relationship.

**Verify**: one valid file save modifies two accounts; A accepts while B is
offline; B accepts after reconnect; a later unauthorized edit to B reverts only
B; A never emits a duplicate accepted update.

### B3. Complete migration to the single visible file

Migrate a valid existing root `account.yaml`, governed `trees.yaml`, and
`devices/` into the private account replica, then write the version-2 aggregate
`trees.yaml` at the root. Do not move any authored tree directory or
implementation-managed replica. Do not leave compatibility symlinks that make
the aggregate and governed files appear interchangeable.

Migration must be restart-idempotent, preserve file modes, verify semantic
equivalence before removing/moving old visible files, and retain a bounded
recoverable backup. An explicit `ARBOR_DATA_HOME` follows the same format but
remains an isolated foreground home.

**Verify**: fixture migration preserves account graph semantics, all placement
paths, device identity, configuration ref/update, sync metadata, pending
updates/conflicts, and authored tree byte manifests.

## Milestone C: Pair selected accounts with one QR bundle

### C1. Add local bundle creation without changing Canopy pairing

Add a Local Arbor REST operation that accepts selected configuration `TreeID`s,
loads each credential, and requests ordinary pairing offers concurrently with
a bounded timeout. Return one version-2 payload and aggregate confirmation
code. Keep the existing singular route and client methods for version-1
compatibility during migration.

Do not add a Canopy bundle endpoint. Do not log or persist returned pairing
secrets beyond the private short-lived state needed to render/retry the bundle.
Expired bundle state must be pruned with the same care as ordinary pairing
attempt state.

**Verify**: TypeScript client/server tests cover selected subset, unavailable
credential, offline account, duplicate selection, stable ordering, bounded
payload, expiry, redacted errors, and unchanged version-1 behavior.

### C2. Make native credentials connection-scoped

Change Swift credential APIs and Keychain account keys from origin-only to a
stable connection key containing the configuration `TreeID` and normalized
origin. Add a safe one-time migration for an existing origin-keyed credential
after authenticating it and learning its configuration `TreeID`. Never delete
the legacy credential until the new item can be read back and validated.

Represent a local installation as a private collection of account bindings,
not one remotely shared device identifier. Generate and persist a separate
`DeviceID` and credential before each claim. Store per-entry state so exact
retry survives app termination or an uncertain network response.

**Verify**: Swift tests cover two origins, two accounts at one origin,
save-before-claim, exact replay, app termination between save and claim,
legacy credential migration, forget-one-account, and no cross-account secret
lookup.

### C3. Claim independently and report partial completion

Decode both payload versions. For version 2, validate all entries before making
network calls, display the aggregate confirmation code, then claim entries with
bounded concurrency. Verify each returned per-account confirmation code.

Persist and present `pending`, `connected`, `retryable failure`, and definitive
failure by connection. Never revoke successful claims because another entry
failed. A retry obtains a new offer only for entries that definitively need one;
uncertain exact claims reuse their original identity and credential.

After registration, fetch writable trees from each connected account and show
one combined chooser grouped by community/account. Selecting a tree creates
only that account's placement/private replica.

**Verify**: a disposable two-Canopy test pairs both accounts, repeats with one
offline, resumes after restart, repeats with one expired offer, and proves
successful accounts never duplicate device rows or lose credentials.

## Milestone D: Product integration, qualification, and rollout

### D1. Replace singular account presentation

Update macOS Arbor, iOS Arbor, Arbor web, and Local REST presentation types to
list connections and devices explicitly. The Mac pairing sheet selects
credential-available accounts and says how many will be paired. The iPhone
shows per-account progress and groups the tree chooser by community/account.

Forget and revoke remain account operations. A convenience “remove this device
from selected accounts” action may fan out, but it must report each result and
must not claim atomicity. Pairing-created devices remain ordinary rather than
administrators.

**Verify**: component/model tests cover zero, one, multiple, same-origin,
offline, partial-pairing, revocation, and forget states without exposing secret
payload fields in snapshots or error text.

### D2. Run the complete automated gates

Run the commands table above. Fix failures within scope without weakening
pairing expiry, one-use semantics, digest-only server storage, device
revocation, account-config authorization, local durability, or exact retry.

After Interface 005 is stable, update Interface 004's browser plan against the
new account list and pairing-bundle UI. Keep browser artifacts secret-free;
do not restore its old assumption that one fixed pairing payload is the final
surface.

### D3. Perform authorized migration and exact-artifact acceptance

Follow [the migration procedure](../../migrations/README.md): rehearse on copies with the
reusable tools, quiesce writers rather than the server, and put this migration's runbook,
script, and rehearsal log in its own `migrations/NNN-<name>/` directory for later deletion.

Only after explicit operator authorization:

1. Back up the default Arbor home and record semantic/account/tree/ref/update
   manifests without exposing credentials.
2. Run the migration on a disposable copy first and prove repeat execution is
   a no-op.
3. Connect a disposable second Canopy and qualify independent sync/offline
   behavior without changing production tree bytes.
4. Build exact macOS and iOS 27 artifacts sequentially.
5. Pair through the QR bundle, verify one aggregate confirmation code, select
   one tree per account, exercise partial retry, and revoke the disposable
   device bindings.
6. Compare final authored byte manifests, configuration semantics, refs,
   updates, pending/conflict state, credential availability, and SQLite
   integrity with the pre-migration evidence.

Do not deploy Canopy changes merely because this local milestone lands. The
first implementation should reuse existing Canopy account-local pairing and
configuration behavior.

## Test plan

Create or extend tests at these layers:

- `tests/unit/trees.test.ts`: version-2 aggregate parser, strict validation,
  source preservation, placement forms, duplicate/unknown/mismatch cases, and
  last-valid retention.
- New `tests/integration/multi-canopy-connections.test.ts`: two Canopies, two
  independent accounts/credentials/configuration trees, same-origin distinct
  accounts where the fixture supports it, offline isolation, restart, fan-out
  edits, conflict/rejection isolation, and exact authored bytes.
- `tests/integration/cli-sync.test.ts`: connect adds, explicit disconnection,
  endpoint/account ambiguity, correct promotion routing, and no replacement of
  an existing connection.
- `tests/integration/self-sync.test.ts`: retain the existing one-account
  two-device guarantees as a regression baseline.
- `tests/integration/canopy/update-host.test.ts`: retain ordinary one-offer,
  one-claim, revocation, expiry, and idempotent replay guarantees. Add no
  distributed bundle semantics to Canopy.
- `packages/client` and `native/Packages/ArborClient` tests: Local REST account
  lists, pairing-bundle creation, per-connection forget/revoke, and safe errors.
- `native/Packages/ArborSync` tests: version-1/v2 payload decoding,
  connection-scoped Keychain keys, migration, separate identity/credential per
  account, partial completion, exact retry, and combined placement selection.
- Arbor app model/view tests: selected-account QR creation, aggregate code,
  grouped results and trees, partial failure, retry, and no secret-bearing
  snapshots/logs.
- Migration fixtures: clean legacy home, already migrated home, interrupted
  staging, missing credential, malformed config, destination collision, and
  populated unrelated `.state` content.

## Done criteria

All conditions must hold:

- [ ] The normative docs distinguish one local aggregate manifest from one
      private governed account-configuration tree per Canopy account.
- [ ] One Arbor Sync daemon synchronizes independent writable trees through two
      Canopies and isolates an outage or rejection to the owning connection.
- [ ] Two accounts at one origin retain distinct credentials, account tree
      listings, devices, and operations.
- [ ] `~/.arbor/trees.yaml` is the only user-editable tree manifest; direct
      valid edits route to the correct account and preserve unrelated entries.
- [ ] Existing one-account homes migrate idempotently without moving or
      changing authored tree bytes.
- [ ] Cross-Canopy canonical nesting and active-tree transfer are rejected
      explicitly rather than partially working.
- [ ] One version-2 QR registers an iPhone independently with all selected
      available accounts using separate `DeviceID`s and credentials.
- [ ] Partial pairing success survives restart and retries without duplicating
      successful devices or rolling them back.
- [ ] Pairing does not automatically place trees; the combined chooser creates
      only explicitly selected placements.
- [ ] Existing version-1 QR pairing remains supported during the documented
      migration window.
- [ ] No raw credential, pairing secret, access-link secret, or private path
      enters logs, diagnostics, snapshots, fixtures, or checked-in artifacts.
- [ ] Focused TypeScript, full TypeScript, protocol, build, Swift package,
      sequential macOS/iOS, and `git diff --check` gates pass.
- [ ] Interface 004 is reconciled against the final multi-account browser
      surface before its E2E work begins.

## STOP conditions

Stop and report; do not improvise if:

- Supporting the aggregate file appears to require one Canopy to accept or
  administer another Canopy's tree declarations, ACLs, refs, or boundaries.
- A correct implementation requires cross-server atomic commit/rollback or a
  globally synchronized exact-byte `trees.yaml`.
- A tree already has conflicting owning connections or an existing canonical
  parent/child relationship spans Canopies.
- Migration cannot bind the legacy credential, device, and configuration tree
  uniquely without guessing.
- The only way to support two same-origin accounts would overwrite or share a
  credential, `DeviceID`, or private replica.
- QR bundling would require uploading pairing secrets to an intermediary or
  weakening the existing expiry/one-use/digest-only rules.
- Pairing partial failure cannot be represented without revoking successful
  claims or losing exact retry identity.
- Canopy source changes become necessary for more than focused compatibility
  or diagnostics; first reassess whether the implementation is drifting into
  federation.
- The existing iOS 27 simulator is unavailable for the final native gate.
- The default Arbor home or any production service would be migrated, paired,
  or mutated without explicit operator authorization.
- An in-scope source file has materially drifted from the current-state
  evidence and the plan no longer specifies the live architecture honestly.

## Maintenance notes

- Configuration `TreeID`, not origin or handle, remains the durable routing
  identity if a Canopy later changes domains.
- Adding true cross-Canopy nesting later requires an explicit federation plan
  for canonical resolution, boundary validation, access identity, availability,
  and failure semantics. Do not grow it incrementally from this local feature.
- A future account-recovery flow must restore each account binding separately;
  the pairing bundle is not a recovery credential.
- A future global installation grouping should remain private or use
  account-specific unlinkable derivations. Review any remotely visible grouping
  identifier as a privacy change.
- Reviewers should scrutinize connection-key lookups, same-origin ambiguity,
  migration deletion order, pending projection state, secret-bearing errors,
  and claims that multi-account operations are atomic.
- Interface 004 owns browser E2E after this surface stabilizes. It must retain
  the existing secret-redaction requirements while adopting plural accounts and
  pairing bundles.
