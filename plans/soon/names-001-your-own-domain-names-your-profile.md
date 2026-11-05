# Names 001: Your own domain names your profile

**Why and when:** Joe, 2026-11-05, asked whether DNS host names are a good way to define the global namespace. Claude's answer: yes for naming, and the spec already uses DNS only as a lookup over TreeIDs, but today a name belongs to whoever runs the host. `garden.example/~alice` stops working when Alice moves hosts or Garden goes away. Bluesky solves this with handles: a person points a domain they own at their identity. Joe: "let's do this as a plan in soon." Then `alice.com` means Alice's profile wherever it lives, and a rule, a link or a membership written with it survives a move.

> **Executor instructions**: Spec first (locators §1, accounts §1), reviewed with Joe before code. Reuse the pinning machinery (`packages/overstoryd/src/locator-pins.ts`): a domain is one more kind of profile locator, resolved to a TreeID and pinned like the others. Run `bun run test:protocol` when the spec's conformance cases change.

## Status

- **Progress (2026-11-05)**: steps 1-4 done on main ([status](../../status.md#domain-locators-your-own-domain-names-your-profile--2026-11-05)). Decided while building: both TXT and `.well-known` are read and must agree (a loopback test domain has only the file); a domain names a person only, never a group; community reservations and placement invitations still take the home locator, since a placement account records its home host; `domains` is a list of bare lowercase DNS names. Left: step 5 and the close out.
- **Effort**: M
- **Risk**: LOW to MEDIUM. Resolution is read-only and failures fail closed (a name that does not resolve matches nobody), but it adds DNS and a second HTTP fetch to every resolution of a domain name.
- **Depends on**: nothing. Moving a home host (Security 010) is what makes it pay off most, but naming is useful before then: a person on a friend's host can still be `alice.com` everywhere.
- **Category**: identity and naming

## What exists

- A profile is named across hosts by its **canonical locator** at its home host (`https://home.example/~alice`). Hosts **pin** each locator to the Profile TreeID it first resolved to, and a locator that later resolves to another TreeID matches nobody until edited (locators §1).
- **Visitor sessions** (accounts §5.6) trust a profile's home host to vouch for its devices, scoped to locators at that host.
- The profile's root `_index.md` is public at its home host when the profile allows it, and has front matter (`type: person`, `displayName`, …).

## The design

### Claiming a domain

Alice proves both directions, as Bluesky does:

1. **The domain names the profile.** Either a DNS TXT record

   ```text
   _overstory.alice.com.  TXT  "profile=https://garden.example/~alice"
   ```

   or a file at `https://alice.com/.well-known/overstory-profile`:

   ```json
   { "profile": "https://garden.example/~alice", "profileTree": "tr_…" }
   ```

2. **The profile names the domain.** Her profile root's front matter lists it:

   ```yaml
   domains: [alice.com]
   ```

A resolver accepts the domain only when both agree. The first stops a profile from claiming a domain it doesn't control; the second stops a domain from claiming a profile that doesn't want it.

### Using it

- **As a profile locator.** `https://alice.com` (or `overstory://alice.com`) is a profile locator wherever one is accepted today: an `access.yaml` subject, a group member, a community reservation. A host resolves it (domain → home locator → TreeID, checking both directions) and pins the TreeID as it does now. When Alice moves home hosts, the domain's record changes and the pin stays the same TreeID, so every rule written with `alice.com` keeps working.
- **For visitors.** A visitor vouched for by home host H matches a domain subject when the domain currently delegates to a locator at H that is pinned to the same TreeID.
- **As a path prefix** (not built; see open questions). `overstory://alice.com/notes` resolves to `<home locator>/notes`. That makes the domain a portable prefix for her trees too. Plain `https://alice.com/...` stays her website's business. She can redirect it if she likes.
- **In Story.** Show `alice.com` in place of `~alice · garden.example` wherever a person is named, accept it in the share sheet and Go to…, and offer "Use your own domain…" in Settings, which writes the front matter and shows the record to add.

## Steps

1. ✓ **Spec**: locators §1 (domain profile locators, the two-way check, the `.well-known` file and the TXT record, which wins if both exist), accounts §1 (the `domains` front matter key), access control §1 (visitor matching for domain subjects). Review with Joe.
2. ✓ **Protocol package**: `resolveDomainDelegation` (and overstoryd's `domainProfileResolver`) doing both lookups and the check, with conformance cases.
3. ✓ **overstoryd**: accept domain locators where profile locators are accepted, and pin them through the same refresh schedule. Visitor matching. Tests with a fake DNS resolver and a loopback `.well-known`.
4. ✓ **CLI**: `story me domain <domain>` adds the front matter and prints the record to publish, then `story me domain --check`.
5. **Story (Mac, then iPhone)**: show domain names, accept them where people are named, and the Settings flow. Hand check with Joe on one of his own domains.
6. **Close out**: status, then delete this plan.

## Open questions

- **Domains in reservations.** A community could reserve `alice.com` and follow her home host as it moves. That needs a placement account whose home host can change (Security 010's territory).
- **Path prefixes.** `overstory://alice.com/notes` as `<home locator>/notes` is not built: Story Sync and the CLI resolve canonical URLs at the URL's own host today.
- **Hosts naming themselves.** Should a community be nameable the same way (`garden.example` is already a domain, so probably nothing to add)?
- **Display without the check.** If the check fails later (the record is removed), Story falls back to `~alice · garden.example`. Should it warn the people who wrote rules with the domain?
