# Sharing 004: Start your own community from a Railway template

**Timing:** Built 2026-11-05 (Joe: "bang out the railway template (w. image)"), then set aside until Joe publishes it.

**Why and when:** Joe wants a newcomer to choose between two ways in: ask a friend like Joe for an account on their host, or run their own overstoryd. Today the second takes the CLI (`story me create`), copying a TreeID into Railway variables, and the deploy README. Joe, 2026-11-04: don't make it *quite* that easy. If Story starts the flow, people will make an identity and then give up at Railway. So the flow starts at the Railway template, and Story comes in only at the end, through the invitation link it already handles. This does not make running a host easy. Domains, updates and backups stay the owner's job (Joe, 2026-10-28: "running a host may stay hard for now").

> **Executor instructions**: Develop and test against disposable Railway services and local hosts. Nothing here touches arb.nxhx.org. Publishing the template on Railway, and any public image, waits for Joe's go-ahead. The founder claim changes a host route's behavior, so run `bun run test:protocol`.

## Status

- **State**: steps 1, 2, 4 and 5 built on main 2026-11-05; step 3's image and template definition too. Built differently from the decisions below in two places: `access.yaml` can't be empty of administrators (the protocol's invariant), so a code-founded community grants `admin` to its group, which has no member yet, and the founder's claim replaces that rule; and the host says `founding: true` from `GET /.overstory/health` rather than the claim challenge, because Story words its join screen before it asks for a challenge. The first-screen line links to the deploy README's "Start your own community" section, so the template's link can change without an app release.
- **Left, for Joe**: make the `ghcr.io/jxe/overstoryd` package public after the first image publishes (a release tag, or running Publish host image by hand), create the template in Railway's dashboard as the deploy README's "The template (maintainers)" says, and put its link in that README. Then the rehearsal in step 3 from a fresh Railway account, and the "Old hosts, new apps" question below.
- **Effort**: M
- **Risk**: LOW. A new host founded by code is only as safe as its founder code. The code sits in Railway variables and deploy logs, which only the project's owner can see, and the first claim uses it up.
- **Depends on**: nothing
- **Category**: product completion

## What exists

Read from source on 2026-11-04. Nothing here was run.

- **Unattended founding takes a TreeID.** On an empty volume, `overstoryd serve` needs `OVERSTORYD_COMMUNITY_HANDLE`, `OVERSTORYD_FIRST_WRITER_HANDLE` and `OVERSTORYD_FIRST_WRITER_PROFILE` (`packages/overstoryd/src/cli.ts`). `bootstrap` in `overstoryd.ts` reserves the founder's handle for that profile, names the profile as the community's only `admin` in its `access.yaml`, and records `first_writer_handle` in `meta` until the claim. The founder then claims with the profile key (accounts §1.2).
- **An invitation is a code, not a profile.** A `members` entry holding `handle` and `inviteDigest` (`sha256:` and the hex SHA-256 of the code's text). The claim checks the code, rewrites the entry to name the profile (`claimInvitationEntry`), and makes the claimer a member who administers nothing.
- **Story already turns an invitation link into a person.** On a device with no identity, the Mac's first screen ("Story is joined by invitation. Paste the link you were sent.", `StoryOnboarding.swift`) creates the identity, asks for a backup, and claims. The link is `https://<host>/~<handle>#overstory-invite=<code>`.
- **The Railway deploy is checked in.** `railway.toml`, `packages/overstoryd/deploy/Dockerfile.overstoryd`, and a README with the manual steps (volume at `/data`, a public domain, three variables). overstoryd refuses to start on Railway without both a domain and a volume. `bun run overstoryd:railway apply` manages Joe's own hosts from `hosts/<domain>.env`.

## Decisions

- **Railway first, Story last.** The person deploys the template, finds their founder link, and opens it. Story's existing invitation flow does everything after that. Story gets no "start my own" branch that makes an identity before a host exists.
- **Founding by code.** A new variable, `OVERSTORYD_FOUNDER_CODE`, can take the place of `OVERSTORYD_FIRST_WRITER_PROFILE`. On first start the host reserves the founder's handle as an ordinary invitation (`inviteDigest` of the code).
- **The first invitation claimed makes its claimer the administrator** (Joe, 2026-11-04). A code-founded community has no profile to name in `access.yaml` at bootstrap, and no administrator (not the group fallback, which would make every member one). The rule is just that: while a community names no administrator, an invitation claim also writes the claimer's profile into its `access.yaml` as `admin`, in the same transaction. No separate "founder invitation" marker. Only the founder's invitation exists then, since nobody else can make one. Accounts §1.2 says so.
- **The host shows the link only to its owner.** While the founder invitation is unclaimed and the variable is set, the host prints the full founder link in its log at every start. The link appears nowhere else, so it can only be found through Railway's logs or variables. After the claim the host ignores the variable and logs that it can be deleted.
- **The template generates the code.** Its variables are `OVERSTORYD_COMMUNITY_HANDLE` and `OVERSTORYD_FIRST_WRITER_HANDLE`, which the person fills in, and `OVERSTORYD_FOUNDER_CODE`, generated by Railway's `secret()` function with the base64url alphabet. The template also attaches a `/data` volume and generates a Railway domain.
- **Founder wording** (Joe, 2026-11-04). When the claim will make the claimer administrator, Story says "Your community on <host> is ready" instead of "You've been invited". The host says so when asked for the reserved account (a small protocol addition: the claim challenge answers `founding: true` while the community has no administrator).
- **One line in Story.** Below the invitation field on the first screen: "No invitation? Start your own community", linking to the template. Asking a friend needs nothing new: the friend makes an invitation link as today.
- **A self-hosted person joins Joe's community as a placement.** Their home host is their own, so accepting Joe's invitation makes a placement there (accounts §1.4), as for anyone who already has an identity.

## Steps

1. **Spec.** Accounts §1.2: founding by code, the founder invitation, and the claim that names the community's administrator.
2. **Host.** `OVERSTORYD_FOUNDER_CODE` in `cli.ts` (either it or `OVERSTORYD_FIRST_WRITER_PROFILE`, not both), the founder invitation in `bootstrap`, the `access.yaml` edit on its claim, and the start-up log line. Unit tests, plus an integration test that founds a host by code, claims it with the TS client, and then edits the community's `access.yaml` as its administrator.
3. **Railway template.** Built from this repository's Dockerfile or from a published image (open question below). Rehearse it end to end from a fresh Railway account: deploy, find the link in the logs, open it in Story on a Mac with no identity, invite a second person, and restart the service.
4. **Story.** The first-screen line and link, and the founder wording from `founding`. Check that the founder link goes through the rest of the invitation screens with nothing that reads wrong for a founder.
5. **Docs.** The deploy README gets a "Start your own community" section that leads with the template. Mention what stays the owner's job: keep the domain (it is in every link, so a later move breaks them), turn on volume backups, and redeploy to update. Railway's Hobby plan cost, checked when written.

## Open

- ~~**Image or repository.**~~ Image (Joe, 2026-11-05): `.github/workflows/publish-host-image.yml` publishes `ghcr.io/jxe/overstoryd:<version>` and `:latest` from each release tag; the template uses `:latest`, and a service keeps what it pulled until redeployed. Was: Joe isn't sure (2026-11-04). Recommended: a published, versioned image. A template that builds `jxe/arbor` needs the repository public, and every redeploy builds whatever is on its branch at that moment, so owners can't choose when to update and a broken main reaches every self-hosted host. An image on GHCR, tagged by `tools/release.sh` with each Story release, keeps hosts on a version that matches an app release, and updating is changing the tag and redeploying. The cost is one more release step. Decide before step 3.
- **Old hosts, new apps.** Self-hosted hosts will lag behind Story releases. Health already advertises capabilities. Decide what Story says when a host is too old for it, before the template is public.
- **Other hosting.** Fly and the docker-compose VPS recipe could get the same founder-code path later. Railway only for now.
