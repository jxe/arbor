# Names 001: Your own domain names your profile

**Why and when:** Joe, 2026-11-05, asked whether DNS host names are a good way to define the global namespace. Claude's answer: yes for naming, and the spec already uses DNS only as a lookup over TreeIDs, but today a name belongs to whoever runs the host. `garden.example/~alice` stops working when Alice moves hosts or Garden goes away. Bluesky solves this with handles: a person points a domain they own at their identity. Joe: "let's do this as a plan in soon." Then `alice.com` means Alice's profile wherever it lives, and a rule, a link or a membership written with it survives a move.

> **Executor instructions**: Spec first (locators §1, accounts §1), reviewed with Joe before code. Reuse the pinning machinery (`packages/overstoryd/src/locator-pins.ts`): a domain is one more kind of profile locator, resolved to a TreeID and pinned like the others. Run `bun run test:protocol` when the spec's conformance cases change.

## Status

- **Progress (2026-11-05)**: steps 1-4 done on main ([status](../../status.md#domain-locators-your-own-domain-names-your-profile--2026-11-05)). Decided while building: both TXT and `.well-known` are read and must agree (a loopback test domain has only the file); a domain names a person only, never a group; community reservations and placement invitations still take the home locator, since a placement account records its home host; `domains` is a list of bare lowercase DNS names. Left: custom domains at a host (step 5), Story (step 6) and the close out.
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
- **For her trees' URLs: a custom domain at her host** (not built; step 5). Decided with Joe 2026-11-06: do it in DNS, not in clients. Alice points a domain at her home host with a CNAME (often a subdomain, `notes.alice.com`, since the domain stops being her website), and the host serves her profile's `/~alice` at that domain's root, so `https://notes.alice.com/drafts` is the canonical URL `garden.example/~alice/drafts`. Nothing changes in clients or in the spec's lookup: the URL's DNS name already selects the host ([locators §1](../../docs/overstory-spec/03-locators.md#1-forms)), and browsers follow it too. When she moves, she repoints the CNAME and the new host serves the same paths if it keeps her trees at the same names. The host accepts a domain only with the same two-way check: the domain resolves to the host, and her profile's `domains` lists it. A tree has exactly one canonical URL (Joe, 2026-11-06): while the domain is verified, the domain form is canonical everywhere the host names her trees (descriptors, share links, `story open`), and `garden.example/~alice/…` answers only with a redirect to it. When the claim stops verifying, the host form is canonical again and the domain stops being served. The TXT/`.well-known` naming above stays for people who want the name without handing the domain over. (Rejected: clients rewriting `overstory://alice.com/notes` to `<home locator>/notes` themselves; it needs every client to change, only works for `overstory://`, and browsers never see it.)
- **In Story.** Show `alice.com` in place of `~alice · garden.example` wherever a person is named, accept it in the share sheet and Go to…, and offer "Use your own domain…" in Settings, which writes the front matter and shows the record to add.

## Steps

1. ✓ **Spec**: locators §1 (domain profile locators, the two-way check, the `.well-known` file and the TXT record, which wins if both exist), accounts §1 (the `domains` front matter key), access control §1 (visitor matching for domain subjects). Review with Joe.
2. ✓ **Protocol package**: `resolveDomainDelegation` (and overstoryd's `domainProfileResolver`) doing both lookups and the check, with conformance cases.
3. ✓ **overstoryd**: accept domain locators where profile locators are accepted, and pin them through the same refresh schedule. Visitor matching. Tests with a fake DNS resolver and a loopback `.well-known`.
4. ✓ **CLI**: `story me domain <domain>` adds the front matter and prints the record to publish, then `story me domain --check`.
5. **Custom domains at a host** (cloud-testable except the certificates): today a canonical URL is the host's configured `publicOrigin` plus the tree's registered canonical path. overstoryd gains a table of verified domains, each mapped to a path prefix (`notes.alice.com` → `/~alice`), filled from the two-way check and re-checked on the pin refresh schedule; a domain stops being served when either direction fails. Building a URL: the longest verified prefix covering the tree's path picks the origin, else `publicOrigin`, so there is always one answer. Serving: a `Host:` matching a verified domain gets its prefix prepended (canonical lookup, public HTTP projection, API); a host-form request under a verified prefix gets a redirect to the domain form. Spec: locators §5 (a host may serve one account's paths at a domain's root) and accounts §1. CLI: `story me domain --serve <domain>` prints the CNAME. Then certificates on Railway: its API adds a custom domain per verified claim, or a certificate-issuing proxy in front (decide by trying Railway's API first).
6. **Story (Mac, then iPhone)**: show domain names, accept them where people are named, and the Settings flow. Hand check with Joe on one of his own domains.
7. **Close out**: status, then delete this plan.

## Open questions

- **Domains in reservations.** A community could reserve `alice.com` and follow her home host as it moves. That needs a placement account whose home host can change (Security 010's territory).
- **Many custom domains on Railway.** Railway caps custom domains per service; a community with many people using their own may need the proxy route.
- **Hosts naming themselves.** Should a community be nameable the same way (`garden.example` is already a domain, so probably nothing to add)?
- **Display without the check.** If the check fails later (the record is removed), Story falls back to `~alice · garden.example`. Should it warn the people who wrote rules with the domain?
