# Security 011: Qualified profile locators: placement by reservation, no `homeHost`

## Status

- **Priority:** P3
- **Effort:** M
- **Risk:** MEDIUM. A placement host takes a profile's home host from its
  own administrator's word instead of the profile key's signature, and a
  profile on another host is named by its canonical locator there.
- **State:** PHASE 1 DONE 2026-09-28 (spec prose); batch step 028 (the pin
  table) waits in `migrations/next/`. Joe chose this over a claim on first use.
  Replaces the placement claim of
  [Security 007](007-placement-hosts.md) and the `homeHost` field Security 009
  added to rule subjects, both deployed 2026-09-28. No live placement account
  exists yet, and on 2026-09-28 no live `tree_policy` or `app_policy` rule
  used `homeHost` (3 and 0 rows), so nothing needs rewriting.
- **Builds on:** [Security 007](007-placement-hosts.md) (published device
  keys, placement accounts, the placement root) and the grace and remote
  groups recorded in [status](../../status.md#trees-on-other-hosts--2026-09-28).

## The problem

Under Security 007 a person puts trees on another host B in two steps: B's
administrator reserves `~joe` for Joe's profile TreeID, then Joe claims it with
the profile key (`arbor account place`, or Place on another host… on the Mac),
signing which host is his home. The claim needs the profile key, which only a
data home holding the identity has, so the iPhone can never do it; it adds a
command, a route and an app flow; and in practice the administrator already
knows exactly whom they mean.

## The design

**A profile on another host is named by its locator there.** Wherever a
profile or group is named (a community member, an `access.yaml` or `apps.yaml`
rule's `who.profile`), the value is either a bare TreeID (or `arbor://tr_…/`),
a profile this host holds, or a canonical locator at another host,
`https://A/~joe` or `arbor://A/~joe` ([locators §1](../../docs/overstory-spec/03-locators.md#1-forms)).
There is no `homeHost` field anywhere: the locator's authority says where to
look.

```yaml
members:
  - profile: https://arb.nxhx.org/~joe
    handle: joe
```

```yaml
- who:
    profile: https://arb.nxhx.org/~crew
  allow: [read]
```

A host resolves such a locator at its authority (the canonical lookup of
locators §1) to the TreeID, and refreshes it with the device keys or group
members it reads there (60 s and 30 s, the one-hour grace).

**The TreeID is pinned (decided, Joe, 2026-09-28).** The host records the
TreeID a locator first resolved to, as host state beside the account or rule
index, never in the configuration file. A later resolution to another TreeID
makes the entry match nobody (a placement account refuses sessions, a rule
grants nothing) until the entry is edited, which pins afresh; an unreadable
locator is treated like an unreadable group, served from the last resolution
through the grace, then matching nobody. So a rename or reuse of the handle at
the other host fails closed instead of moving the reservation or the rule, and
identity stays the TreeID: locators §1 states that a locator subject names the
TreeID it was pinned to.

**The reservation is the placement account (decided, Joe, 2026-09-28).**
When B accepts a community update that adds a member whose profile is a
locator at another host, it resolves the locator there and, in the accept's
transaction, pins the TreeID, records the placement account (`accounts` row
with `home_host`, the locator's origin, schema 27 as deployed) and declares its
placement root at `/~handle`, as Security 007's claim did. If the locator
cannot be resolved, B refuses the update, naming the host it could not read,
and the administrator retries. Removing the member disables the account,
ending its sessions and watches as a device deletion does; the root and the
trees under it stay, as a disabled home account's do. A member naming a TreeID
is a home reservation, claimed as today.

**Devices connect with no claim.** A device of that profile opens a session on
B exactly as under Security 007: B reads the home host's published device keys
(60 s lifetime, early refetch, one-hour grace). Opening a session creates
nothing.

**Clients discover B by using it.** `arbor place <folder> https://B/~joe/x`
opens a session at B with the device key; success records the placement
connection (as `arbor account place` does now) and places the folder, and a
refusal says B has no reservation naming this profile. The Mac's Place on
another host… becomes Add another host… with the same test, and the iPhone
gets it too, since it needs only its own device key.

### Trust

B trusts its administrator for which host is each placement account's home,
where Security 007 had the profile key sign it. B's administrator already
controls everything B serves, so this adds nothing they could not do; what it
gives up is the person's consent: an administrator can reserve any public
profile, whose devices can then act on B, and nobody else can. B still trusts
the home host over HTTPS for the device list;
[Security 010](../security/010-signed-profile-statements.md) is where that ends.

## Work

### Phase 1: spec (done 2026-09-28)

- [Locators §1](../../docs/overstory-spec/03-locators.md#1-forms): profile
  locator subjects and the pin.
  [Accounts §1.2–§1.3](../../docs/overstory-spec/04-accounts-and-devices.md#13-placement-accounts):
  a reservation naming a locator at another host is a placement account,
  declared with its root on accept; no placement claim; disabling on removal;
  the trust paragraph. [Access control §1 and §3.3](../../docs/overstory-spec/05-access-control.md#1-subjects-and-rules):
  `who.profile` is a TreeID or a locator, and `homeHost` is gone.
- The conformance vectors change with the code (Phase 2), since the deployed
  implementation's tests read them: drop the placement challenge vectors and
  `homeHost` from `resource-policy.json`; add locator subjects and members.

### Phase 2: canopyd

- `memberReservations` (`packages/canopyd/src/profile.ts`) reads locator
  members, and the community accept turns them into placement accounts;
  disable removed ones.
- Rules: `resource-policy.ts` and `remote-groups.ts` take the group's host
  from the locator; `access.yaml` and `apps.yaml` lose `homeHost`, and the
  one-host-per-profile check becomes one locator per profile.
- The pin: the resolved TreeID per locator as host state (a schema step in
  `migrations/next/` if it needs a table; the in-memory group copies are not
  enough, since the pin must survive a restart), set when an entry is
  accepted, cleared when it is edited or removed. Tests: a handle moved to
  another profile at A matches nobody on B until the entry is edited; a
  restart keeps the pin.
- Remove the placement claim (`createAccountChallenge`'s `homeHost`,
  `claimPlacementAccount`, `verifyAccountIdentityProof`'s placement branch).
- Declare the placement root in the accept that adds the member; refuse the
  update when the locator cannot be resolved.
- Tests: `tests/integration/canopyd/placement-hosts.test.ts` reserves instead
  of claiming; a removed member loses its sessions; a reservation naming B
  itself is a home reservation.

### Phase 3: clients

- CLI: `arbor place` onto a host connects on first use; `arbor account place`
  and `POST /v1/bootstrap/placements` go; `arbor account` still lists
  placements. A way for an administrator to reserve a qualified profile
  (`arbor community reserve https://A/~joe` or an edit of the community page;
  **Decide**).
- Swift: Add another host… on the Mac and iPhone; drop the claim in
  `PlacementAccounts.swift` and `Credentials.swift`; `homeHost` leaves
  `ResourcePolicy.swift`, `ProfileConfigurationYAML.swift` and the sharing
  view, which shows a locator subject's host from the locator; the group
  member and sharing editors accept a qualified profile URL.
- Tests: `arborsync-placement-host.test.ts` and `cli-account-place.test.ts`
  rewritten around reservations.

### Phase 4: deployment (needs Joe's go-ahead)

- The batch's other wire changes ride this cutover and its client release:
  the required update `head`, the slimmer watch frame, `after` as the only
  watch cursor, and `/access` as `{ policy, locators }` without the unused
  cursors ([the batch README](../../packages/canopyd/migrations/next/README.md#wire-changes-at-cutover)
  lists their spec sections and the code each touches), with step 029
  (`trees.status` dropped) beside 028.

- No schema change beyond the pin's step, if it needs one (cut over as a
  batch). The placement claim routes disappear, and `homeHost`
  in configuration files becomes invalid: a clean break (sole user; no live
  rule uses it as of 2026-09-28, recheck just before). Deploy canopyd with the
  clients, then record in `status.md` and delete this plan.
