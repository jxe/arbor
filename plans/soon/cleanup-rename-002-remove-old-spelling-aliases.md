# Rename 002: remove the old-spelling read aliases

**Why and when:** The rename of 2026-10-10 ([status](../../status.md#overstory-and-story-names--2026-10-10)) left readers accepting six old spellings, because authored content and links already shared still carry them. Joe wants that tolerance to be temporary. Do this once the rename has been live for a few weeks and Joe is no longer following old links.

> **Executor instructions**: Rewriting live content waits for Joe's go-ahead. Every alias site carries the comment marker `Rename 002`; `rg -n 'Rename 002'` lists them.

## Status

- **Effort**: S
- **Risk**: LOW. The rewrite is an ordinary authored edit in each tree.
- **Depends on**: nothing
- **Category**: cleanup

## What is aliased

[Old names](../../docs/architecture/old-names.md), under "Read old, write new", is the list: `arbor://`; the `;arbor-key=`, `;arbor-rev=`, `;arbor-config` parameters and the `#arbor-key=` fragment; `<!-- arbor:children -->`; `.arborignore`; and `#arbor-access=` in shared access links. (`"source": "arbor-profile"` went with `relationships.json` on 2026-10-14.)

## Decisions

- Old revisions keep their old text. Once the aliases are gone, links in old revisions no longer resolve. Joe accepted this on 2026-10-10.
- Shared links that carry `;arbor-key=` or `#arbor-access=` stop working. Reissue any that still matter before step 3.
- The never-renamed and deferred names, both listed in old names, stay. This plan does not touch them. Its last step deletes the "Read old, write new" section of that page.

## Steps

1. **Count.** For the current revision of every tree Joe can write, and for the host's configuration trees and stored member facts, report how many of each old spelling remain, including `.arborignore` files.
   **Counted 2026-10-24** with `packages/overstoryd/src/rename-002-count.ts` on the live host (all 20 trees' current roots and every text column of the host's tables): 18 left, all in authored files and none in configuration trees or host tables. `#arbor-key=` ×17 in 11 files of `tr_owozr6aegt5z7x6qyllvzljl5u` (`Workshop-followups.md` ×5, `Psych/Always-w-self-contact-care-for-my-misgivings/Stop-ignoring-or-being-unaware-of-my-own-unease.md` ×3, one each in nine others), and `arbor://` ×1 in `_index.md` of `tr_2y2grqksa3klhhv6aziplhl2ha`. No `.arborignore`, `;arbor-*` parameter, children marker or `#arbor-access=`. The full report is on Joe's Mac at `~/src/arbor-rename-002-count.json`.
2. **Rewrite** (Joe's go-ahead). Rewrite them to the new spellings as an authored edit in each tree, from a device that holds the author's key. Confirm first whether a one-time `story` command or a pass in the app suits the authored contract better. Renaming `.arborignore` is a file rename in the tree, so every placement receives it. Run step 1 again and expect zero.
3. **Remove the aliases** at every marked site in TypeScript and Swift, with their tests. Gate: `bun run test:affected`, `bun run test:protocol`, and `rg -i 'arbor'` returns only the never-renamed and deferred lists and history in `status.md`.
4. **Close out.** Record the evidence in `status.md` and delete this plan.
