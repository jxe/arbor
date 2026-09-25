# 021: File-relative Markdown links

An authored-data migration, not a schema change: canopyd's schema stays 21.
It rewrites the links in Joe's todos tree from the pre-021 spellings to the
ones the 021 writers emit ([Cleanup 001](../../../../plans/soon/001-file-relative-links-and-pageid-cutoff.md)):

- A relative Markdown link resolves against the directory that holds the source file and names the target's physical file: `Calendar.md`, `Picture-of-Life/Foo.md`, `x/_index.md`.
- A stable key is spelled `#arbor-key=id:h31mlm`, the readable token, not base64url.
- A bare `#<PageID>` fragment is no longer an identity.
- A same-tree document row is a relative link, not `arbor://<tree>/…`.

Everything that still understands the old spellings is in `legacy.ts`. It goes
when this directory is deleted.

## Files

- `audit.ts`: a read-only inventory of every link form in every ordinary tree
  the local Arbor Sync places. It writes only
  `~/.arbor/.state/migration/file-relative-links-audit-<stamp>/receipt.json`.
- `run.ts`: the rewrite. Dry run by default; `--apply` requires the placement to be paused; `--revert <receipt>` undoes it.
- `migrate.test.ts`: `bun run test:migration packages/canopyd/migrations/021-file-relative-links`.

## Audit, 2026-09-25 (before any code change)

The account owns two ordinary trees, and both are placed on the Mac. The
profile tree has one Markdown file and no relative links. todos
(`tr_owozr6…`, 83 Markdown files, 83 ids, no duplicates) has:

| Form | Count |
|---|---|
| bare `#<id>` with an owner | 69 |
| bare `#cxua95`, no owner (`Untitled-4.md`) | 2 |
| `#arbor-key=` alias | 4 |
| same-tree `arbor://…;arbor-key=` row | 12 |
| keyless relative | 68 (1 changes meaning under file-relative resolution, 20 already dangle) |
| image | 5 |
| external | 41 |

The latest canopyd backup (`.backups/railway/20260925T071420Z`) holds no
base64url key tokens. `~/.arbor` holds them only in the Mac working tree's
change-log object copies, which are content snapshots and need no rewrite.

## Runbook

Joe confirms each step.

1. Rehearse on a scratch copy: `bun run.ts <copy> --tree tr_owozr6aegt5z7x6qyllvzljl5u`, then `--apply`. Save the counts as `counts.json`.
2. Quit Canopy on the Mac and the iPhone. `arbor status` must show todos idle and not conflicted.
3. Back up. Tar the placement into `~/src/arbor/.backups/file-relative-links/<UTC>/`, then run `../tools/authored-manifest.ts write authored-before.json <placement>`.
4. `arbor pause <placement>`.
5. `bun run.ts <placement> --tree … --expect counts.json`. Review the dry run, then add `--apply`.
6. `arbor pending <placement>`. Review it:
   - only the files in the receipt change;
   - each insert is a link href;
   - directory entries change only their hashes.

   Save the `--json` output beside the backup, and diff the authored manifests.
7. `arbor resume <placement>`. The update number advances, the placement returns to idle, and the new root equals the pending candidate.
8. Check links, rows and backlinks on the Mac, the iPhone and the canopyd pages.
9. With Joe, fix by hand the links the rewrite reports as dangling. The rehearsal found 20:
   - 15 rows in the root `_index.md` name pages that now live deeper, such as `Activism-essay` (now `March-Out-My-Work/Activism-essay.md`). Point each at its current file, or delete it.
   - 5 are elsewhere: `Untitled-4.md` three times (two of them had their fragment stripped), plus `Untitled-2.md` and `Advisory-Structure.md`.
   - `Plan-meditation-for-tomorrow.md` also has a missing image.

   Edit in Canopy or Obsidian. Each fix publishes as an ordinary edit.

**Rollback.** Before step 7, `--revert` the receipt (or restore the tar) while
the placement is still paused. After step 7, `--revert` publishes as an
ordinary edit.
