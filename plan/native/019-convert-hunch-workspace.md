# Plan 019: Convert the live Hunch workspace and cut over

> **Executor instructions**: This is a one-time operator migration, not an app feature. Do not touch the live source until every product/release gate passes and Joe explicitly authorizes cutover. Never commit personal filenames, manifests, note contents, or hashes to Git.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native packages tools plan/native plan/records /Users/joe/src/hunch /Users/joe/src/quagmire`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 018
- **Category**: data migration/release
- **Planned at**: Arbor `dc34126`, Hunch `a1e8379`, 2026-08-23

## Why this matters

Only one Hunch workspace needs conversion, so a permanent importer would add public maintenance surface without product value. A bespoke, reproducible, copy-only conversion can preserve the curated live corpus, prove cross-device accepted roots, and leave the complete Hunch source/legacy recovery available as backup.

## Known source inventory

- Source: `/Users/joe/Documents/todos`; Hunch bookmark was verified non-stale.
- Destination: `/Users/joe/Documents/todos-arbor`; STOP if it exists.
- Current inventory: 77 live Markdown, 42 Trash Markdown, 160 history logs with 58,521 valid records, 17 assets totaling 9,459,803 bytes.
- Live identity: 61 pages have unique `clamshell-id`; 16 lack one; no duplicate IDs were found.
- Import target: 70 live pages, 70 unique Arbor IDs, 17 assets, `Console.md` Home.

Discard only these reviewed iCloud collision artifacts:

```text
main 2.md
main 3.md
main 5.md
main 6.md
main 7.md
main 8.md
main 9.md
```

Retain and mint reviewed Arbor PageIDs for these nine ID-less pages:

```text
Brian-Notes.md
Choosing-a-woman-with-god.md
Fears-to-Seth-etc.md
Learn-to-greet-everyone-is-type-A-or-B.md
Make-problem-set-teams.md
Nora-notes.md
Plan-meditation-for-tomorrow.md
Untitled-3.md
Untitled-6.md
```

## Scope

**In scope**: one-time inventory/conversion/verification tooling, external backup and private recipe/manifest, new destination copy, private authority tree, Mac/iOS qualification, safe completion evidence.

**Out of scope**: an app import UI or supported importer API, source Hunch writes, Trash/history conversion, inferred hierarchy, public access, deleting the original workspace or backup.

## Safety boundary

- Quit Hunch and prevent further authorship during final conversion.
- Create a byte-for-byte backup plus SHA-256 inventory outside the repository and demonstrate restoration before apply.
- Keep Trash, `.history`, and `.clamshell.json` only in source/backup; Arbor history begins at cutover.
- Preserve paths and proven links; never infer physical folder hierarchy from Hunch document links.
- The source is never edited, renamed, moved, or opened for Arbor writes.
- The personal recipe, PageID mapping, hashes, and manifest remain outside Git.

## Conversion tool

Use a focused operator script (not linked into the app) with `inventory`, `dry-run`, `apply`, and `verify` modes. It consumes a locked reviewed recipe containing explicit keep/discard actions and generated PageIDs. Dry-run performs no destination writes. Apply refuses a non-empty/existing destination and never overwrites.

For retained pages, copy exact source except the deliberate frontmatter change from `clamshell-id` to `id`, or addition of the reviewed new `id`. Preserve all unrelated frontmatter order/comments/quoting and body bytes. Copy assets byte-for-byte. Rewrite a link only when inventory proves the same target and the rewrite is necessary for the canonical PageID fragment; unresolved links remain unchanged and are reported.

## Steps

1. Run the complete Plan 018 release matrix and obtain explicit cutover approval.
2. Quit Hunch; hash/inventory source; create/restore-test backup; lock source hash and reviewed recipe.
3. Run inventory and dry-run twice. Require identical proposed destination manifest, 70 pages, 70 IDs, 17 assets, seven exact discards, zero duplicate IDs, and no unreviewed action.
4. Apply to the new destination and verify source hash is unchanged.
5. Open destination read-only through macOS arbord; inspect representative Markdown, all IDs/links/Home/assets, directory completion, search/backlinks, and diagnostics.
6. Create private owner-only `~joe/todos` on the configured authority; verify public access is `none` before upload.
7. Sync Mac → authority → iOS and require identical accepted root hashes.
8. Exercise one edit from Mac and iOS, offline divergence/server merge, history restore, Recover, restart, and credential revoke on the converted tree. Confirm every added Markdown line survives near its original context and any unsafe case retains a writer-only draft plus both alternatives.
9. Enable normal writes only after all gates pass. Retain Hunch source and backup; never allow Hunch and Arbor to coauthor.

## Verification

Run every root/Swift/Quagmire/Xcode gate from Plans 017–018, then require the private external manifest to report:

- 70 live pages and 70 unique IDs;
- 61 preserved IDs and nine reviewed new IDs;
- 17 matching asset hashes;
- `Console.md` Home;
- exactly seven explicit discards;
- source before/after hash equality;
- identical Mac/authority/iOS current accepted root.

## Done criteria

- [ ] Backup restoration was demonstrated.
- [ ] Original Hunch workspace is byte-identical and still independently openable.
- [ ] Converted tree passes exact inventory/link/asset/ID checks.
- [ ] Authority access is owner-only and current roots agree on all devices.
- [ ] Hunch is no longer an active writer after cutover.
- [ ] Safe non-personal completion evidence is recorded in `plan/records/history.md`.

## STOP conditions

- Joe has not explicitly authorized cutover.
- Destination exists or source changes during the locked window.
- Any retained page needs an unreviewed identity/link decision.
- Backup restoration, read-only inspection, or root equality fails.
- The authority exposes the tree publicly or Hunch/Arbor could coauthor.

## Maintenance note

Do not convert this operator workflow into a permanent import API after success. Preserve the original/backup according to Joe's retention choice; Arbor owns only the verified converted copy.
