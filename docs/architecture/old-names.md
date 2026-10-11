# Old names that remain

On 2026-10-10 the names Arbor and Canopy were replaced throughout: Overstory is the protocol, `overstoryd` the host, and Story the app, the `story` command and the `story-sync` daemon. A few old spellings are still in the code on purpose. This page lists them, so a search for `arbor` or `canopy` can be checked against it. Anything else that turns up is a leftover to fix.

Dated history in [status](../../status.md), and the completed migrations 018 to 023 under `packages/overstoryd/migrations/`, also keep old names.

## Never renamed

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

## Kept

Persisted on devices and never shown to people. Changing them costs a keychain migration, an iPhone reinstall and re-pairing. Joe decided on 2026-10-11 to release with them as they are, so the App Store record and the Mac update feed carry `org.nxhx.Arbor`.

- Bundle id `org.nxhx.Arbor` and its suffixes, including the test and lab ids
- Keychain services `org.arbor.person-profile`, `org.arbor.community-account`, `org.arbor.connections` (CLI and daemon) and `org.nxhx.Arbor.profile`, `org.nxhx.Arbor.device…` (iPhone)
- UserDefaults keys `arbor.uiSoundsEnabled`, `Canopy.manuallyNamedPages`; OSLog subsystem `org.arbor.native`

## Read old, write new

These spellings are inside authored content or in links already shared. Readers accept both; writers emit only the new one. The spec describes only the new spellings. [Rename 002](../../plans/cleanups/rename-002-remove-old-spelling-aliases.md) rewrites live content and removes the aliases. Every alias site carries the comment marker `Rename 002` so they can be found.

| Old spelling | Where it is read |
|---|---|
| `arbor://` | The two locator parsers (`packages/protocol/src/model/logical-url.ts`, `StoryKit/LogicalURL.swift`) and every partial parser that tests the scheme itself: `overstoryd/src/profile.ts` (`PROFILE_LOCATOR`, which decides group membership), `protocol/src/model/resource-policy.ts`, `Overstory/ResourcePolicy.swift`, `StoryApp/StoryDirectory.swift` (regex and the exact-string member comparisons), `StoryApp/StoryRootView.swift`, `StoryApp/StoryVisits.swift`, `story-web` (`PageEditor.tsx`, `App.tsx`), `story-sync/src/service.ts`, `cli/src/index.ts`, `apps-runtime/src/authoring.ts` |
| `;arbor-key=`, `;arbor-rev=`, `;arbor-config`, `#arbor-key=` | The same two parsers, plus `protocol/src/config/tree-config.ts`, `overstoryd/src/host.ts`, `protocol/src/transport.ts`, `Overstory/TreeConfiguration.swift` |
| `<!-- arbor:children -->` | `protocol/src/documents/directory-document.ts`, `StoryEditor/MarkdownCodec.swift` |
| `.arborignore` | `fs/src/ignore-policy.ts`, `OverstoryWorkingTree/IgnorePolicy.swift`. When both files exist in a directory, `.overstoryignore` wins. |
| `#arbor-access=` | `overstoryd/src/host.ts` |
| `"source": "arbor-profile"` | `apps-runtime/src/schema.ts`, `sqlite.ts` |

## Cutover guard

`overstoryd` refuses to start when its data root holds `canopy.sqlite3` and no `overstoryd.sqlite3` (`packages/overstoryd/src/cli.ts`). A backup archive made before 2026-10-10 restores under the old file name, so the guard stays until those backups have aged out.
