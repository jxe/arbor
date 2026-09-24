# packages

The TypeScript workspace. Each directory is one Bun workspace member published
as `@overstory/<name>`; tests live in [`tests/`](../tests/README.md), not
here. The Swift twins are under [`swift/`](../swift/README.md).

| Component | Package | Purpose |
|---|---|---|
| Overstory protocol | [`protocol`](protocol/README.md) | The specification in code: model, objects, updates, transport, documents, configuration |
| | [`object-store`](object-store/README.md) | Content-addressed on-disk store for protocol objects |
| Host | [`canopyd`](canopyd/README.md) | The reference host and the `canopyd` command |
| | [`canopyd-merge`](canopyd-merge/README.md) | The merge sidecar and the `arbor-merge` command |
| | [`tree-merge`](tree-merge/README.md) | The three-way snapshot tree merge, shared by the merge sidecar and Arbor Sync tree recovery |
| | [`apps-runtime`](apps-runtime/README.md) | The executable-document runtime and the collection sandbox |
| Client stack | [`client`](client/README.md) | Synchronizing a working tree against a host |
| | [`fs`](fs/README.md) | Materializing trees on a filesystem |
| Arbor local tools | [`arborsync`](arborsync/README.md) | The Arbor Sync daemon and the `arborsync` command |
| | [`cli`](cli/README.md) | The `arbor` command, including its REST and SSE client for the daemon (`src/daemon-client.ts`) |
| Canopy browsers | [`canopy-web`](canopy-web/README.md) | The browser editor (currently out of the build) |

Layering rules, checked by reading each `package.json`:

- `protocol` depends on nothing in the workspace.
- `apps-runtime` depends only on `protocol`; `tree-merge` only on those two.
- `object-store`, `fs`, `client`, `canopyd`, and `canopyd-merge` never depend
  on `arborsync` or `cli`.
- `cli` and `canopy-web` may depend on anything.

The root `package.json` lists every member as a dependency so that files
outside `packages/` (tests, tools, migrations) resolve `@overstory/*` through
ordinary workspace links; there is no tsconfig `paths` map. The root `bin`
entries are what `bun link` exposes, and the root `scripts` are the
documented way to run each command from a checkout.
