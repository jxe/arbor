# Rename 003: bundle and keychain identifiers

**Why and when:** Joe wants the Mac app downloadable and the iPhone app on TestFlight and then the App Store. A bundle ID is permanent once an App Store record or an update feed names it, and today's is `org.nxhx.Arbor`. Joe decided on 2026-10-10 to change it to `org.nxhx.Story` before any build leaves his machines. Do this before [Release 001](../release/001-mac-release.md) and [Release 002](../release/002-testflight.md), when Joe has an hour to migrate his own Mac and re-pair his iPhone.

> **Executor instructions**: The code change can land at any time; nothing takes effect until a build is installed. Installing it, migrating the Mac keychain and re-pairing the iPhone each wait for Joe's go-ahead. Rehearse the migration with a disposable `STORY_HOME` and a throwaway identity first.

## Status

- **Effort**: M
- **Risk**: MEDIUM. The Mac keychain holds Joe's profile identity. A backup is step 1.
- **Depends on**: nothing
- **Category**: cleanup, release prerequisite

## What changes

The "Deferred" list in [old names](../../docs/architecture/old-names.md) is the scope.

| Old | New | Where |
|---|---|---|
| `org.nxhx.Arbor`, `org.nxhx.ArborTests`, `org.nxhx.Arbor.join` | `org.nxhx.Story`, `org.nxhx.StoryTests`, `org.nxhx.Story.join` | `swift/project.yml` |
| `org.nxhx.Arbor.lab` | `org.nxhx.Story.lab` | `swift/scripts/conflict-lab.ts` |
| `AssociatedBundleIdentifiers` `org.nxhx.Arbor` | `org.nxhx.Story` | `swift/StoryApp/org.nxhx.story.sync.plist` |
| `org.nxhx.Arbor.profile`, `org.nxhx.Arbor.device…` | `org.nxhx.Story.profile`, `org.nxhx.Story.device…` | `swift/Packages/OverstoryClient` (`Credentials.swift`) |
| `org.arbor.person-profile`, `org.arbor.community-account`, `org.arbor.connections` | `org.nxhx.story.person-profile`, `.community-account`, `.connections` | `packages/client/src` (`profile-identity.ts`, `server-config.ts`, `connections.ts`) |
| `arbor.uiSoundsEnabled`, `Canopy.manuallyNamedPages` | `story.uiSoundsEnabled`, `story.manuallyNamedPages` | Story app |
| OSLog subsystem `org.arbor.native` | `org.nxhx.story` | Story app and Swift packages |

The launch agent label `org.nxhx.story.sync` already has its new name and stays.

## Decisions

- One cut. No reader accepts both spellings after the migration pass is deleted.
- The Mac and CLI keychain items are migrated, because they hold the profile identity. The iPhone holds only a device key, so it is reinstalled and paired again.
- UserDefaults values are not migrated; they are two preferences.

## Steps

1. **Rename in source**, every row above, and regenerate `Story.xcodeproj`. Rewrite the "Deferred" section of old names to say it is done. Gate: `swift/scripts/test-story-app.sh`, `bun run test:affected`, and `rg 'org\.nxhx\.Arbor|org\.arbor'` returns only history.
2. **Write the one-time keychain pass** for the three Mac and CLI stores: read the old service, write the new one, read it back and compare, then delete the old item. The identity metadata stores a `credential` reference that embeds the service name (`packages/client/src/profile-identity.ts`); the pass rewrites it. Mark the pass with the comment `Rename 003` for deletion in step 6. Unit-test it against the file credential store.
3. **Rehearse** with a disposable `STORY_HOME` and a throwaway identity: old build creates the identity, new build migrates it, and `GET /v1/accounts` still answers. Check whether a keychain read from the launch agent prompts or fails; if it fails, the app performs the pass in the foreground before starting the agent.
4. **Migrate Joe's Mac** (Joe's go-ahead, in one sitting with the first Developer ID install from Release 001 so keychain prompts happen once):
   1. Back up the identity with `story me backup` and copy `~/.story`.
   2. In the old app, unregister the launch agent; `launchctl bootout gui/$UID/org.nxhx.story.sync`; quit.
   3. Install the new build, approve the login item, and confirm `GET /v1/accounts` and a sync to Current.
   4. If a stale login item for the old bundle remains, remove it in System Settings. `sfltool resetbtm` resets every login item on the Mac and is the last resort.
5. **Re-pair Joe's iPhone** (Joe's go-ahead): sync to idle, delete the old app, install the new one, pair from the Mac, and remove the old device from the account's devices.
6. **Close out.** Delete the keychain pass and its test, record the evidence in `status.md`, and delete this plan.

## Not verified

- Whether macOS shows one keychain prompt per item when the helper's signature changes, and whether a background agent can show it at all.
- Whether the same agent label under a new bundle ID leaves a stale Login Items entry.
