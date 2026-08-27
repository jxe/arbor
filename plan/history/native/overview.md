# Native Arbor architecture at completion
*Historical architecture and decision record for the Swift Arbor implementation. The original plan sequence is indexed in [`README.md`](README.md); implemented evidence lives in [`../outcomes.md`](../outcomes.md). Remaining hands-on acceptance is [Interface 003](../../interfaces/003-native-acceptance-audit.md).*

## Status and identity

- Quagmire `0.3.0` is published at commit `adab6d6`; Hunch commit `bc2d792` and native Arbor consume the exact remote release. It retains the optional `QuagmireExtras` product for link previews, voice/recovery, App Intent, and transcript polishing and adds the host-neutral async image lifecycle plus link-owned relocation hook. Plan 001 remains the historical `0.1.0` milestone; the remaining hands-on image/title/recovery/accessibility audit is now Interface 003.
- Plans 002–005 captured a superseded TreeHopper/iCloud design and must not be executed. Their files remain as historical evidence.
- The native product is **Arbor**, not TreeHopper: display name and scheme `Arbor`, app module `ArborApp`, bundle ID `org.nxhx.Arbor`, and iOS/macOS 27 deployment targets.
- The app is new work under `native/`; it is not a renamed Hunch target and must not reuse Hunch defaults, caches, bookmarks, logs, app groups, bundle IDs, or iCloud containers.
- Plans 012–016 and 021 are complete: the generated Arbor shell and UI-independent ArborKit contracts build on macOS and iOS 27; independent ArborWire conformance passes the shared fixtures and disposable authority harness; ArborReplica provides the private crash-recoverable offline provider; ArborSync adds authority-owned convergence with immediate verified editor patches, sparse complete-object fallback, and conditional returned snapshots. Plan 016's historical ArborQuagmire milestone used exact Quagmire `0.1.0`; the completed Plan 018 implementation upgraded the bridge and app to exact `0.3.0` plus QuagmireExtras while retaining source-preserving guarded admissions.

Execution order:

1. [006 — reconcile identity and plans](006-reconcile-arbor-identity.md)
2. [007 — server-assisted synchronization contract](007-define-server-assisted-sync.md)
3. [008 — accepted updates and authority synchronization](008-build-authority-sync.md)
4. [009 — arbord synchronization integration](009-integrate-arbord-sync.md)
5. [010 — device credentials and pairing](010-add-device-pairing.md)
6. [011 — Railway authority upgrade](011-migrate-railway-authority.md)
7. [012 — native Arbor shell](012-found-native-arbor.md)
8. [013 — Swift ArborWire](013-build-swift-arbor-wire.md)
9. [014 — offline Swift replica](014-build-offline-replica.md)
10. [015 — native replica sync](015-sync-native-replicas.md)
11. [016 — Quagmire bridge](016-bridge-quagmire.md)
12. [017 — daily-driver core](017-complete-daily-driver.md)
13. [018 — Hunch native strengths](../../interfaces/003-native-acceptance-audit.md) — implementation complete; acceptance extracted
14. [019 — repeatable Hunch conversion rehearsals and adopted cutover](019-convert-hunch-workspace.md)
15. [020 — device-management browser E2E](../../interfaces/004-device-management-browser-e2e.md) — deferred active interface work
16. [021 — immediate editor-patch authority updates](021-add-wire-file-patches.md)

The next cross-workstream product target is the checked-in [Meaning Supplies executable site](../../applications/001-supplies-executable-site.md). Its native gate is deliberately macOS-first: native Arbor presents arborsync's same local executable-document runtime in a constrained web surface while retaining native tab identity, provenance, navigation, and source controls. It does not fork Supplies into Swift. Authority-hosted presentation on iOS may follow once the shared runtime exists; a fully offline iOS executable-document query runtime is a separate explicit milestone rather than an implication of the macOS result.

## Product and persistence boundary

An independently versioned `TreeID` is an **Arbor tree** whether its audience is private, public, or selected people/groups. Sharing changes access; it does not switch storage or synchronization technology.

Cross-device synchronization uses an Arbor authority, never iCloud Drive or CloudKit. The configured Railway authority is the intended acceptance host, but its URL and credentials remain runtime configuration and must never be hardcoded in source, fixtures, plans, logs, or manifests.

- On macOS, native Arbor uses arbord as the sole first-party writer for ordinary folders and placed trees. The directly signed desktop app is intentionally not App Sandbox-confined: it starts and supervises its bundled arbord when no compatible user process is already listening, so that one process can own `~/.arbor` and absolute filesystem navigation. Launch restores the saved folder, migrates the former sandbox preference bookmark once when necessary, and otherwise opens the user's real home directory; “no provider” is never a steady production state. Test helpers use an isolated data home and port range. A future independently persistent arbord should be a user LaunchAgent registered with `SMAppService`, not another app-owned storage implementation.
- macOS tabs retain absolute filesystem locations independently of arbord's resolved node identity. Parent may cross placed-tree boundaries to filesystem `/`; Home means the current resolved tree root and is disabled in ordinary filesystem space. The launch/restored folder is only the new-tab starting location.
- The macOS sidebar's Trees section is a location switcher: placed roots open locally, durable unplaced visits reopen read-only through arbord, and a visit never creates a placement implicitly.
- On iOS, native Arbor uses an app-managed private replica with full offline reads and writes.
- The iOS replica does not appear as a live editable Files-app folder. Import/export/share operations are explicit.
- Each device keeps a local PageID-keyed crash-recovery journal. Recovery journals, indexes, caches, and device identity never enter authored trees or the wire.
- The self-host is trusted with plaintext content in v1. End-to-end encryption and CloudKit are out of scope.

## Server-assisted wire synchronization

Wire refs continue to identify immutable directory-root hashes. The trusted authority keeps a linear accepted-update history for each tree: an opaque update ID, previous accepted root, next accepted root, authenticated credential/device, acceptance time, and, when applicable, the base/candidate/remote roots used for a merge. That audit record is authority state, not another content-addressed wire object and not a revision DAG. Watch cursors use accepted-update IDs so accepting a previously seen root is still a distinct event.

Each client durably remembers its last accepted update and root. An update submission names that `base`, the client's `candidate` root, and any missing immutable file/directory objects. The authority verifies that the base update belongs to the tree and has the named root, then compares it with the current accepted root. It derives request identity by RFC 8785-canonicalizing `{ base, candidate, tree, version: "updates-v1" }` and hashing those UTF-8 bytes; object envelopes are excluded because their ordering and retransmission are transport details. It returns current when the candidate already equals the accepted root or has not changed from base, accepts a one-sided change directly, performs a three-way merge when both sides changed, and compare-and-swaps the resulting root only after rechecking the current ref. Accepted/merged replay evidence lives directly on the accepted-update row.

The self-host is trusted with plaintext, so the server owns the one merge implementation. Clients own local durability, offline editing, exact request retry, graph validation, and conflict presentation. An unsafe merge returns a complete draft snapshot, base/candidate/current identities, and structured reasons directly to the client without advancing or retaining anything on the authority. The client persists that response, may keep editing locally, resolves the remaining choices, and submits a new ordinary update against the returned current update. No side is dropped or turned into an authored conflict-copy file.

Markdown body merging is intentionally additive and source-preserving, informed by Hunch's auto-restore behavior. Unchanged source stays byte-identical. Lines newly present on either side are copied verbatim and placed between the nearest surviving unchanged lines; when direct context disappeared, placement walks outward to a surviving heading/paragraph/list context, then falls back near the end of the containing document. Existing accepted text is placed before incoming text when both additions occupy the same slot. Exact duplicate additions may be collapsed only when identity is unambiguous. Arrival order may affect sibling order, but omission is never an acceptable automatic result: prefer a nearby duplicate to losing a line. Frontmatter key collisions, invalid fence structure, path/kind collisions, incompatible moves, and divergent binary/unknown files remain structured conflicts.

The authority retains accepted-update history indefinitely as private operational state. It exposes neither an accepted-history collection nor historical-object access; every wire subject, including a writer, can retrieve only currently reachable objects. Rejected candidates and conflict drafts remain only in client state and never enter authority history or object authorization.

## Native package architecture

```text
ArborApp
  ├─ ArborKit
  │    ├─ WorkspaceLocation / WorkspaceReference / WorkspaceNode / WorkspaceSurface
  │    ├─ BrowserTabController / WorkspaceCoordinator
  │    ├─ ArbordWorkspaceProvider ─ ArborClient ─ arbord (macOS)
  │    └─ ReplicaWorkspaceProvider ─ ArborReplica ─ ArborWire (iOS)
  ├─ ArborQuagmire
  │    ├─ Markdown codec + private source ledger
  │    ├─ EditorHost implementation
  │    └─ Quagmire 0.3
  └─ QuagmireExtras 0.3
       ├─ Links + transcript-polishing mechanisms via ArborQuagmire
       └─ Voice session/button/App Intent via ArborApp
```

`ArborKit` is UI-independent and node-first. A node may be a Markdown document, bodyless directory, directory document, collection, database row, ordinary file, placeholder, diagnostic, or historical view. It opens a document session only for Markdown-capable surfaces. One `WorkspaceCoordinator` owns the canonical document/write stream per `(tree, PageID)`, with path fallback only while no durable ID exists; duplicate tabs keep independent history, selection, scroll, and inspector presentation.

`WorkspaceLocation` is browser state; `WorkspaceReference` is resolved operational identity. Tabs, history, breadcrumbs, Parent, Home, and sidebar navigation carry locations, while document sessions and mutation APIs carry references. The macOS arbord provider supports local absolute, tree-scoped, and read-only remote locations; in-memory and replica providers remain tree-scoped. Account UI and the Trees sidebar consume one cached `LocalArbordOverview`, refresh its independent resources concurrently, and observe system events rather than performing a fresh sequential authority walk for each presentation.

`ArborQuagmire` is a thin private host. It maps exact provider Markdown to Quagmire blocks, keeps a private BlockID-keyed source ledger, admits every synchronous editor commit before returning, and submits exact source plus `baseContentRevision`. Quagmire remains format-, storage-, navigation-, and Arbor-neutral.

`QuagmireExtras` supplies optional Apple-platform mechanisms, not Arbor product policy. Arbor owns its application-support/cache directories, `PageID` recording destinations, provider/session delivery, toolbar placement, permissions, errors, and shortcut phrases. Xcode requires the `AppShortcutsProvider` and its literal shortcut metadata to remain in the Arbor application target even though `StartVoiceRecordingIntent` and the launch handoff come from `QuagmireExtras`.

Plan 018's image revision belongs to Quagmire core because asynchronous paste/drop ordering, undo grouping, normalization, and resource loading are editor behavior shared by Hunch and Arbor. Arbor still owns tree-scoped root `Assets` placement, provider-authored Markdown sources, authenticated/offline byte reads, read-only policy, and error presentation. Both consumers passed against the same local Quagmire revision before exact `0.3.0` was tagged, then passed again against the remote tag.

## Hunch rehearsal tooling and completed cutover

Native Arbor must reproduce Hunch's accepted daily-use strengths before final adoption: editing and selection, undo, gestures/reorder, mentions/document links, images/assets, emoji/icons, voice/transcription, transcript polishing, native menus/shortcuts, search/backlinks, recovery/history, conflicts, tabs/windows, accessibility, and crash-safe cross-document actions. Arbor remains node-first and browser-like; it does not inherit Hunch's flat page graph or Clamshell storage.

Plan 019 retains repeatable, copy-only rehearsal tooling for the former Hunch workspace. Arbor never opens the source folder for writing, and edits made while evaluating one rehearsal tree never flow back into retained Hunch data or silently seed a later rehearsal. A stable private conversion recipe preserves the same reviewed PageIDs across runs. Every optional future rehearsal gets a fresh destination and run manifest. This is focused operator tooling, not an app import feature.

The disposable repository-local converter is implemented under [`tools/hunch-rehearsal`](../../../tools/hunch-rehearsal). It inventories without writes, drafts a private recipe, requires two identical dry-run confirmations, stages and verifies every output byte before publishing a new destination, and can verify the untouched import baseline afterward. No personal recipe, manifest, content, or hash is checked in. The first private rehearsal was created and verified on 2026-08-25, then opened repeatedly in signed native Arbor builds while the Hunch source remained unchanged.

Joe accepted the Hunch-to-Arbor cutover as already complete on 2026-08-25. The external-backup restoration demonstration and additional promoted/final rehearsal sequence are not requirements. The reviewed conversion contains 70 curated live pages and 17 assets, preserves 61 existing IDs, mints stable reviewed IDs for nine retained ID-less pages, uses `Console.md` as Home, and discards only the seven explicitly reviewed `main N.md` iCloud collision artifacts. Hunch and Arbor must never coauthor the same folder.

## Release gates

The Hunch cutover is complete. A future native release still requires protocol- and artifact-level verification proportionate to its changes:

- deterministic authority merge fixtures and TypeScript/Swift sync-protocol fixtures;
- distinct revocable device credentials and one-time pairing;
- standalone ArborKit, ArborWire, ArborReplica, ArborQuagmire, ArborClient, Quagmire, and QuagmireExtras tests;
- sequential macOS and iOS 27 Xcode builds/tests;
- exact built-app metadata proving the packaged voice intent and Arbor-owned shortcut provider/phrases were extracted;
- two-device offline convergence, crash/restart, history, conflict, and credential-revocation tests;
- full Hunch parity inventory and exact-artifact manual checks;

STOP rather than improvise if deterministic object encodings differ between languages, an automatic merge can omit an added Markdown line, a conflict path would discard either side, Quagmire identity changes under an in-place edit, a local admitted edit depends on network availability for safety, or Hunch/Arbor could write the same source folder.
