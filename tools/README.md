# tools

Scripts that are not part of any package. Three groups:

| Script | Purpose | Run |
|---|---|---|
| `canonical-cbor-vectors.ts` | Regenerates the canonical CBOR and object vectors under `conformance/` | `bun tools/canonical-cbor-vectors.ts` |
| `check-links.ts` | Checks every relative link in tracked Markdown; the documentation gate `AGENTS.md` requires | `bun tools/check-links.ts` |
| `benchmark-merge-tool.ts` | Merge sidecar throughput on a synthetic corpus | `bun tools/benchmark-merge-tool.ts` |
| `replay-update-cost.ts` | Per-phase timings replaying edits against a copy of host data | `bun tools/replay-update-cost.ts <copy>` |
| `seed-supplies-fixture.ts` | Rebuilds `examples/supplies/data/_store.sqlite3` from its schema | `bun run seed:supplies` |
| `test-arbor-quagmire-local.sh` | Runs the `CanopyEditor` package tests while preserving the tracked Quagmire lock | `tools/test-arbor-quagmire-local.sh` |
| `recovery/` | The Arbor Sync tree recovery procedure and its script ([README](recovery/README.md)) | see its README |

The Hetzner multi-machine lab runner lives with its documentation and
scripts under [`deploy/hcloud-sync-lab/`](../deploy/hcloud-sync-lab.md) and
runs as `bun run lab:hcloud`.
