# Rename 002: remove the old-spelling read aliases

**Why and when:** [Rename 001](001-overstory-names.md) leaves readers accepting six old spellings, because authored content and links already shared still carry them. Joe wants that tolerance to be temporary. Do this once Rename 001 has been live for a few weeks and Joe is no longer following old links.

> **Executor instructions**: Start only after Rename 001 is closed out. Rewriting live content waits for Joe's go-ahead. Every alias site carries the comment marker `Rename 002`; `rg -n 'Rename 002'` lists them.

## Status

- **Effort**: S
- **Risk**: LOW. The rewrite is an ordinary authored edit in each tree.
- **Depends on**: Rename 001
- **Category**: cleanup

## What is aliased

The table in Rename 001, "Read old, write new", is the list: `arbor://`; the `;arbor-key=`, `;arbor-rev=`, `;arbor-config` parameters and the `#arbor-key=` fragment; `<!-- arbor:children -->`; `.arborignore`; `#arbor-access=` in shared access links; and `"source": "arbor-profile"` in an app's `relationships.json`.

## Decisions

- Old revisions keep their old text. Once the aliases are gone, links in old revisions no longer resolve. Joe accepted this on 2026-10-10.
- Shared links that carry `;arbor-key=` or `#arbor-access=` stop working. Reissue any that still matter before step 3.
- The never-renamed names and the names deferred to Rename 003, both listed in Rename 001, stay. This plan does not touch them.

## Steps

1. **Count.** For the current revision of every tree Joe can write, and for the host's configuration trees and stored member facts, report how many of each old spelling remain, including `.arborignore` files.
2. **Rewrite** (Joe's go-ahead). Rewrite them to the new spellings as an authored edit in each tree, from a device that holds the author's key. Confirm first whether a one-time `story` command or a pass in the app suits the authored contract better. Renaming `.arborignore` is a file rename in the tree, so every placement receives it. Run step 1 again and expect zero.
3. **Remove the aliases** at every marked site in TypeScript and Swift, with their tests. Gate: `bun run test:affected`, `bun run test:protocol`, and `rg -i 'arbor'` returns only the never-renamed and deferred lists and history in `status.md`.
4. **Close out.** Record the evidence in `status.md` and delete this plan.
