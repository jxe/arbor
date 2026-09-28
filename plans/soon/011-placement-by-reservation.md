# Security 011: Placement hosts by reservation, without a claim

## Status

- **Priority:** P3
- **Effort:** M
- **Risk:** MEDIUM. A placement host takes a profile's home host from its
  own administrator's word instead of the profile key's signature.
- **State:** PLANNED 2026-09-28 (Joe chose it over a claim on first use).
  Replaces the placement claim of
  [Security 007](007-placement-hosts.md), deployed 2026-09-28; nothing else
  of 007 changes. No live placement account exists yet, so nothing needs
  migrating.
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

**B's administrator names the person's qualified profile.** A community
member entry may carry the home host the profile lives on:

```yaml
members:
  - profile: "arbor://tr_…/"      # the Profile TreeID, as today
    handle: joe
    homeHost: https://arb.nxhx.org
```

Clients let the administrator type `https://arb.nxhx.org/~joe` and write the
entry: they resolve the URL at the named host to the Profile TreeID and record
that host's origin as `homeHost`, the same `{profile, homeHost}` pair
`access.yaml` already uses for remote groups. The stored entry names the
TreeID, so a rename at the home host changes nothing on B.

**The reservation is the placement account.** When B accepts a community
update, each member with a `homeHost` other than B becomes a placement account
(`accounts` row with `home_host`, schema 27 as deployed), and removing the
member disables it, ending its sessions and watches as a device deletion does.
A member without `homeHost` is a home reservation, claimed as today.

**Devices connect with no claim.** A device of that profile opens a session on
B exactly as under Security 007: B reads the home host's published device keys
(60 s lifetime, early refetch, one-hour grace). The first session from an
administrator device declares the placement root at `/~handle` (**Decide**:
or B declares it when it accepts the member, in the same transaction).

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

### Phase 1: spec

- Accounts §1.3 rewritten: a placement account comes from a reservation with
  `homeHost`; no placement challenge or claim; the placement root's creation;
  disabling on removal. §1 (reservations) and access control §3.3 gain the
  member `homeHost`. Conformance: drop the placement challenge vectors, add a
  member entry with `homeHost`.

### Phase 2: canopyd

- Read `homeHost` in `memberReservations` (`packages/canopyd/src/profile.ts`)
  and turn such members into placement accounts in the community accept;
  disable removed ones.
- Remove the placement claim (`createAccountChallenge`'s `homeHost`,
  `claimPlacementAccount`, `verifyAccountIdentityProof`'s placement branch).
- Declare the placement root per the decision above.
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
  `PlacementAccounts.swift` and `Credentials.swift`; the group member editor
  accepts a qualified profile URL.
- Tests: `arborsync-placement-host.test.ts` and `cli-account-place.test.ts`
  rewritten around reservations.

### Phase 4: deployment (needs Joe's go-ahead)

- No schema change. The placement claim routes disappear, a wire change for
  clients that claim; no live placement account uses them. Deploy canopyd with
  the clients, then record in `status.md` and delete this plan.
