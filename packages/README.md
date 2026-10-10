# packages

The TypeScript workspace. Each directory is one Bun workspace member published
as `@ovst/<name>`; tests live in [`tests/`](../tests/README.md), not
here. The Swift twins are under [`swift/`](../swift/README.md).

| Component | Package | Purpose |
|---|---|---|
| Overstory protocol | [`protocol`](protocol/README.md) | The specification in code: model, objects, updates, transport, documents, configuration |
| | [`object-store`](object-store/README.md) | Content-addressed on-disk store for protocol objects |
| Host | [`overstoryd`](overstoryd/README.md) | The reference host and the `overstoryd` command |
| | [`overstoryd-merge`](overstoryd-merge/README.md) | The merge sidecar and the `overstoryd-merge` command |
| | [`tree-merge`](tree-merge/README.md) | The three-way snapshot tree merge, shared by the merge sidecar and Story Sync tree recovery |
| | [`collection-schema`](collection-schema/README.md) | Declarative `schema.cddl` collection schemas and the collection-file codec |
| | [`apps-runtime`](apps-runtime/README.md) | The executable-document runtime |
| Client stack | [`client`](client/README.md) | Synchronizing a working tree against a host |
| | [`fs`](fs/README.md) | Materializing trees on a filesystem |
| Story Sync and CLI | [`story-sync`](story-sync/README.md) | The Story Sync daemon and the `story-sync` command |
| | [`cli`](cli/README.md) | The `story` command, including its REST and SSE client for the daemon (`src/daemon-client.ts`) |
| Story apps | [`story-web`](story-web/README.md) | The browser editor (currently out of the build) |

Layering rules, checked by reading each `package.json`:

- `protocol` depends on nothing in the workspace.
- `apps-runtime` and `collection-schema` depend only on `protocol`;
  `tree-merge` only on `protocol` and `collection-schema`.
- `object-store`, `fs`, `client`, `overstoryd`, and `overstoryd-merge` never depend
  on `story-sync` or `cli`.
- `cli` and `story-web` may depend on anything.

The root `package.json` lists every member as a dependency so that files
outside `packages/` (tests, tools, migrations) resolve `@ovst/*` through
ordinary workspace links; there is no tsconfig `paths` map. The root `bin`
entries are what `bun link` exposes, and the root `scripts` are the
documented way to run each command from a checkout.
