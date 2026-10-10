# Rename 001: Arbor and Canopy names become Overstory and Story

**Why and when:** the protocol and packages were already Overstory, but the commands, daemons, dot directories, env vars, routes and the app still said Arbor or Canopy, and `canopyd` named the host after the app. Joe settled the names on 2026-10-06 and revised them on 2026-10-07 and 2026-10-10. He wants them applied in one cutover.

> **Executor instructions**: The repository work is on branch `rename/overstory-story`; do not merge it to `main` before the host cutover, because pushing `main` deploys the host. Changes to live data, the installed apps, Railway and the public host wait for Joe's go-ahead at each step that says so. This file is the authority for every naming decision; if you meet a name it does not cover, apply the rule in "Naming rule" and add the decision here.

## Status

- **Effort**: L
- **Risk**: MEDIUM. It touches the wire, on-disk names and launchd together, and the Mac migration rewrites the identity record.
- **Depends on**: nothing
- **Category**: cleanup
- **Planned at**: Overstory `23351c7`, 2026-10-06; mechanical pass `2f10ba4e`, 2026-10-10

## Naming rule

Programs follow djb: one suite prefix and a name that says the one job. CLI subcommands stay as they are.

- **Overstory** is the protocol and everything the spec owns: `overstory://` locators, `overstory-*` headers and parameters, the `/.overstory/` routes and the reserved `.overstory` path segment.
- **`@ovst/*`** is the npm scope (`@ovst/protocol`, `@ovst/overstoryd`, `@ovst/story-sync`, …). Joe holds the `@ovst` organization.
- **overstoryd** is the host program and its settings (`OVERSTORYD_*`).
- **Story** is the device product, named once the way Tailscale is: Story.app, the `story` CLI, the `story-sync` daemon ("Story Sync" in prose), `~/.story`, `STORY_*`, and Story for the web.

The reserved segment is a spec concept, so it carries the protocol's name, not a client's: any Overstory client writes `.overstoryignore`, not a file named after Story.

`story` was chosen for how it sounds in a command. A good CLI name leaves the stress free for the subcommand: either it is a light syllable (`git push`) or it is stressed then unstressed (`ar-bor SYNC`, `sto-ry SYNC`). A heavy syllable such as `ost` or `hunch` takes the stress itself and collides with the subcommand.

In prose and UI copy, capitalized "Story" always means the app or the product; a page or tree is never called a story. Where "Canopy" meant the host ("People on this Canopy", "a Canopy account"), write "host" or "Overstory host".

## Name map

### Programs and packages

| Was | Now | Notes |
|---|---|---|
| `canopyd` (`packages/canopyd`) | `overstoryd` | Host instances in code are `overstoryd` (`running.overstoryd`). The class was already `HostDaemon` and keeps that name. |
| `canopyd-merge`, bin `arbor-merge` | `overstoryd-merge` | Only the host execs it, by relative path. Not in the public `bin` list. |
| `arborsync` (`packages/arborsync`) | `story-sync` | Control API `service` value is `"story-sync"`. In identifiers it is `storySync` / `StorySync`. |
| `arbor` (`packages/cli`) | `story` | Same subcommands. `story daemon …` supervises `story-sync`. |
| `canopy-web` | `story-web` | Plans moved to `plans/story-web/`. |
| Canopy.app | Story.app | Display name and product name. The bundle id does not change (see below). |
| `@overstory/*` | `@ovst/*` | |

### Protocol and spec

| Was | Now |
|---|---|
| `arbor://` | `overstory://` |
| `/.arbor/*` host routes | `/.overstory/*` |
| `/.well-known/arbor[/{path}]` | `/.well-known/overstory[/{path}]` |
| Excluded directory `.arbor`, temporaries `.arbor-write-*`, `.arbor-txn-*` | `.overstory`, `.overstory-write-*`, `.overstory-txn-*` |
| `.arborignore` | `.overstoryignore` |
| Locator parameters `;arbor-key=`, `;arbor-rev=`, `;arbor-config`, fragment `#arbor-key=` | `overstory-key`, `overstory-rev`, `overstory-config` |
| `<!-- arbor:children -->` | `<!-- overstory:children -->` |
| Headers `Arbor-Access-Link`, `x-arbor-profile-state` | `Overstory-Access-Link`, `overstory-profile-state` |
| Share-link fragment `#arbor-access=` | `#overstory-access=` |
| Resolved-link discriminant `kind: "arbor"` | `kind: "overstory"` |
| App relation source `"arbor-profile"` | `"overstory-profile"` |
| Account field `canopy` (daemon control API, profile configuration snapshot) | `host` |
| (new) | `;overstory-invite=<code>` on an account locator. See [Join links](#join-links). |

The daemon serves only `/v1/*` and has no `/.overstory/` routes.

### Device

| Was | Now |
|---|---|
| `~/.arbor` and everything under it | `~/.story` |
| `~/Library/Application Support/Arbor/…` (app and CLI) | `…/Application Support/Story/…` |
| `~/Library/Logs/Arbor/arborsync.log` | `…/Logs/Story/story-sync.log` (disposable) |
| `ARBOR_DATA_HOME`, `ARBOR_REQUIRE_DATA_HOME` | `STORY_HOME`, `STORY_REQUIRE_HOME` |
| Other device `ARBOR_*` (`ARBOR_SYNC_*`, `ARBOR_CLOUD_*`, `ARBOR_CREDENTIAL_STORE`, `ARBOR_DISABLE_PERSISTENT_DAEMON`, `ARBOR_ACCOUNT_TOKEN`, test variables) | `STORY_*`. `ARBOR_WIRE_TEST_*` is `STORY_PROTOCOL_TEST_*`. |
| launchd label `org.nxhx.Arbor.arborsync` | `org.nxhx.story.sync` |
| URL scheme `canopy` | `overstory` |
| Port 4317 | unchanged |

### Host

| Was | Now |
|---|---|
| `ARBOR_DOMAIN`, `ARBOR_ACCOUNTS_JSON`, `ARBOR_COMMUNITY_HANDLE`, `ARBOR_FIRST_WRITER_*`, `ARBOR_OBJECT_CACHE_MB`, `ARBOR_OBJECT_PACKING`, `ARBOR_MERGE_*`, `ARBOR_RAILWAY_*`, `ARBOR_LAB_*` | `OVERSTORYD_*` with the same suffix |
| `ARBOR_CANOPY_DATA`, `ARBOR_CANOPY_RATE_LIMITS`, `ARBOR_CANOPY_MAINTENANCE`, `CANOPY_SCHEMA_VERSION`, `CANOPY_MEASURE_MOVES` | `OVERSTORYD_DATA`, `OVERSTORYD_RATE_LIMITS`, `OVERSTORYD_MAINTENANCE`, `OVERSTORYD_SCHEMA_VERSION`, `OVERSTORYD_MEASURE_MOVES` |
| `canopy.sqlite3` | `overstoryd.sqlite3`. The host refuses to bootstrap when `canopy.sqlite3` is present and `overstoryd.sqlite3` is not; otherwise a renamed build would create an empty community. |
| Railway service `canopy-arb-nxhx-org`, `deploy/canopies/` | `overstoryd-arb-nxhx-org`, `deploy/hosts/` |
| Public host `arb.nxhx.org`, GitHub repo `jxe/arbor`, checkout `~/src/arbor` | unchanged |

The host's SQL schema contains no old names, so there is no schema step.

### Swift modules and types

| Was | Now |
|---|---|
| Xcode project, target and scheme `Canopy`; `swift/CanopyApp`, `swift/CanopyAppTests` | `Story`; `swift/StoryApp`, `swift/StoryAppTests` |
| `CanopyAppKit` | `StoryKit` |
| `CanopyEditor` | `StoryEditor` |
| `CanopyWorkingTree` | `OverstoryWorkingTree`: generic client machinery, the counterpart of `@ovst/working-tree` |
| `swift/scripts/test-canopy-editor-local.sh`, `test-canopy-app.sh` | `test-story-editor-local.sh`, `test-story-app.sh` |
| `Canopy*` types | `Story*`. Account types that describe an account on a host are `HostAccount*`. Protocol-meaning `Arbor*` names are `Overstory*` (`OverstoryLocator`, `generateOverstoryID`). Variables that held a host are `host…` (`hostOrigin`). |
| App icon | Joe's Story icon, [story-icon.webp](story-icon.webp). It is the only source: 1254 px, no alpha, rounded corners baked in on white. Fill the corners with the background green and scale to a 1024 px square PNG, because macOS and iOS apply their own mask. |

## Old names after the cutover

### Never renamed

Opaque tags and names. Some are hashed into identifiers or authenticate artifacts that already exist, so a new spelling would change identities or orphan data for no gain.

- `arbor-update/2`, the domain inside every update's request digest (and the older `arbor-update` bytes pinned in two compatibility vectors)
- `arbor-tree-config-v1` and `arbor-person-profile-v1`, hashed into configuration-tree IDs and profile identities
- `arbor-profile-backup-v2`, which authenticates saved identity backups
- `arbor-device-key:v1:`, `arbor-cloud-v1`, `arbor-cloud-v2`
- `arbor-merge-records-1`, `arbor-merge-intent-state`, `arbor-merge-saved-entry`
- The `__arbor_` table prefix inside trees' own `_store.sqlite3` files
- `arbor-child-…` generated block ids
- `https://canopy.example` inside `conformance/device-keys.json`, which is signed and has no generator
- Names the Supplies example chose for itself, also in its binary store: `arbor_profiles`, `allow_arbor_user_edits`
- Completed migrations 018–023 under `packages/overstoryd/migrations/`, kept verbatim as history and excluded from typecheck
- Outside the repo: the lab's hcloud context and Hetzner key `arbor-lab`, the Tailscale tag `tag:arbor-lab`, and `~/.ssh/arbor_hetzner`

### Deferred to Rename 003

Persisted on devices and never shown to people. Changing them costs a keychain migration, an iPhone reinstall and re-pairing, so they wait for their own plan (not yet written).

- Bundle id `org.nxhx.Arbor` and its suffixes, including the test and lab ids
- Keychain services `org.arbor.person-profile`, `org.arbor.community-account`, `org.arbor.connections` (CLI and daemon) and `org.nxhx.Arbor.profile`, `org.nxhx.Arbor.device…` (iPhone)
- UserDefaults keys `arbor.uiSoundsEnabled`, `Canopy.manuallyNamedPages`; OSLog subsystem `org.arbor.native`

### Read old, write new

These spellings are inside authored content or in links already shared. Readers accept both; writers emit only the new one. The spec describes only the new spellings. [Rename 002](002-remove-arbor-locator-alias.md) rewrites live content and removes the aliases. Every alias site carries the comment marker `Rename 002` so they can be found.

| Old spelling | Where it is read |
|---|---|
| `arbor://` | The two locator parsers (`packages/protocol/src/model/logical-url.ts`, `StoryKit/LogicalURL.swift`) and every partial parser that tests the scheme itself: `overstoryd/src/profile.ts` (`PROFILE_LOCATOR`, which decides group membership), `protocol/src/model/resource-policy.ts`, `Overstory/ResourcePolicy.swift`, `StoryApp/StoryDirectory.swift` (regex and the exact-string member comparisons), `StoryApp/StoryRootView.swift`, `StoryApp/StoryVisits.swift`, `story-web` (`PageEditor.tsx`, `App.tsx`), `story-sync/src/service.ts`, `cli/src/index.ts`, `apps-runtime/src/authoring.ts` |
| `;arbor-key=`, `;arbor-rev=`, `;arbor-config`, `#arbor-key=` | The same two parsers, plus `protocol/src/config/tree-config.ts`, `overstoryd/src/host.ts`, `protocol/src/transport.ts`, `Overstory/TreeConfiguration.swift` |
| `<!-- arbor:children -->` | `protocol/src/documents/directory-document.ts`, `StoryEditor/MarkdownCodec.swift` |
| `.arborignore` | `fs/src/ignore-policy.ts`, `OverstoryWorkingTree/IgnorePolicy.swift`. When both files exist in a directory, `.overstoryignore` wins. |
| `#arbor-access=` | `overstoryd/src/host.ts` |
| `"source": "arbor-profile"` | `apps-runtime/src/schema.ts`, `sqlite.ts` |

### Clean break

Everything else: routes, `/.well-known/arbor`, headers, env vars, `~/.arbor`, the launchd label, the control API's `service` value, `canopy://join`. Host and clients ship together, the Mac migration moves local state once, and outstanding invitations are reissued.

## Join links

The Add Person sheet used to show `canopy://join?account=<account URL>&code=<code>`. An `overstory://join?…` link would not parse, because 03-locators treats the authority as either a `tr_` TreeID or a DNS name. The join link is the account's own locator with the code as a locator parameter, as `;overstory-key=` already carries a secret:

```text
overstory://arb.nxhx.org/~alice;overstory-invite=<code>
```

Story registers the `overstory` scheme. When the locator it opens carries `overstory-invite`, Story starts onboarding and the claim. Without the parameter, Story opens the locator as usual. The parameter is specified in 03-locators and 04-accounts-and-devices §1.2.

## Steps

1. **Repository rename** (branch `rename/overstory-story`). Done when all of these pass and are committed:
   - the mechanical pass (done, `2f10ba4e`)
   - no standalone "Canopy" or "Arbor" left in code, comments, UI copy or docs, except the lists above
   - the read aliases, the host bootstrap guard, the join link and URL scheme, the app icon
   - spec, conformance vectors (hand edits, then `bun docs/overstory-spec/conformance/canonical-cbor-vectors.ts`; no digest, CBOR or signature field may change), docs, plans and `status.md`
   - gates: `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build:cli:package`, `bun run test:cli:package`, `bun run check:links`, `swift/scripts/test-story-editor-local.sh`, and the `Story` scheme builds
   - grep gate: `rg -i 'arbor|canopy'` returns only the lists in "Old names after the cutover", the marked aliases and their tests, the `story migrate` code, and history in `status.md`
2. **`story migrate`**, the throwaway Mac migration, written and tested against a scratch home. It must:
   - refuse unless: `STORY_HOME` and the old variable are unset, `~/.story` does not exist, no account claim or pairing is in progress, no cloud session is recorded as live, and nothing answers on port 4317
   - take `~/.arbor/.state/migration.lock`, then rename `~/.arbor` to `~/.story`
   - rewrite absolute paths under the old home, and under `Application Support/Arbor`, in `placements.yaml`, `.state/workspaces.json`, `.state/self.json` (`profilePath`) and `cloud-sessions/sessions.json`
   - update `profilePath` inside the identity keychain value (same service and account; an update, never a delete)
   - leave device keys where they are: account credential lookups use the name stored in `connection.json` instead of recomputing it from the data-home path, so the move changes no keychain name
   - move `~/Library/Application Support/Arbor` to `…/Story`, rewriting `osPath` in `Native Placement.json` and dropping `CLI/`, `Logs/`, `Directory.json`, `Avatars/`, `LinkPreviews/`, `EditorRecovery/`
   - in every placed folder: rename `.arborignore` to `.overstoryignore` and delete stray `*.arbor-write-*` and `*.arbor-txn-*` files
   - delete `accounts/**/session.json` and `workspaces/*/index.sqlite*`, release the lock
3. **Host cutover** (Joe's go-ahead). Settle clients first. Then:
   1. Back up as usual with the old image running; download and check the sha256.
   2. Rehearse on a restored copy: rename the database file, serve with the new build, run `verify.ts`, and confirm members listed as `arbor://tr_…/` still resolve.
   3. Rename the Railway service in place to `overstoryd-arb-nxhx-org`. Do not let `apply` create a second service with an empty volume.
   4. Set the new variables with `--skip-deploys`: `OVERSTORYD_MAINTENANCE=1`, `OVERSTORYD_DOMAIN`, the three bootstrap names, and any hand-set tuning variables found by `railway variable list`. Leave the old variables for rollback.
   5. Confirm the service's Dockerfile path and start command match `Dockerfile.overstoryd` and `bun run overstoryd`.
   6. Merge the branch and push `main`. The build comes up in maintenance mode.
   7. Over `railway ssh`: checkpoint the WAL, `mv /data/canopy.sqlite3 /data/overstoryd.sqlite3`, remove stale `-wal` and `-shm`.
   8. Unset `OVERSTORYD_MAINTENANCE` and redeploy. The log must say "Serving", not "Created and serving".
   9. Run `verify.ts`, then one deliberate integrity call.
4. **Mac cutover** (Joe's go-ahead), in the same window. Take an identity backup. Quit Canopy and remove the old agent: `launchctl bootout gui/$UID/org.nxhx.Arbor.arborsync`, delete its plist in `~/Library/LaunchAgents` if there is one, and remove "Arbor Sync" in Login Items if the app registered it. Run `story migrate`, install Story.app and the `story` CLI, `story daemon install`, then verify with `story status` and one edit round trip. Confirm `~/.arbor` was not recreated.
5. **iPhone** (Joe's go-ahead). Install the new build over the old one; the bundle id is unchanged, so data and pairing carry over. Settle the phone before the host cutover.
6. **Close out.** Record the evidence in `status.md`, delete the `story migrate` code, this plan and `story-icon.webp`. Rename 002 remains; write Rename 003 if the deferred names still matter. After the rollback window, a person deletes the old Railway variables.

## Not in scope

- The names under "Deferred to Rename 003".
- Renaming the GitHub repo `jxe/arbor` and the `~/src/arbor` checkout. Joe does that separately.
- Publishing to npm.

## Conflicts checked (2026-10-10)

Only names installed on a meaningful share of machines count. Measured against Homebrew 365-day installs and Debian popcon, with `git` as the reference (1.45M Homebrew installs, about 182k popcon machines):

- `story`, `story-sync`: no Homebrew formula or cask, no Debian binary, and no npm package that installs a command. The Story L1 blockchain node (piplabs/story) builds a `story` binary that uses `~/.story`, but it is built from source by a few validators and isn't packaged anywhere.
- `overstoryd`: nothing.
- Story.app: no Homebrew cask, and no app named exactly "Story" in the Mac or iOS App Store (US, UK, DE and JP storefronts). The closest names are games and writing tools such as "Story Matching" (8k ratings, iOS) and "Story Planner for Writers".
- Overstory: a climate-tech company and a Canadian media group, neither in our space.
