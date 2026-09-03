# Interface 006: Pair one Canopy account at a time on native devices

> Historical executor record. Implementation and live primary-path acceptance
> completed on 2026-09-03; current behavior is normative in the linked
> specifications.

> **Executor instructions**: Preserve pairing as a literal one-account grant.
> The Mac creates one ordinary account-local offer and one QR code; iOS scans
> and adds that one account. A person repeats the flow for another account. Do
> not introduce a multi-account envelope, bulk selection, cross-account
> transaction, shared credential, global device identity, or implicit tree
> placement. Persist the generated claim identity and secrets before network
> use so an uncertain response can retry the exact request.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 5344a52..HEAD -- \
>   spec/05-accounts-and-devices.md \
>   plan/history/interfaces/005-multi-canopy-connections.md \
>   packages/arborsync packages/client packages/render \
>   native/Packages/ArborWire native/Packages/ArborClient \
>   native/Packages/ArborSync native/ArborApp tests
> ```
>
> If Interface 005's account descriptor, configuration-TreeID credential key,
> local API, or account presentation changed, reconcile those exact contracts
> before implementation. Updating the planned-at commit alone is not enough.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH — the UI is small, but uncertain claim replay and credential
  re-keying are security and durability boundaries
- **Depends on**: Interface 005 milestones 2, 4, and 6: account-keyed
  credentials, plural local storage, and list-shaped local API/presentation;
  completed native Plan 010 for the account-local pairing protocol
- **Category**: interface, native, credentials
- **Planned at**: Arbor `5344a52`, 2026-09-03
- **Progress**: IMPLEMENTED AND LIVE-ACCEPTED — automated package and
  exact-artifact build gates pass; migration 003 cut over the persistent Canopy
  and default Mac home; the selected-account Mac-to-iPhone QR, explicit iOS
  placement, and restart path passed on the migrated real account. A second
  live account scan remains optional qualification when another account is
  available to this Mac.

## Outcome

Every Canopy account shown on macOS has its own **Pair another device…** action.
That action creates the existing short-lived account-local pairing offer and
displays one QR code. On iPhone or iPad, **Accounts → Add Account** scans the QR,
adds exactly that account, and returns to the account list. The person repeats
the flow for every additional account they want on that device.

Each successful scan creates a distinct account-scoped DeviceID and credential.
It creates no tree placement. Afterward, the person may enter the new account
and independently choose a hosted tree to materialize.

## Why this shape

The Canopy route already grants one device access to one account. Keeping the
human action at that same boundary makes confirmation, expiry, revocation,
retry, and errors attributable to one account. It removes bundle ordering,
payload limits, selected-account coordination, partial bundle success, and a
second confirmation-code layer. Bulk pairing can be reconsidered later only if
repeated scans prove to be a real problem.

## Fixed decisions

1. **One QR means one Canopy account.** The Mac action lives inside a selected
   account surface. iOS adds one account per scan.
2. **Keep the version-1 payload shape.** Continue encoding
   `{ version: 1, origin, pairing: { id, secret } }`. Do not add a version-2
   envelope merely because local account storage became plural.
3. **Use the account-local Wire routes unchanged.** Every QR is backed by one
   `POST /.arbor/pairings` offer and one
   `PUT /.arbor/pairings/{PairingID}/claim` claim.
4. **No account selector inside the QR.** The authenticated Mac account used to
   create the offer determines the account. PairingID remains server-side bound
   to it.
5. **Configuration TreeID is the final credential key.** Origin is network
   metadata and cannot distinguish two accounts at one Canopy.
6. **A pending claim may be keyed by origin plus PairingID.** Before the account
   is known locally, protected pending state holds the exact pairing secret,
   generated DeviceID, generated credential, digest, and label. After a
   successful/idempotent claim, iOS authenticates `GET /.arbor/account` with
   that credential, obtains the configuration TreeID, and re-keys the
   credential only after readback succeeds.
7. **Exact retry remains mandatory.** A lost response, app suspension, or
   process death must not generate a new DeviceID, credential, digest, label,
   or claim body for the same offer.
8. **Registration and placement remain separate.** Connecting an account does
   not choose, download, or create a tree placement.
9. **No installation identity crosses accounts.** One physical device may
   appear under the same human label, but each account sees only its own
   DeviceID and credential.
10. **Secrets remain local and redacted.** Existing credentials, pairing
    secrets, pending claim material, access-link secrets, local paths, and
    unrelated account configuration never appear in diagnostics, logs,
    snapshots, traces, accessibility values, or checked-in fixtures.

## Implemented boundary

- The QR remains the version-1 single-account `{ version, origin, pairing }`
  payload.
- Native pending state durably stores the exact DeviceID, credential, digest,
  label, pairing ID, and secret before the first request and resumes the same
  claim after an uncertain result.
- The claimed credential reads authenticated account metadata, is copied and
  read back under the configuration TreeID, and only then clears pending state.
- Native saved accounts and credentials are configuration-TreeID keyed. The old
  origin-keyed credential path is confined to the removable singleton adapter.
- Mac pairing creation requires the selected configuration TreeID when several
  accounts exist and presents one QR for that account.
- iOS returns each successful scan to the plural account list; placement is a
  separate account-local action.
- `WirePairingClaim` remains intentionally small. Authenticated
  `GET /.arbor/account` supplies the configuration TreeID and optional
  Canopy-specific presentation handle after claim.

Preserve the proven short expiry, one-use secret, digest-only Canopy storage,
account-local revocation, confirmation code, and raw-credential exclusion from
Wire responses.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| TypeScript checks | `bun run typecheck` | exits 0 with no errors |
| TypeScript tests | `bun run test` | all tests pass |
| Web/CLI build | `bun run build` | exits 0 |
| Swift Wire | `swift test --package-path native/Packages/ArborWire` | all tests pass |
| Swift client | `swift test --package-path native/Packages/ArborClient` | all tests pass |
| Swift account layer | `swift test --package-path native/Packages/ArborSync` | all tests pass |
| Whitespace | `git diff --check` | no output |

Use the current repository-native app build/test commands documented at HEAD
for final macOS and iOS artifact qualification. Do not substitute package tests
for an exact-artifact scan.

## Scope

**In scope**:

- configuration-TreeID-keyed native credential lookup;
- protected, durable pending state for one scanned pairing claim;
- exact retry and post-claim account discovery/re-keying;
- account-qualified local pairing creation on Mac;
- per-account QR presentation and confirmation;
- an iOS account list with Add Account and one-QR scanning;
- separation of account registration from optional tree placement;
- focused TypeScript, Swift, and exact-artifact tests.

**Out of scope**:

- selecting or encoding several accounts in one QR;
- version-2 QR payloads, bundle confirmation, bundle size limits, partial
  bundle state, or bounded-concurrency claims;
- cross-Canopy transactions, federation, or a pairing broker;
- account recovery after all administrators are lost;
- automatic placement or downloading every hosted tree;
- changing the Canopy's account-local pairing security contract;
- migrating the existing origin-keyed singleton credential, which belongs to
  Interface 005's offline migration artifact;
- a remotely visible global installation identifier.

## Milestones

### 1. Make pairing creation account-qualified without changing the QR

In the Interface 005 local API, require a configuration TreeID when creating a
pairing if more than one account exists. Validate that the selected account is
connected, credential-available, and authorized before asking its Canopy for an
offer. Preserve a bounded singular compatibility call only while exactly one
account exists; ambiguity must return an explicit error.

Update the Mac model to accept the selected account descriptor and continue
constructing the existing version-1 `PairingPayload`. The displayed Canopy,
Canopy-specific presentation name, and profile context comes from the safe authenticated local account
descriptor, not from new secret-bearing QR fields.

**Verify**: focused client/server tests prove two accounts at one origin create
different account-bound offers; the decoded QR is still exactly one valid
version-1 payload.

### 2. Put pairing on each Mac account surface

Add **Pair another device…** to each account's detail or management surface.
The sheet identifies that one Canopy account (using its handle when the Canopy provides one), shows its QR and confirmation
code, explains expiry, and can be dismissed or renewed. It offers no account
multi-selection.

Ensure screenshots, accessibility labels, clipboard notices, errors, and logs
never include the raw payload. If a copy-payload debugging action remains, it
must be explicitly user initiated and must not enter telemetry, snapshots, or
diagnostics.

**Verify**: with two same-origin accounts, opening each row creates an offer
for that row only; dismissing one sheet does not alter the other account.

### 3. Prepare one iOS claim durably before sending it

Replace `NativeAccountService.claim`'s per-invocation generation with a durable
claim preparation step. Derive a safe pending-record key from normalized origin
and PairingID. Before any request, persist in device-only protected storage:

- the pairing secret;
- generated DeviceID;
- generated raw credential and its digest;
- exact sanitized device label;
- state needed to distinguish prepared, sent/uncertain, claimed, and bound.

Non-secret private state may reference that protected entry but may not repeat
its secret values. On every retry, reconstruct the identical Wire claim. A
definitive wrong/expired/used-secret response may terminate that pending claim;
a timeout, transport loss, server error, or app suspension remains retryable.

**Verify**: inject a failure or process interruption before and after every
durable write and network boundary. Every recoverable path sends the same
DeviceID, digest, label, PairingID, and secret and never creates a second
credential.

### 4. Discover the account and bind its credential safely

After the claim returns—or an exact retry confirms an earlier success—use the
pending credential to authenticate the account read. Validate the Canopy
origin, claimed DeviceID, account ID, profile TreeID, and configuration-tree
descriptor. Reject identity disagreement rather than guessing.

Copy the raw credential into its configuration-TreeID Keychain slot, read it
back, persist the local account record, and only then delete the pending secret
entry. If account discovery or re-keying is interrupted, resume that phase
without repeating registration or discarding the only credential.

The existing origin-keyed credential remains readable only through the named
singleton compatibility adapter. Interface 005's offline migration will move
it after proving the configuration TreeID; Interface 006 neither rewrites nor
deletes it.

**Verify**: two newly paired accounts at one origin retain independent
credentials through claim, restart, lookup, and revocation; no new account uses
origin-only final credential lookup.

### 5. Make iOS account addition and placement separate

Replace the one-account onboarding assumption with an Accounts surface. **Add
Account** opens the QR scanner, validates one version-1 payload, resumes an
existing pending claim for that origin/PairingID when present, and adds one
account. A second scan repeats the same flow and leaves the first account
unchanged.

After success, return to the account list and show the added Canopy account. A
separate action within that account lists hosted trees and allows one to be
placed. The app must remain in a valid connected state when the account has no
local tree placements.

**Verify**: add accounts A, B, and a second account at A's origin; restart with
no placed trees; then place one tree from B and prove the other accounts and
their credentials are unchanged.

### 6. Qualify security, retries, and exact artifacts

Add tests for:

- successful one-account scan and repeat scans for other accounts;
- two accounts at one Canopy using independent credentials;
- the same profile TreeID referenced by accounts at different Canopies;
- lost success response followed by byte-equivalent claim replay;
- app termination during prepared, uncertain, claimed, discovery, and re-keying
  phases;
- wrong secret, expiry, already-used-by-another-device, confirmation mismatch,
  revocation, and duplicate scan;
- corrupted or incomplete pending state failing closed;
- pairing followed by zero placements;
- absence of raw secrets and local paths from logs, errors, traces, screenshots,
  accessibility values, and fixtures.

Run every command in the Commands table, then exercise the exact current Mac
and iOS artifacts: generate the QR from a selected Mac account, scan it on iOS,
confirm the same code, observe that one account appear, repeat for a second
account, restart both apps, and place one tree explicitly.

## Done criteria

- [x] Every Mac account independently offers one version-1 pairing QR.
- [x] Every iOS scan adds exactly one account and can be repeated for another.
- [x] No bundle schema, account multi-selection, or cross-account claim state exists.
- [x] Every account has a distinct DeviceID and credential keyed finally by configuration TreeID.
- [x] An uncertain retry reuses the exact prepared claim identity and secrets.
- [x] Interrupted post-claim discovery/re-keying cannot lose or overwrite the credential.
- [x] Two same-origin accounts remain independently usable and revocable after restart.
- [x] Pairing leaves the local placement set unchanged.
- [x] TypeScript, Swift, build, and exact-artifact build verification passes.
- [x] No secret-bearing value reaches logs, diagnostics, traces, screenshots, accessibility values, or checked-in fixtures.
- [x] A live Mac-to-iPhone scan, confirmation, restart, and explicit placement are recorded.
- [ ] A second live account scan is recorded when another account is available to this Mac; automated same-origin and multi-account coverage already passes.

## STOP conditions

- The QR needs to encode more than one account or a new version solely for plural storage.
- The Mac cannot identify the selected account by configuration TreeID before creating its offer.
- A claim request can reach the network before its DeviceID and credential are durable.
- Retrying an uncertain result changes any claim field.
- Final credentials or authenticated account state are keyed only by origin.
- Re-keying requires deleting the pending or legacy credential before the new account-keyed value is read back.
- Adding an account requires placing a tree.
- A raw pairing secret or credential would enter an artifact, log, diagnostic, accessibility value, or test failure.

## Maintenance note

Keep account pairing and tree placement as separate commands and screens. If
repeated scanning later proves burdensome, measure that friction first; a bulk
convenience should orchestrate this already-correct one-account operation
without changing its credential, retry, or revocation boundaries.
