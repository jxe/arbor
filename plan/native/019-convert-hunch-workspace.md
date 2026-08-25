# Plan 019: Rehearse Hunch conversion and later cut over

> **Executor instructions**: Build focused operator tooling for repeatable, copy-only rehearsal imports before final adoption. A rehearsal never retires Hunch, writes to its workspace, reuses a previous destination, or makes Arbor experiments migration input. Final cutover is a separate phase requiring the full product gates and Joe's explicit approval. Never commit personal filenames, manifests, note contents, or hashes to Git.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native packages tools plan/native plan/records /Users/joe/src/hunch /Users/joe/src/quagmire`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM for isolated rehearsals; HIGH for final adoption
- **Depends on**: Plan 017 for rehearsals; Plan 018 for final adoption
- **Category**: data migration/product evaluation/release
- **Planned at**: Arbor `dc34126`, Hunch `a1e8379`, 2026-08-23
- **Reconciled at**: Arbor `e38632d`, 2026-08-25 — repeatable rehearsals precede final adoption
- **Progress**: Disposable repository-local operator tool implemented under `tools/hunch-rehearsal`; synthetic inventory/dry-run/apply/verify gates pass. The 2026-08-25 live read-only inventory and private stable recipe are reviewed, and the first private rehearsal was created, verified, and opened in signed native Arbor builds without modifying Hunch. Backup-restore proof, promoted multi-device qualification, and final adoption remain.

## Why this matters

Only one Hunch workspace needs conversion, so a permanent importer would add public maintenance surface without product value. But conversion needs to be repeatable: Joe should be able to create a fresh private Arbor tree from the current Hunch workspace, experiment freely, and repeat the exercise as Arbor improves without retiring Hunch. A bespoke, reproducible, copy-only workflow can make those rehearsals comparable, expose product gaps on representative data, and preserve the complete Hunch source and legacy recovery until a separately authorized final adoption.

## Reviewed baseline inventory

- Source: `/Users/joe/Documents/todos`; Hunch bookmark was verified non-stale.
- Rehearsal destinations: new run-specific directories under a private operator-chosen parent; every apply refuses an existing destination.
- Final destination: chosen only for the separately authorized final run; no rehearsal reserves or overwrites it.
- 2026-08-23 inventory: 77 live Markdown, 42 Trash Markdown, 160 history logs with 58,521 valid records, 17 assets totaling 9,459,803 bytes.
- 2026-08-23 identity: 61 pages have unique `clamshell-id`; 16 lack one; no duplicate IDs were found.
- Reviewed baseline target: 70 live pages, 70 unique Arbor IDs, 17 assets, `Console.md` Home.

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

**In scope**: repeatable inventory/conversion/verification tooling, external backup, stable private recipe, per-run manifests, new destination copies, isolated private authority trees, Mac/iOS qualification, comparison across runs, and a separately gated final adoption.

**Out of scope**: an app import UI or supported importer API, source Hunch writes, bidirectional Hunch/Arbor sync, carrying arbitrary rehearsal edits into later imports, Trash/history conversion, inferred hierarchy, public access, or deleting the original workspace, rehearsals, or backup.

## Safety boundary

- Briefly flush and quit Hunch while capturing each source snapshot; resume ordinary Hunch use as soon as a rehearsal snapshot and its hash are stable.
- Before the first rehearsal, create a byte-for-byte backup plus SHA-256 inventory outside the repository and demonstrate restoration. Refresh and restore-test the backup again before final adoption.
- Keep Trash, `.history`, and `.clamshell.json` only in source/backup; each Arbor rehearsal starts its own history at import.
- Preserve paths and proven links; never infer physical folder hierarchy from Hunch document links.
- The source is never edited, renamed, moved, or opened for Arbor writes.
- One stable private recipe owns every reviewed keep/discard decision and the PageIDs minted for ID-less pages. Reuse those PageIDs across rehearsals; stop for review when the source adds an unknown or ID-less page.
- Every rehearsal gets a fresh destination and run manifest. A rehearsal promoted for multi-device testing gets a fresh TreeID and private canonical path; PageID reuse across those distinct trees is intentional because page identity is tree-scoped.
- Arbor edits made during a rehearsal remain in that rehearsal. They are never written back to Hunch and never silently overlaid onto a later snapshot.
- The personal recipe, PageID mapping, source hashes, run manifests, TreeIDs, canonical paths, and content evidence remain outside Git.

## Conversion tool

The disposable tool lives in [`tools/hunch-rehearsal`](../../tools/hunch-rehearsal) and is invoked with `bun run hunch:rehearsal`. It has `inventory`, `dry-run`, `apply`, and `verify` modes and is not linked into either app. It consumes the stable reviewed recipe containing explicit keep/discard actions and generated PageIDs. Every run receives an explicit run ID and destination. Dry-run performs no destination writes and apply requires two matching dry-run confirmations. Apply refuses a non-empty or existing destination and never overwrites; it writes and verifies a run-specific sibling staging directory, re-hashes the source, and only then renames the staging directory to the destination. A failed run remains visibly incomplete rather than replacing a prior result.

The per-run private manifest records the source snapshot hash, recipe digest, Arbor repository revision, worktree-status digest, exact converter-source digest, output manifest, verification results, known product gaps, and disposition (`active rehearsal`, `retained`, or `retired`). If the rehearsal is promoted for multi-device testing, its operator record also gains the new TreeID/canonical path and accepted roots. The tool may compare manifests but does not merge rehearsal content.

For retained pages, remove Hunch's generated `clamshell` stamp and change `clamshell-id` to `id`, or add the reviewed new `id`. Preserve all unrelated frontmatter order/comments/quoting, newline style, and body bytes. The selected root-level Hunch Home page becomes Arbor's `_index.md`; nested Home pages stop because moving one would change relative-link bases. Copy assets byte-for-byte. The current tool does not rewrite Markdown links: it reports syntactic links to discarded/missing pages and fragment-less links to the moved Home so they can be reviewed without an unsafe general rewrite.

## Rehearsal steps

1. Record the exact Arbor build and current incomplete parity rows. Rehearsals require the Plan 017 daily-driver foundation, not Plan 018 completion.
2. Before the first run, create and restore-test the external backup and review the stable conversion recipe. For every run, briefly quiesce Hunch, hash/inventory the source, and require it to remain unchanged through snapshot capture.
3. Run inventory and dry-run twice. Require identical proposed output manifests, the reviewed keep/discard/ID decisions, zero duplicate IDs, and no unreviewed action. Counts may evolve as Hunch evolves; changes from the prior run must be explicit rather than treated as failure solely because they differ from the 2026-08-23 baseline.
4. Apply to a new run-specific destination and verify both source before/after equality and output against the dry-run manifest. Resume Hunch use after the snapshot is stable.
5. Open the destination through macOS arbord and inspect representative Markdown, all IDs/links/Home/assets, directory completion, search/backlinks, and diagnostics. Record known product gaps rather than weakening the conversion to accommodate them.
6. The local rehearsal is now ready for ordinary macOS evaluation. Experiment freely with editing, navigation, history, recovery, assets, and other currently available behavior.
7. Optionally promote a useful rehearsal for multi-device qualification: create a fresh private owner-only authority tree at a run-specific canonical path and verify public access is `none` before upload. Never reuse the final canonical path or another rehearsal's TreeID.
8. For a promoted rehearsal, sync Mac → authority → iOS and require identical accepted root hashes. Test edits from Mac and iOS, offline divergence/server merge, history restore, Recover, restart, and credential revoke. Confirm every added Markdown line survives near its original context and any unsafe case leaves no server record while the client retains the complete returned draft and both alternatives.
9. Record findings and retain or retire the isolated rehearsal. Do not feed its Arbor-only edits into the next import automatically. Hunch remains the ordinary active writer.

## Final-adoption steps

1. Complete Plan 018, its exact-artifact matrix, and every accepted final-release gate. Obtain Joe's explicit authorization for final adoption; successful rehearsals do not imply it.
2. Decide explicitly whether any Arbor-only rehearsal edits are worth manually carrying back to Hunch before the final snapshot. Default to discarding experimental Arbor edits, never an automatic merge.
3. Refresh and restore-test the external backup, then repeat the complete rehearsal workflow from a fresh locked Hunch snapshot into a new final destination and fresh private tree.
4. Require two identical dry-run manifests, source before/after equality, complete conversion verification, and matching Mac/authority/iOS roots.
5. Exercise the final offline, conflict, recovery, restart, and revocation qualification again. A prior rehearsal is evidence, not a substitute.
6. Only after those gates pass, designate the new tree and canonical path as the active Arbor workspace and stop Hunch authorship. Retain the original Hunch workspace and backup as independently recoverable read-only history.

## Verification

The checked-in tool itself must pass:

```sh
bun test tests/unit/hunch-rehearsal.test.ts
bun run typecheck
git diff --check
```

For a rehearsal, run the Plan 017 gates relevant to the exact build and clearly record which Plan 018 capabilities are incomplete or unverified. For final adoption, run every root/Swift/Quagmire/Xcode gate from Plans 017–018. When the source still matches the reviewed 2026-08-23 baseline, the private manifest reports:

- 70 live pages and 70 unique IDs;
- 61 preserved IDs and nine reviewed new IDs;
- 17 matching asset hashes;
- `Console.md` Home;
- exactly seven explicit discards;

If Hunch has changed, the manifest instead records the reviewed new totals and an explicit delta from that baseline; no new keep, discard, or PageID decision is inferred. Every manifest also reports:

- source before/after hash equality;
- a unique run ID, destination, Arbor build, recipe digest, and known-gap list;
- for a promoted rehearsal or final run, its TreeID, private canonical path, and identical Mac/authority/iOS current accepted root.

## Done criteria

- [ ] The same stable recipe has produced at least two independently verified rehearsal trees from different source snapshots without modifying Hunch or overwriting a prior destination.
- [ ] Stable reviewed PageIDs repeat across rehearsal outputs while every promoted run has a fresh TreeID and private canonical path.
- [ ] Backup restoration was demonstrated before rehearsals and refreshed before final adoption.
- [ ] The original Hunch workspace remains independently openable and is byte-identical across each snapshot operation.
- [ ] Every converted tree passes its recorded inventory/link/asset/ID checks.
- [ ] At least one promoted rehearsal and the final tree have owner-only authority access and matching current roots on all tested devices.
- [ ] Hunch remains the active writer throughout rehearsals and is retired only after separately authorized final adoption.
- [ ] Safe non-personal completion evidence is recorded in `plan/records/history.md`.

## STOP conditions

- A rehearsal destination or canonical path already exists, or the source changes during snapshot capture.
- Any retained page needs an unreviewed identity/link decision.
- The stable recipe would remint an existing page's PageID merely because this is a new run.
- Backup restoration, converted-tree inspection, or root equality fails.
- The authority exposes the tree publicly or Hunch/Arbor could coauthor.
- A workflow would merge Arbor rehearsal edits back into Hunch or forward into a later run without an explicit reviewed operation.
- Joe has not explicitly authorized final adoption when the executor reaches the final-adoption phase.

## Maintenance note

Do not convert this operator workflow into a permanent import API after success. Preserve the original/backup and any retained rehearsals according to Joe's retention choice. A rehearsal is a disposable Arbor-owned fork for evaluation; only the separately verified final tree becomes the active replacement.
