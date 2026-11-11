# Old names that remain

On 2026-10-10 the names Arbor and Canopy were replaced throughout: Overstory is the protocol, `overstoryd` the host, and Story the app, the `story` command and the `story-sync` daemon. A few old spellings are still in the code on purpose. This page lists them, so a search for `arbor` or `canopy` can be checked against it. Anything else that turns up is a leftover to fix.

Dated history in [status](../../status.md) also keeps old names.

## Never renamed

Opaque tags and names. Some are hashed into identifiers or authenticate artifacts that already exist, so a new spelling would change identities or orphan data for no gain.

- `arbor-update/2`, the domain inside every update's request digest until the Protocol 003 flag day, when it becomes `overstory-update/1` (and the older `arbor-update` bytes pinned in two compatibility vectors)
- `arbor-tree-config-v1` and `arbor-person-profile-v1`, hashed into configuration-tree IDs and profile identities
- `arbor-profile-backup-v2`, which authenticates saved identity backups
- `arbor-device-key:v1:`, `arbor-cloud-v1`, `arbor-cloud-v2`
- `arbor-merge-records-1`, `arbor-merge-intent-state`, `arbor-merge-saved-entry`
- The `__arbor_` table prefix inside trees' own `_store.sqlite3` files
- `arbor-child-…` generated block ids
- `https://canopy.example` inside `conformance/device-keys.json`, which is signed and has no generator
- Outside the repo: the lab's hcloud context and Hetzner key `arbor-lab`, the Tailscale tag `tag:arbor-lab`, and `~/.ssh/arbor_hetzner`

## Kept

Persisted on devices and never shown to people. Changing them costs a keychain migration, an iPhone reinstall and re-pairing. Joe decided on 2026-10-11 to release with them as they are, so the App Store record and the Mac update feed carry `org.nxhx.Arbor`.

- Bundle id `org.nxhx.Arbor` and its suffixes, including the test and lab ids
- Keychain services `org.arbor.person-profile`, `org.arbor.community-account`, `org.arbor.connections` (CLI and daemon) and `org.nxhx.Arbor.profile`, `org.nxhx.Arbor.device…` (iPhone)
- UserDefaults keys `arbor.uiSoundsEnabled`, `Canopy.manuallyNamedPages`; OSLog subsystem `org.arbor.native`
- A device's state directory `.arbor` and the `.arbor-write-` / `.arbor-txn-` temporaries, which builds from before the rename left in placed folders. They stay never-content (`fs/src/ignore-policy.ts`, `fs/src/discovery.ts`, `OverstoryWorkingTree/IgnorePolicy.swift`, `WorkingTreeSemantics.validateName`), so a stray one is never published; `tests/fixtures/old-names/kept.json` holds their cases.

The old spellings in authored content and links (`arbor://`, `;arbor-key=`, `;arbor-rev=`, `;arbor-config`, `#arbor-key=`, `<!-- arbor:children -->`, `.arborignore`, `#arbor-access=`) are no longer read: Rename 002 rewrote the last of them in live trees and removed the aliases on 2026-10-25 ([status](../../status.md#old-spellings-no-longer-read--2026-10-25)).

## Spec chapters before the layers

On 2026-11-11 the spec's numbered chapters became five layers. Code comments that cite an old chapter and section, such as "tree operations §1.1.3", refer to these:

| Old chapter | Now |
|---|---|
| 01 tree operations | [data model](../overstory-spec/1.1-data-model.md) (the model, objects, entry times, CBOR) and [reading and watching](../overstory-spec/1.2-reading-and-watching.md) (reads, watch, encodings) and [updates and merging §1, §3](../overstory-spec/1.3-updates-and-merging.md) (updates); §1.3 canonical-URL reads moved to [locators §6](../overstory-spec/1.6-locators.md#6-reading-at-the-canonical-url), §3 editor round trip to [working trees](../overstory-spec/2.1-working-trees.md) |
| 02 directory format | [data model §8–12](../overstory-spec/1.1-data-model.md) (bodies, pages, pages with children, recognized and reserved names), [placements on disk](../overstory-spec/2.2-placements-on-disk.md) (frontmatter on disk, membership), old §4 is data model §10 |
| 03 locators | [locators](../overstory-spec/1.6-locators.md) |
| 04 accounts and devices | [accounts and devices](../overstory-spec/3.1-accounts-and-devices.md); §4 local placements moved to [placements on disk §7](../overstory-spec/2.2-placements-on-disk.md#7-local-placements); placement accounts, invitations as placements, published device keys and visitor sessions moved to [federation](../overstory-spec/3.3-federation.md) |
| 05 access control | [access control](../overstory-spec/3.2-access-control.md) |
| 06 child backings | [collections](../overstory-spec/1.4-collections.md) (§1–2.3, 2.5), [placements on disk §4–6](../overstory-spec/2.2-placements-on-disk.md) (projections, SQLite, migration), Postgres moved to [Postgres 001](../../plans/later/postgres-001-postgres-backed-collections.md), [apps](../overstory-spec/4.1-apps.md) (§5–6) |
| 07 executable documents | [apps](../overstory-spec/4.1-apps.md) |
| 08 authoring API | [apps](../overstory-spec/4.1-apps.md) |
| 09 client synchronization | [working trees](../overstory-spec/2.1-working-trees.md) |
| 10 source intent | [updates and merging §2–3](../overstory-spec/1.3-updates-and-merging.md) |
| 11 schema language | [VAD](../overstory-spec/1.5-vad.md) |
| 12 presence | [reading and watching §3](../overstory-spec/1.2-reading-and-watching.md#3-presence) |
| implementing-sync-services/porting-a-client.md | still the porting guide; its three ways to hold a tree are [working trees §1](../overstory-spec/2.1-working-trees.md#1-three-ways-to-hold-a-tree) and local placements are [placements on disk §7](../overstory-spec/2.2-placements-on-disk.md#7-local-placements) |
