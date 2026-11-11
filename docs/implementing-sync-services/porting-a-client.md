# Porting the client library

*Reference documentation, not part of the spec. The three ways a client holds a tree are [working trees §1](../overstory-spec/2.1-working-trees.md#1-three-ways-to-hold-a-tree); local placements are [placements on disk §7](../overstory-spec/2.2-placements-on-disk.md#7-local-placements).*

The client library exists once per language (TypeScript and Swift now), and
every port has the same seven modules with the same interfaces and the same
conformance files. A port is complete when an app written on it can hold a
tree in each of the three ways. §2 gives the order to build the modules
in, what each one holds, and which conformance files check it.
`bun tools/client-parity.ts` lists each module's public types in TypeScript
and Swift and flags the ones only one side has; extend its module table when
you add a language.

## 1. The modules, in the order to build them

A module depends only on modules above it. Platform things (storage,
keychains, sockets) come in through small interfaces.

| # | Module | Holds | TypeScript | Swift | Conformance |
|---|---|---|---|---|---|
| 1 | protocol | canonical CBOR, objects, pages, directories, deltas, source traces, locators, the HTTP client, SSE, path reads | `@ovst/protocol` | `Overstory` | `canonical-cbor-*`, `protocol-*.json` (including `protocol-path-reads.json`), `pages.json`, `directory-documents.json`, `url-resolution.json`, `markdown-*.json`, `observation-events*.sse`, `presence-events*.sse`, `errors.json`, `device-keys.json` |
| 2 | objects | `ObjectSource` and its chain; memory, disk and host sources | `@ovst/object-store` (`./sources` is browser-safe) | `OverstoryObjectStore` | `protocol-objects.json`, `protocol-snapshot-bundles.json` |
| 3 | tree | the lazy node index: directories load on first use, kept by hash across roots; the prefetch policies run over it | `NodeIndex` in `@ovst/working-tree` | `WorkingTree` (not yet lazy) | `node-model.json`, `node-targets.json`, `stable-key-tokens.json` |
| 3b | folder (daemons only) | the folder `AcceptedTree` that writes accepted files to disk | `@ovst/fs` | not needed | `source-preservation.json` |
| 4 | sync | local changes, the change log, the update machine, the coordinator, publication, review | `@ovst/working-tree` | `OverstoryWorkingTree` | `client-state-machines.json`, `coalesced-publication.json` (the publication compiler: `publication`, `composePlainRuns`, `composeMoves`), `protocol-update-intent.json`, `source-*.json`, `entry-actions.json`, `accepted-ambiguity.json` |
| 5 | session | `TreeSession`: open a tree with settings, the three ways, prefetch, opening a page with one path read, following the watch (payload-free where the session holds only part of the tree) | `TreeSession` in `@ovst/working-tree` | `TreeSession` in `OverstoryClient` | the path-read and watch vectors of module 1, through the session |
| 6 | accounts | device keys, sessions (a data home's key opens them for every local client), visitor sessions, pairing, placements, consent | `@ovst/client`, `HostAccountStore` in `@ovst/protocol` | `OverstoryClient` (`DataHomeAccountStore` beside Story Sync, Keychain stores on phones) | `protocol-account-challenges.json`, `device-keys.json`, `invitations.json`, `agent-code.json`, `tree-configuration.json` |
| 7 | workspace | what an editor or UI uses: resolve, children, open a document, admit edits, search, presented pages | Story Sync's `Workspace` | `OverstoryWorkspace` | `page-presentation.json`, `presented-views.json`, `collection-schemas.json`, `markdown-links.json` |

Outside the library, in each language: editors, app UI, and the daemon process
(Story Sync is module 5 with a folder, plus a loopback server).

## 2. Building a port

1. **Protocol.** Pass every module-1 vector before anything else; every later
   module trusts its codec. The HTTP client needs the standard reads
   (descriptor, snapshot, path read, object, entry metadata, watch with
   `objects=none`) and the update submission.
2. **Objects.** A source answers bytes or a miss; the chain checks each answer
   against its hash and falls through on a miss or wrong bytes, so a stale
   folder file never shows. When no source has the object and one failed,
   report the failure, not a miss, so the caller can tell offline from absent.
3. **Tree.** The index starts from a root hash and loads a directory only when
   a path below it is asked for. Keep decoded directories by hash: a newer
   root then loads only what changed. Never let an edit be computed from a
   directory the index did not get through the chain.
4. **Sync.** Port the update machine as a pure reducer first and run
   `client-state-machines.json`; then the coordinator around it and the change
   log, then publication (`coalesced-publication.json`).
5. **Session.** Open a tree from settings; Browse first (descriptor, then a
   path read per opened page, then the payload-free watch), then Replica
   (whole snapshot to disk), then Alongside Story Sync if the platform runs it.
6. **Accounts.** Device keys and sessions; on a desktop beside Story Sync, read
   the data home's connection records and key and share its `session.json`
   (see [Story Sync API §3b](story-sync-api.md#3b-sessions)).
7. **Workspace.** The interface an editor binds to, over the session.

Run `bun tools/client-parity.ts <module>` as you go; `--strict` fails when a
type that `parity.json` requires in both ports has no twin.
