# Schema language 008: port excellences and supplies-remake to Story

**Why and when:** Joe asked on 2026-10-13 for the MAI excellences document and supplies-remake
to run natively in Story on Overstory collections instead of Supabase. This was milestone 6 of
[Schema language 002](../soon/schema-language-002-collection-editor.md); Joe split it out and
left it in later on 2026-10-25, when the rest of 002 moved to soon. It needs 002's editor
(milestone 4) and ownership (milestone 5), and the sites on USL 0.3.0
([cleanup](../soon/cleanup-schema-language-005-publish-usl-and-move-the-sites.md)).

## Status

- **Effort:** M.
- **Risk:** MEDIUM. Each site's data moves; the live sites keep running until Joe switches.
- **Depends on:** Schema language 002 milestones 4 and 5.

## Steps

- An importer reads cranberries' snapshot (`GET /api/cranberries`, or the
  `remake` tables) into a tree:
  - `games.usl` with JSONL or SQLite;
  - `excellences.usl` likewise;
  - `created`/`modified` carried over from cranberries' stamps;
  - `@ordered` positions from `List_games.games_position`.
- Cranberries has no export command. `readDocument` returns the whole
  snapshot, so a small `cranberries export` that writes it through
  `@ovst/usl`'s `rowsFromRecords` would serve both sites. The games sandbox
  (2026-10-24) was filled this way by a one-off script from the public
  `GET /api/cranberries?document=games`: ids and `modified` kept, `created`
  not carried, people's names, avatars and bios dropped (no Person rows).
- Use excellences' own `lib/schema.usl`, which has the `@fold`s;
  `packages/usl/examples/excellences.usl` has drifted from it, so
  replace the example.
- Check with `usl verify`, then present the result next to the live site and
  compare.
- **People without accounts** become `contact:<key>` placeholders (spec 11
  §3), keyed by their source id, as the games sandbox does; they show by name
  once the directory (People 001 phase 1) holds them.

**Done when:** the excellences document and a supplies-remake game list run in Story, backed by
files or SQLite, with the same content they have on Supabase, and Supplies' ownership rule
holds.

## Close out

Record the evidence in `status.md` and delete this plan.
