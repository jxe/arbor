# Rename 001: Arbor and Canopy names become Overstory and Story

**Why and when:** the protocol and packages are already Overstory, but the commands, daemons, dot directories, env vars, routes and the app still say Arbor or Canopy, and `canopyd` names the host after the app. Joe settled the names on 2026-10-06 and revised them on 2026-10-07. He wants them applied in one cutover, without serving old and new names side by side.

> **Executor instructions**: Apply the name map below everywhere it applies: code, tests, fixtures, spec, docs, scripts and deploy files. Old names are not accepted at runtime after the cutover; the only code that knows them is the throwaway migration in step 7. Changes to live data, the installed Mac and iPhone apps, Railway, and the public host wait for Joe's go-ahead at each step that says so.
>
> **Drift check**: `git diff --stat 23351c7..HEAD -- package.json packages/cli packages/arborsync packages/arborsync-client packages/canopy-web packages/canopyd packages/canopyd-merge packages/fs/src/ignore-policy.ts packages/protocol swift docs/overstory-spec`

## Status

- **Effort**: L. The Swift module and type renames make the diff large, but they are mechanical.
- **Risk**: MEDIUM. Mechanical, but it touches the wire, on-disk names, the keychain and launchd together.
- **Depends on**: nothing
- **Category**: cleanup
- **Planned at**: Overstory `23351c7`, 2026-10-06; names revised 2026-10-07

## Naming rule

Programs follow djb: one suite prefix, a name that says the one job, and `d` only for a program that serves a protocol. CLI subcommands stay as they are.

- **Overstory** is the protocol and everything the spec owns: `overstory://` locators, `overstory-*` headers, `@overstory/*` packages, and the reserved `.overstory` path segment.
- **overstoryd** is the host program and its settings.
- **Story** is the device product, named once the way Tailscale is: Story.app, the `story` CLI, the `storyd` daemon, `~/.story`, `STORY_*`, and Story for the web.

The reserved segment is a spec concept, so it carries the protocol's name, not a client's. Any Overstory client, not only Story, writes `.overstory` into placed folders. The spec reserves `.arbor` in 02-directory-format §7, and that reservation is what keeps the `/.arbor/` routes from colliding with tree content. So the routes, the excluded directory, the temporaries and the ignore file all move to one reserved name, `.overstory`. It is long, but people rarely type it, and it is the name least likely to collide with real tree content.

`story` was chosen for how it sounds in a command. A good CLI name leaves the stress free for the subcommand: either it is a light syllable (`git push`) or it is stressed then unstressed (`ar-bor SYNC`, `sto-ry SYNC`). A heavy syllable such as `ost` or `hunch` takes the stress itself and collides with the subcommand.

## Name map

### Programs

| Today | New | Notes |
|---|---|---|
| `canopyd` (`packages/canopyd`) | `overstoryd` | The host. Package directory, bin, Dockerfile, `railway-canopy.ts`, Railway service name. |
| `canopyd-merge`, bin `arbor-merge` | `overstoryd-merge` | Only the host execs it (`packages/canopyd/src/merge-tool.ts:232`). Remove it from the public `bin` list. |
| `arborsync` (`packages/arborsync`) | `storyd` | The device sync daemon. Control API `service: "arborsync"` becomes `"storyd"`, checked by the CLI and the app. |
| `arborsync-client` (`packages/arborsync-client`) | `storyd-client` | |
| `arbor` (`packages/cli`) | `story` | Same subcommands. `story daemon …` supervises `storyd`. |
| Canopy.app (`swift/CanopyApp`) | Story.app | Display name, product name and bundle ID. Modules and types are under [Swift modules and types](#swift-modules-and-types). |
| `canopy-web` (`packages/canopy-web`) | `story-web` | Story for the web. `plans/canopy-web/` becomes `plans/story-web/`. |

### Protocol and spec

| Today | New |
|---|---|
| `arbor://` locators | `overstory://` |
| `/.arbor/*` routes (`trees`, `account`, `accounts`, `account-challenges`, `configurations`, `device-sessions`, `directory`, `execution`, `health`, `integrity`, `pairings`, `profile`, `profiles`) | `/.overstory/*` |
| Mandatory-excluded directory `.arbor` | `.overstory` |
| Temporaries `.arbor-write-*`, `.arbor-txn-*` | `.overstory-write-*`, `.overstory-txn-*` |
| Locator parameters `;arbor-key=`, `;arbor-rev=` | `;overstory-key=`, `;overstory-rev=` |
| (new) | `;overstory-invite=<code>` on an account locator: a one-time invitation to claim that account. See [Join links](#join-links). |
| `.arborignore` | `.overstoryignore` |
| Wire headers and fields named `arbor-*` / `x-arbor-*` (`arbor-profile`, `x-arbor-profile-state`, `arbor-access-link`, `arbor-config`, `arbor-rev`, `arbor-run`, …) | `overstory-*`. Confirm which are on the wire; internal ones such as CSS classes and drag types are renamed freely. |
| Conformance vectors that carry any of the above | regenerated |

### Device (`story`, `storyd`)

| Today | New |
|---|---|
| `~/.arbor`, `~/.arbor/.state`, `~/.arbor/cloud-sessions` | `~/.story`, … |
| `~/Library/Application Support/Arbor/CLI/…` | `…/Application Support/Story/CLI/…` (disposable). It shares the `Story` folder with the app, as `Arbor` does today. |
| `ARBOR_DATA_HOME`, `ARBOR_CREDENTIAL_STORE`, `ARBOR_SYNC_*`, `ARBOR_CLOUD_*`, `ARBOR_REQUIRE_DATA_HOME`, `ARBOR_DISABLE_PERSISTENT_DAEMON`, `ARBOR_ACCOUNT_TOKEN` | `STORY_*` (`STORY_HOME`, `STORY_SYNC_URL`, `STORY_PORT`, …) |
| launchd `org.nxhx.Arbor.arborsync` | `org.nxhx.storyd` |
| Keychain `org.arbor.connections`, `org.arbor.person-profile`, `org.arbor.community-account` (and the Swift services in `CanopyWorkingTree`) | `org.nxhx.story.connections`, `org.nxhx.story.person-profile`, `org.nxhx.story.community-account` |
| Port 4317 | unchanged |

### Host (`overstoryd`)

| Today | New |
|---|---|
| `ARBOR_DOMAIN`, `ARBOR_ACCOUNTS_JSON`, `ARBOR_CANOPY_DATA`, `ARBOR_CANOPY_RATE_LIMITS`, `ARBOR_CANOPY_MAINTENANCE`, `ARBOR_OBJECT_CACHE_MB`, `ARBOR_MERGE_*`, `CANOPY_SCHEMA_VERSION` | `OVERSTORYD_*` |
| `canopy.sqlite` | `overstoryd.sqlite` |
| Public host `arb.nxhx.org` | unchanged: the domain is in every canonical URL |
| Retained merge formats `arbor-merge-intent-state`, `arbor-merge-saved-entry` | **unchanged**: renaming invalidates retained state for no gain |

### App (Story)

| Today | New |
|---|---|
| Bundle ID `org.nxhx.Arbor` and its suffixes (`.device`, `.profile`, `.join`, `.lab`, `.network-log`, `.canopy-path`) | `org.nxhx.Story…` |
| URL scheme `canopy` | `overstory`, so Story opens any `overstory://` locator, join links included |
| `Application Support/Arbor/Identity/setup.sqlite` | `…/Story/Identity/setup.sqlite` |
| UI copy "Canopy" for the app | "Story". Host-meaning "Canopy" ("People on this Canopy") becomes "host". |

### Join links

Today the Add Person sheet shows `canopy://join?account=<account URL>&code=<code>`. An `overstory://join?…` link would not parse, because 03-locators treats the authority as either a `tr_` TreeID or a DNS name, so `join` reads as a host. Use the account's own locator instead and carry the code as a locator parameter. Locators already carry secrets this way (`;overstory-key=`):

```text
overstory://arb.nxhx.org/~alice;overstory-invite=<code>
```

Story registers the `overstory` scheme. When the locator it opens carries `overstory-invite`, Story starts onboarding and the claim, as `canopy://join` does now. Without the parameter, Story opens the locator as usual. Add the parameter to 03-locators and to 04-accounts-and-devices §12, and update `docs/implementing-editors/design.md`.

### Swift modules and types

| Today | New |
|---|---|
| Xcode project `Canopy` (`swift/project.yml`), `Canopy.xcodeproj`, `Canopy.local.xcworkspace`, app target and scheme `Canopy` | `Story`, `Story.xcodeproj`, `Story.local.xcworkspace` |
| `swift/CanopyApp`, `swift/CanopyAppTests`, `Canopy.entitlements` | `swift/StoryApp`, `swift/StoryAppTests`, `Story.entitlements` |
| `arborsync.entitlements`, build phase "Build arborsync helper" | `storyd.entitlements`, "Build storyd helper" |
| `CanopyAppKit` | `StoryAppKit` |
| `CanopyEditor` | `StoryEditor` |
| `CanopyWorkingTree` | `OverstoryWorkingTree`: generic client machinery, the counterpart of `@overstory/working-tree`, alongside `Overstory`, `OverstoryClient` and `OverstoryObjectStore` |
| `swift/scripts/test-canopy-editor-local.sh`, `test-canopy-app.sh` | `test-story-editor-local.sh`, `test-story-app.sh`, updating every reference (`AGENTS.md`, `DEVELOPMENT.md`, `swift/README.md`, `tools/affected-tests.ts`, …) |
| `Canopy*` type and file names (`CanopyAppModel`, `CanopyDocumentBinding`, `CanopyMarkdownCodec`, …) | The prefix follows the module: `Story*` in the app, `StoryAppKit` and `StoryEditor`, and `Overstory*` in `OverstoryWorkingTree`. Where "Canopy" means the host (`CanopyAccount`, "on this Canopy"), use `Host*`. List those judgment calls in the commit message. |

### Tests and dev only

`ARBOR_TEST_*`, `ARBOR_LAB_*`, `ARBOR_SOURCE_TEST_*`, `ARBOR_WIRE_TEST_*` (also drop "WIRE"), `ARBOR_RAILWAY_*`, `ARBOR_PROTOCOL_FIXTURES`, `ARBOR_REFERENCE_FIXTURES`, `ARBOR_FIRST_WRITER_*`, `ARBOR_COMMUNITY_HANDLE`, `CANOPY_MEASURE_MOVES` all become `STORY_*` or `OVERSTORYD_*`, after whichever program reads them.

## Steps

1. **Spec and docs.** Update `docs/overstory-spec/` (locators, reserved names, routes, ignore file, headers) and regenerate conformance vectors. Update `README.md`, `DEVELOPMENT.md`, `AGENTS.md`, `docs/`, and the plans that name the old commands.
2. **TypeScript.** Rename the packages and bins, routes, reserved names, env vars, paths, launchd label, keychain services and the control-API `service` value. Gate: `bun run typecheck`, `bun run test:affected`, `bun run test:protocol`, `bun run build:cli:package`, `bun run test:cli:package`, `bun run check:links`.
3. **Swift modules and types.** Apply the Swift modules and types table as its own commit with no behavior change. Regenerate `Story.xcodeproj` with xcodegen on a Mac, then build and test with `swift/scripts/test-story-editor-local.sh` and the `Story` scheme. Keep Quagmire in editable mode and leave its lock alone, as `AGENTS.md` describes.
4. **Swift runtime names.** Rename the routes, the URL scheme and join links, keychain services, bundle IDs, product name and copy. Build and test as in step 3.
5. **Grep gate.** `rg -i 'arbor|canopy'` over the repo returns only the step-7 migration, the retained merge formats, and history in `status.md`.
6. **Host cutover** (Joe's go-ahead). Deploy `overstoryd` to Railway under the new service name and env vars, renaming `canopy.sqlite` on the volume during the deploy. Both clients must ship in the same window, because old clients stop working against `/.overstory/`.
7. **Mac migration** (Joe's go-ahead). Run a throwaway `story migrate` once:
   - stop and unload `org.nxhx.Arbor.arborsync`
   - move `~/.arbor` to `~/.story`, renaming each tree's `.arbor` directory to `.overstory` and `.arborignore` to `.overstoryignore` in placed folders
   - copy the three keychain items to their new services
   - move the app's data from the `org.nxhx.Arbor` container and `Application Support/Arbor` to Story's
   - install and load `org.nxhx.storyd`
   - verify with `story status` and one edit round trip

   Delete the migration code once it has run.
8. **iPhone** (Joe's go-ahead). The new bundle ID installs as a new app, so delete the old app and pair the new one again. No data handoff.
9. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not in scope

- Renaming the GitHub repo `jxe/arbor` and the `~/src/arbor` checkout. Joe does that separately.
- Publishing to npm. `overstory` is taken there by an unrelated project; our scope `@overstory/*` is separate.

## Conflicts checked (2026-10-07)

Only names installed on a meaningful share of machines count. Measured against Homebrew 365-day installs and Debian popcon, with `git` as the reference (1.45M Homebrew installs, about 182k popcon machines):

- `story`, `storyd`: no Homebrew formula or cask, no Debian binary, and no npm package that installs a command. The Story L1 blockchain node (piplabs/story) builds a `story` binary that uses `~/.story`, but it is built from source by a few validators and isn't packaged anywhere.
- `overstoryd`: nothing.
- Story.app: no Homebrew cask, and no app named exactly "Story" in the Mac or iOS App Store (US, UK, DE and JP storefronts). The closest names are games and writing tools such as "Story Matching" (8k ratings, iOS) and "Story Planner for Writers". `org.nxhx.Story` is unclaimed.
- Overstory: a climate-tech company and a Canadian media group, neither in our space.
