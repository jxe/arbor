# @overstory/arborsync

Arbor Sync, the per-user local daemon, and the `arborsync` command. It keeps
placed folders synchronized with their hosts and serves the loopback REST API
that the `arbor` command and the Canopy app use.

- `server.ts` composes the handlers: `sync-http.ts` and `service.ts`
  (placements, bootstrap, events, held changes), `account-http.ts` and
  `account-service.ts` (identity, credentials, claim, pair, forget),
  `browser-http.ts` and `local-files.ts` (scoped file routes and the web
  placeholder), `sync-connections.ts` (account selection).
- `folder-sync.ts`: one placed folder on the update machine: the folder as
  the runner's accepted tree and as the source that scans edits into its
  change log, and its watch.
- `workspace.ts`, `workspace-editor.ts`, `tree-manager.ts`: one placed folder,
  its editor component, and the set of placed trees.
- `filesystem-object-source.ts`, `object-cache.ts`, `object-read-diagnostics.ts`:
  serving the folder itself as the object store.
- `filesystem-node-surface.ts`, `node-provider-router.ts`, `node-sampling.ts`,
  `generated-types.ts`, `property-changes.ts`, `root-title.ts`: the node
  model over files and collections.
- `state/`: daemon-local state, the tree registry, placements, connections,
  local accounts, profile identity, projection providers, and the object
  index. Exported at `@overstory/arborsync/state` for tests and tools.
- `events.ts`, `cursors.ts`, `cli.ts`.

The API is documented in [the Arbor Sync REST API](../../docs/implementing-sync-services/arborsync-api.md),
and the data home in [the local system](../../docs/architecture/arborsync/data-home.md). The
daemon has no editor path.
