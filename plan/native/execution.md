# Native Arbor implementation plans

These handoffs build separate components in dependency order. Each executor must read its assigned plan fully, run the drift check before editing, honor its scope and STOP conditions, run every verification gate, and update the status row here. Completing one plan does not authorize opportunistic implementation of a later milestone.

Plans were originally written against Arbor `dc34126`, Hunch `a1e8379`, and Quagmire `4049fd4` on 2026-08-23. Plans 012 and 013 were reconciled against clean Arbor `0c53964`; Plan 014 was reconciled after them at `3117f93`; Plans 015 and 016 were reconciled after Plan 014 at `01776d6`; Plan 017 was reconciled at `1def896` and completed in the working tree on 2026-08-24. Later executors must still reconcile live source before relying on any snapshot.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [001](001-publish-quagmire.md) | Publish Quagmire 0.1.0 and prove remote Hunch consumption | P1 | M | implemented foundation | DONE — Quagmire `0.1.0`, Hunch `a1e8379` |
| [002](002-found-treehopper-native.md) | Freeze identity and found TreeHopper | — | — | 001 | REJECTED — superseded by Plans 006–019 |
| [003](003-bridge-quagmire-to-arbor.md) | Bridge Quagmire under the TreeHopper plan | — | — | 001, 002 | REJECTED — superseded by Plans 012, 016 |
| [004](004-build-arbor-cloud-durability.md) | Build direct iCloud durability | — | — | 002, 003 | REJECTED — Arbor wire is the only cross-device sync |
| [005](005-complete-native-parity-and-migration.md) | Combine parity, import, and release | — | — | 003, 004 | REJECTED — split into Plans 017–019 |
| [006](006-reconcile-arbor-identity.md) | Reconcile Arbor identity and native planning | P1 | M | — | DONE — Arbor identity and active wording reconciled |
| [007](007-define-server-assisted-sync.md) | Define server-assisted synchronization | P1 | M | 006 | DONE — accepted-update contract and shared merge fixtures verified |
| [008](008-build-authority-sync.md) | Build accepted updates and authority synchronization | P1 | XL | 007 | DONE — live authority and clean-schema runtime verified |
| [009](009-integrate-arbord-sync.md) | Integrate arbord synchronization | P1 | L | 008 | DONE — local two-placement sync and client-owned conflicts verified |
| [010](010-add-device-pairing.md) | Add revocable device credentials and pairing | P1 | L | 008 | DONE — live pairing/revocation verified; browser hardening moved to 020 |
| [011](011-migrate-railway-authority.md) | Upgrade the Railway authority | P1 | M | 009, 010 | DONE — clean live cutover, private smoke, and arbord reconnect verified |
| [012](012-found-native-arbor.md) | Found the native Arbor shell | P1 | L | 006 | DONE — generated Arbor app, ArborKit contracts, and lifecycle tests verified |
| [013](013-build-swift-arbor-wire.md) | Build the Swift ArborWire package | P1 | L | 007, 008, 010 | DONE — shared fixtures and disposable-authority conformance verified |
| [014](014-build-offline-replica.md) | Build the offline Swift replica | P1 | XL | 007, 012 | DONE — durable offline provider and fault recovery verified |
| [015](015-sync-native-replicas.md) | Synchronize native replicas through Arbor | P1 | XL | 009, 011, 013, 014 | DONE — crash-safe returned-snapshot sync and native pairing/placement verified |
| [016](016-bridge-quagmire.md) | Bridge Quagmire to Arbor documents | P1 | XL | 012, 014 | DONE — exact-source Quagmire bridge and unchanged-package gates verified |
| [017](017-complete-daily-driver.md) | Complete the native daily-driver core | P1 | XL | 015, 016 | DONE — shared providers, signed sandboxed `arbord` helper, and daily-driver workflows verified |
| [018](018-port-hunch-strengths.md) | Port Hunch's native strengths | P1 | XL | 017 | TODO |
| [019](019-convert-hunch-workspace.md) | Convert the live Hunch workspace and cut over | P1 | L | 018 | TODO |
| [020](020-test-device-management-browser.md) | Complete device-management browser E2E | P2 | S | 010 | TODO |
| [021](021-add-wire-file-patches.md) | Add verified wire file patches | P2 | L | 015, 016 | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale).

## Dependency notes

- 006 records identity and retires contradictory active plans before any persisted native identity exists.
- 007 freezes root-based sync, conflict, retention, and additive Markdown merge behavior before storage or clients consume it.
- 008 implements the sole merge engine and retained linear history on a local/test authority; 011 is the separately authorized live rollout.
- 009 integrates arbord with the authority-owned merge protocol; Swift consumes the same protocol and server fixtures in 015 rather than porting the merge engine.
- 010 lands device credentials before either the live rollout or the native client depends on them.
- 012 and 013 may be developed after their stated dependencies, but the recommended execution remains serial so each handoff starts from a verified main branch.
- 014 proves local safety without a network; 015 adds synchronization without changing local durability.
- 016 proves exact editor persistence independently of the broad product surface.
- 019 is the only milestone allowed to read the live Hunch workspace or create its converted destination.
- 020 is later browser-surface hardening. It does not block the already verified device protocol, Railway migration, or native implementation sequence.
- 021 is a post-sync performance extension. Plans 015 and 016 use complete immutable file objects and must not depend on patch transport.

## Decisions carried by the plan set

- Product identity is Arbor / `org.nxhx.Arbor`, targeting iOS and macOS 27.
- Cross-device sync uses immutable Arbor directory roots plus linear retained authority history on the trusted self-host. There is no revision DAG. No iCloud Drive, CloudKit, editable Files replica, or end-to-end encryption enters v1.
- macOS writes through arbord; iOS writes through an app-managed replica.
- The authority retains synchronized history indefinitely in v1. Historical bytes require write access.
- The authority performs automatic merges. Markdown body merges preserve added lines from both sides near surviving context and prefer duplication over omission; unsafe structural/binary/frontmatter overlap remains visible without conflict copies or data loss.
- A paired device receives its own revocable Keychain credential.
- Quagmire stays at exact `0.1.0` unless a separately reviewed package defect requires a release.
- Hunch conversion is a bespoke operator action, not a permanent application feature.

## Considered and rejected

- **Directly coauthor an iCloud Drive folder:** rejected because it recreates Hunch's mutable-file, placeholder, NSFileVersion, and cross-language journal races.
- **Use CloudKit as canonical content storage:** rejected because Arbor already has a portable tree/wire model and the app must remain usable with ordinary macOS folders.
- **Use an online-only iOS client:** rejected because the accepted product requires a full offline replica.
- **Expose the iOS replica as an editable Files folder:** rejected because external coauthors would reintroduce a second mutation authority.
- **Add content-addressed revision/DAG objects:** rejected because the authority already has the client's explicit base and a linear accepted-root history; making every client reproduce ancestry and merge logic adds wire and cross-language complexity without improving v1 recovery.
- **Automatically duplicate conflicted files:** rejected because it obscures intent and pollutes authored trees; preserve explicit local/remote branches instead.
- **Turn Hunch into Arbor in place:** rejected because Hunch's flat Clamshell ontology, persisted identity, and live workspace must remain independently recoverable.
