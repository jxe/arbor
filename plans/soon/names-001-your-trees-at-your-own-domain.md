# Names 001: Your trees at your own domain, and domains in Story

**Why and when:** Joe, 2026-11-05, asked whether DNS host names are a good way to define the global namespace: a name like `garden.example/~alice` belongs to whoever runs the host, and stops working when Alice moves. The first part is built (2026-11-05, [status](../../status.md#domain-locators-your-own-domain-names-your-profile--2026-11-05)): a domain can name a person, Bluesky-style. What is left is serving her trees at her domain, so links survive a move too, and showing domains in Story. Joe, 2026-11-06: do it in DNS (a CNAME to the host), not by clients rewriting URLs; a tree has exactly one canonical URL; keep both the TXT naming and the CNAME serving, with one Settings flow for both.

> **Executor instructions**: Step 1 is overstoryd work on main, testable in the cloud with loopback hosts (as `tests/integration/overstoryd/visitor-sessions.test.ts` does for domain naming). Reuse the domain check in `packages/overstoryd/src/locator-pins.ts` (`domainProfileResolver`) and its refresh schedule. Spec first (locators §5, accounts §1). Step 2 needs the Mac, so it goes on a branch.

## Status

- **Effort**: M
- **Risk**: MEDIUM. Step 1 changes how overstoryd builds and serves every canonical URL under a verified domain; a bug there breaks links. Failures should fail back to the host form.
- **Depends on**: nothing. Certificates depend on what Railway's API allows.
- **Category**: identity and naming

## What exists

- **Domain locators** ([locators §1.1](../../docs/overstory-spec/03-locators.md#11-domain-locators)): `https://alice.com` names a person when a TXT record at `_overstory.alice.com` (`profile=<home locator>`) or `/.well-known/overstory-profile` names her locator at her home host, and her profile root's `domains` front matter lists the domain back. overstoryd pins it like any locator and remembers the home host, so rules and visitors follow her across a move. `story me domain [<domain>] [--remove <domain>] [--check]`.
- Not allowed yet: domains in community reservations and placement invitations (a placement account records a fixed home host).
- Today a canonical URL is the host's configured `publicOrigin` plus the tree's registered canonical path.

## The design

### Trees at a domain

Alice points a domain at her home host with a CNAME, often a subdomain (`notes.alice.com`), since the domain stops being her website. The host serves her `/~alice` at that domain's root, so `https://notes.alice.com/drafts` is the canonical URL of what was `garden.example/~alice/drafts`. Clients and the spec's lookup need no change: the URL's DNS name already selects the host ([locators §1](../../docs/overstory-spec/03-locators.md#1-forms)), and browsers follow it too. When she moves, she repoints the CNAME; the new host serves the same paths if it keeps her trees at the same names. A domain that serves her profile root is also simply her profile's canonical URL, so it names her the ordinary way. The TXT naming stays for people who want the name without handing over the domain.

- **Verifying.** The host accepts a domain only with the two-way check: the domain resolves to the host, and her profile's `domains` lists it. It keeps a table of verified domains, each mapped to a path prefix (`notes.alice.com` → `/~alice`), re-checked on the pin refresh schedule, and stops serving a domain when either direction fails.
- **One canonical URL.** Building a URL, the longest verified prefix covering the tree's path picks the origin, else `publicOrigin`, so there is always one answer. While a domain is verified, its form is canonical everywhere the host names her trees (descriptors, share links, `story open`), and `garden.example/~alice/…` answers only with a redirect to it.
- **Serving.** A `Host:` matching a verified domain gets its prefix prepended (canonical lookup, public HTTP projection, API).
- Rejected: clients rewriting `overstory://alice.com/notes` to `<home locator>/notes`. Every client would change, only `overstory://` would work, and browsers never see it.

### In Story

- Show `alice.com` in place of `~alice · garden.example` wherever a person is named, once the domain checks: People, presence avatars, share sheets, group members.
- Accept a domain wherever a person is named: the share sheet and Go to….
- Settings, "Use your own domain…": writes `domains`, shows the TXT record or the CNAME with a copy button, and a Check button (what `story me domain --check` does).
- Share links use the canonical URL, which is the domain form when one is verified.

## Steps

1. **Custom domains at a host** (main): spec (locators §5: a host may serve one account's paths at a domain's root; accounts §1), the verified-domain table, URL building, serving and redirects, with loopback tests. CLI: `story me domain --serve <domain>` prints the CNAME. Then certificates on Railway: its API adds a custom domain per verified claim, or a certificate-issuing proxy in front (try Railway's API first).
2. **Story** (branch, Mac then iPhone): the display, input and Settings changes above.
3. **Close out**: Joe's hand checks go to his to-do file, status, then delete this plan.

## Open questions

- **Domains in reservations.** A community could reserve `alice.com` and follow her home host as it moves. That needs a placement account whose home host can change (Security 010's territory).
- **Many custom domains on Railway.** Railway caps custom domains per service; a community with many people using their own may need the proxy route.
- **Display without the check.** If the check fails later (the record is removed), Story falls back to `~alice · garden.example`. Should it warn the people who wrote rules with the domain?
