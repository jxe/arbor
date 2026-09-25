# Arbor Sync and local tools

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**The daemon** (Arbor Sync) is one process with one loopback API. `server.ts`
supplies request protection and error handling and composes the handlers:

| Owner | Modules in `packages/arborsync/src/` | Responsibilities |
|---|---|---|
| Sync | `sync-http.ts`, `service.ts` | Placement inventory and moves, bootstrap, events, pending updates, reconciliation, materialization, conflict recovery |
| Account administration | `account-http.ts`, `account-service.ts` | Identity, credentials, accounts, claim, pair, and forget through the account bootstrap ports |
| Browser | `browser-http.ts`, `local-files.ts` | Scoped file, raw, HEAD, range, and ETag handling and the current web placeholder |
| Filesystem objects | `filesystem-object-source.ts` | SQLite index lifecycle, verified file and directory reads, invalidation and uncached revalidation |
| Sync connections | `sync-connections.ts` | Explicit account selection and credentials through the injectable `SyncConnections` interface |
| State | `state/` | The tree registry, placements, connections, local accounts, profile identity, providers, and the object index |

`Workspace` owns one placed folder: filesystem and object-source lifecycle,
descriptor and scope, watcher subscription, and change observations. Its
`editor` component owns node and provider projection, stable-key resolution,
link healing, and generated types; it has no mutation API. `TreeObjectCache`
composes the filesystem source, durable pending objects, and the host, in that
order; file bytes stay in their files, with no mirror.

The daemon's placed folder is a working tree whose object store is the folder
itself: a file's object is re-encoded from disk, a directory's from its
children, and the index only remembers which hash a path last produced. That
is why the daemon can serve `/v1/objects` to every other client on the
machine without a second copy of the tree, and why the Mac app's in-memory
working tree needs no content store of its own. The daemon has no editor
path.

`FolderSync` publishes each scan as one `trace: null` change carrying exactly
the objects its basis lacks. Against an accepted basis a changed file or
directory travels as an object delta from the object at the same path there,
whenever the delta is smaller; `transitionPayload` in `@overstory/protocol`
pairs and sizes them, the same code canopyd uses for accepted transitions,
and objects over 64 MiB always go whole. A change chained on an unsettled
change sends its objects whole, because canopyd resolves delta bases against
the request's accepted base root.

## Durability and observation

The daemon uses a private intent journal, recovery bookkeeping, filesystem
observation, and a 1,024-event in-memory SSE replay buffer; a restart changes
the event epoch and clients resynchronize. Private paths are documented for
maintainers and migration tooling only, in [the local system](data-home.md);
other implementations may choose a different layout. The synchronized
[`trees.yaml`](../../overstory-spec/04-accounts-and-devices.md#3-configuration-yaml)
contract is normative.

See [the data home](data-home.md), [CLI reference](../../getting-started/cli.md), and [loopback API](../../implementing-sync-services/arborsync-api.md).
