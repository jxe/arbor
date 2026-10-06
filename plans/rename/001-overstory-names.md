# Rename 001: Arbor and Canopy names become Overstory, ost and Hunch

**Why and when:** the protocol and packages are already Overstory, but the commands, daemons, dot directories, env vars, routes and the app still say Arbor or Canopy, and `canopyd` names the host after the app. Joe settled the names on 2026-10-06 and wants them applied in one cutover, without serving old and new names side by side.

> **Executor instructions**: Apply the name map below everywhere it applies: code, tests, fixtures, spec, docs, scripts and deploy files. Old names are not accepted at runtime after the cutover; the only code that knows them is the throwaway migration in step 6. Changes to live data, the installed Mac and iPhone apps, Railway, and the public host wait for Joe's go-ahead at each step that says so.
>
> **Drift check**: `git diff --stat 23351c7..HEAD -- package.json packages/cli packages/arborsync packages/canopyd packages/canopyd-merge packages/fs/src/ignore-policy.ts packages/protocol swift/project.yml docs/overstory-spec`

## Status

- **Effort**: L
- **Risk**: MEDIUM. Mechanical, but it touches the wire, on-disk names, the keychain and launchd together.
- **Depends on**: nothing
- **Category**: cleanup
- **Planned at**: Overstory `23351c7`, 2026-10-06

## Naming rule

Programs follow djb: one suite prefix, a name that says the one job, and `d` only for a program that serves a protocol. CLI subcommands stay as they are.

- **overstory** is the protocol: `overstory://` locators, `overstory-*` headers, `@overstory/*` packages.
- **ost** is the reserved name and the device side: the `ost` CLI, the `ostd` daemon, `~/.ost`, `OST_*`, and the reserved `.ost` path segment.
- **overstoryd** is the host program and its settings.
- **Hunch** is the app.

`.arbor` is reserved in the spec (02-directory-format §7), and that reservation is what keeps the `/.arbor/` routes from colliding with tree content. So the routes, the excluded directory, the temporaries and the ignore file all become one reserved name, `.ost`.

## Name map

### Programs

| Today | New | Notes |
|---|---|---|
| `canopyd` (`packages/canopyd`) | `overstoryd` | The host. Package directory, bin, Dockerfile, `railway-canopy.ts`, Railway service name. |
| `canopyd-merge`, bin `arbor-merge` | `overstoryd-merge` | Only the host execs it (`packages/canopyd/src/merge-tool.ts:232`). Remove it from the public `bin` list. |
| `arborsync` (`packages/arborsync`) | `ostd` | The device sync daemon. Control API `service: "arborsync"` becomes `"ostd"`, checked by the CLI and the app. |
| `arbor` (`packages/cli`) | `ost` | Same subcommands. `ost daemon …` supervises `ostd`. |
| Canopy.app (`swift/CanopyApp`) | Hunch.app | Display name, product name and bundle ID. Swift `Canopy*` type names may follow later; they are not user-visible. |

### Protocol and spec

| Today | New |
|---|---|
| `arbor://` locators | `overstory://` |
| `/.arbor/*` routes (`trees`, `account`, `accounts`, `account-challenges`, `configurations`, `device-sessions`, `directory`, `execution`, `health`, `integrity`, `pairings`, `profile`, `profiles`) | `/.ost/*` |
| Mandatory-excluded directory `.arbor` | `.ost` |
| Temporaries `.arbor-write-*`, `.arbor-txn-*` | `.ost-write-*`, `.ost-txn-*` |
| `.arborignore` | `.ostignore` |
| Wire headers and fields named `arbor-*` / `x-arbor-*` (`arbor-profile`, `x-arbor-profile-state`, `arbor-access-link`, `arbor-config`, `arbor-rev`, `arbor-run`, …) | `overstory-*`. Confirm which are on the wire; internal ones such as CSS classes and drag types are renamed freely. |
| Conformance vectors that carry any of the above | regenerated |

### Device (`ost`, `ostd`)

| Today | New |
|---|---|
| `~/.arbor`, `~/.arbor/.state`, `~/.arbor/cloud-sessions` | `~/.ost`, … |
| `~/Library/Application Support/Arbor/CLI/…` | `…/Application Support/ost/…` (disposable) |
| `ARBOR_DATA_HOME`, `ARBOR_CREDENTIAL_STORE`, `ARBOR_SYNC_*`, `ARBOR_CLOUD_*`, `ARBOR_REQUIRE_DATA_HOME`, `ARBOR_DISABLE_PERSISTENT_DAEMON`, `ARBOR_ACCOUNT_TOKEN` | `OST_*` (`OST_HOME`, `OST_SYNC_URL`, `OST_PORT`, …) |
| launchd `org.nxhx.Arbor.arborsync` | `org.nxhx.ostd` |
| Keychain `org.arbor.connections`, `org.arbor.person-profile`, `org.arbor.community-account` (and the Swift services in `CanopyWorkingTree`) | `org.nxhx.ost.connections`, `org.nxhx.ost.person-profile`, `org.nxhx.ost.community-account` |
| Port 4317 | unchanged |

### Host (`overstoryd`)

| Today | New |
|---|---|
| `ARBOR_DOMAIN`, `ARBOR_ACCOUNTS_JSON`, `ARBOR_CANOPY_DATA`, `ARBOR_CANOPY_RATE_LIMITS`, `ARBOR_CANOPY_MAINTENANCE`, `ARBOR_OBJECT_CACHE_MB`, `ARBOR_MERGE_*`, `CANOPY_SCHEMA_VERSION` | `OVERSTORYD_*` |
| `canopy.sqlite` | `overstoryd.sqlite` |
| Retained merge formats `arbor-merge-intent-state`, `arbor-merge-saved-entry` | **unchanged**: renaming invalidates retained state for no gain |

### App (Hunch)

| Today | New |
|---|---|
| Bundle ID `org.nxhx.Arbor` and its suffixes (`.device`, `.profile`, `.join`, `.lab`, `.network-log`, `.canopy-path`) | `org.nxhx.Hunch…` |
| URL scheme `canopy://join?…` | `hunch://join?…` |
| `Application Support/Arbor/Identity/setup.sqlite` | `…/Hunch/Identity/setup.sqlite` |
| UI copy "Canopy" for the app | "Hunch". Host-meaning "Canopy" ("People on this Canopy") becomes "host". |

### Tests and dev only

`ARBOR_TEST_*`, `ARBOR_LAB_*`, `ARBOR_SOURCE_TEST_*`, `ARBOR_WIRE_TEST_*` (also drop "WIRE"), `ARBOR_RAILWAY_*`, `ARBOR_PROTOCOL_FIXTURES`, `ARBOR_REFERENCE_FIXTURES`, `ARBOR_FIRST_WRITER_*`, `ARBOR_COMMUNITY_HANDLE`, `CANOPY_MEASURE_MOVES` all become `OST_*` or `OVERSTORYD_*`, after whichever program reads them.

## Steps

1. **Spec and docs.** Update `docs/overstory-spec/` (locators, reserved names, routes, ignore file, headers) and regenerate conformance vectors. Update `README.md`, `DEVELOPMENT.md`, `AGENTS.md`, `docs/`, and the plans that name the old commands.
2. **TypeScript.** Rename the packages and bins, routes, reserved names, env vars, paths, launchd label, keychain services and the control-API `service` value. Gate: `bun run typecheck`, `bun run test:affected`, `bun run test:protocol`, `bun run build:cli:package`, `bun run test:cli:package`, `bun run check:links`.
3. **Swift.** Rename the routes, scheme, keychain services, bundle IDs, product name and copy. Then regenerate `Canopy.xcodeproj` (or its renamed successor) with xcodegen on a Mac, and build and test with `swift/scripts/test-canopy-editor-local.sh` and the app scheme.
4. **Grep gate.** `rg -i 'arbor|canopy'` over the repo returns only the step-6 migration, the retained merge formats, and history in `status.md`.
5. **Host cutover** (Joe's go-ahead). Deploy `overstoryd` to Railway under the new service name and env vars, renaming `canopy.sqlite` on the volume during the deploy. Both clients must ship in the same window, because old clients stop working against `/.ost/`.
6. **Mac migration** (Joe's go-ahead). Run a throwaway `ost migrate` once:
   - stop and unload `org.nxhx.Arbor.arborsync`
   - move `~/.arbor` to `~/.ost`, renaming each tree's `.arbor` directory to `.ost` and `.arborignore` to `.ostignore` in placed folders
   - copy the three keychain items to their new services
   - move the app's data from the `org.nxhx.Arbor` container and `Application Support/Arbor` to Hunch's
   - install and load `org.nxhx.ostd`
   - verify with `ost status` and one edit round trip

   Delete the migration code once it has run.
7. **iPhone** (Joe's go-ahead). The new bundle ID installs as a new app, so delete the old app and pair the new one again. No data handoff.
8. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not in scope

- Renaming Swift `Canopy*` types and the `CanopyApp`, `CanopyEditor`, `CanopyWorkingTree` and `CanopyAppKit` package names. They can follow separately.
- Publishing to npm. `overstory` is taken there by an unrelated project; our scope `@overstory/*` is separate.

## Conflicts checked (2026-10-06)

- `ost`: Debian's OpenStructure ships `/usr/bin/ost` (structural biology, niche). Nothing on Homebrew or in macOS. Accepted.
- `ostd`, `overstoryd`: no binary conflicts on Debian, Homebrew, npm or crates.io. `ostd` is also a Rust kernel library, but it isn't a command.
- Hunch: a small free Mac App Store notes app, "Hunch_" (one rating), and npm `hunch`. Accepted as unpopular.
- Overstory: a climate-tech company and a Canadian media group, neither in our space.
