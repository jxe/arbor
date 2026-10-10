# Rename 002: remove the `arbor://` locator alias

**Why and when:** [Rename 001](001-overstory-names.md) leaves both locator parsers accepting `arbor://` and the `;arbor-key=`, `;arbor-rev=` and `;arbor-config` parameters, because authored content and shared links still carry them. Joe wants that tolerance to be temporary. Do this once Rename 001 has been live for a few weeks and Joe is no longer following old links.

> **Executor instructions**: Start only after Rename 001 is closed out. Rewriting live content waits for Joe's go-ahead.

## Status

- **Effort**: S
- **Risk**: LOW. The rewrite is an ordinary authored edit in each tree.
- **Depends on**: Rename 001
- **Category**: cleanup

## Decisions

- Old revisions keep their `arbor://` text. Once the alias is gone, links in old revisions no longer resolve. Joe accepted this on 2026-10-10.
- Shared https links that carry `;arbor-key=` stop working. Reissue any that still matter before step 3.
- The never-renamed format tags listed in Rename 001 stay. This plan does not touch them.

## Steps

1. **Count.** Report how many `arbor://` locators and `;arbor-*` parameters remain in the current revision of each tree Joe can write, and in the host's configuration trees.
2. **Rewrite** (Joe's go-ahead). Rewrite them to the `overstory` spellings as an authored edit in each tree, from a device that holds the author's key. Confirm first whether a one-time `story` command or a pass in the app suits the authored contract better. Run step 1 again and expect zero.
3. **Remove the alias** from the TypeScript and Swift locator parsers, with its tests. Gate: `bun run test:affected`, `bun run test:protocol`, and `rg -i 'arbor://|arbor-(key|rev|config)'` returns only the never-renamed format tags and history in `status.md`.
4. **Close out.** Record the evidence in `status.md` and delete this plan.
