# Plan 019: Rehearse Hunch conversion and record the adopted cutover

> **Final status: DONE.** The copy-only rehearsal tool and first verified private conversion are complete, and Joe accepted the Hunch-to-Arbor cutover as already done on 2026-08-25. Do not rerun a destructive migration, require an external-backup restoration demonstration, or reopen final-adoption gates. Keep the tool available only for an explicitly requested future copy-only rehearsal. Never commit personal filenames, manifests, note contents, or hashes to Git.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native packages tools plan/native plan/records /Users/joe/src/hunch /Users/joe/src/quagmire`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW for retained read-only tooling; final adoption is complete
- **Depends on**: Plan 017
- **Category**: data migration/product evaluation/release
- **Planned at**: Arbor `dc34126`, Hunch `a1e8379`, 2026-08-23
- **Reconciled at**: Arbor `e38632d`, 2026-08-25 — repeatable rehearsals preceded adoption; final cutover accepted complete by Joe on 2026-08-25
- **Progress**: DONE. The disposable repository-local tool under `tools/hunch-rehearsal`, its synthetic gates, live read-only inventory, private stable recipe, and first private verified conversion are complete. Joe waived the external-backup restoration requirement and accepted the existing Hunch cutover as final; promoted-rehearsal qualification is optional future evidence, not an adoption gate.

## Why this matters

Only one Hunch workspace needed conversion, so a permanent importer would add public maintenance surface without product value. The retained bespoke workflow exists for optional, explicitly requested copy-only rehearsals and auditability; it is not an unfinished prerequisite for the already accepted Arbor adoption.

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

**In scope**: retained repeatable inventory/conversion/verification tooling, stable private recipe, per-run manifests, new destination copies, optional isolated private authority trees, Mac/iOS qualification, and comparison across explicitly requested future runs.

**Out of scope**: an app import UI or supported importer API, source Hunch writes, bidirectional Hunch/Arbor sync, carrying arbitrary rehearsal edits into later imports, Trash/history conversion, inferred hierarchy, public access, deleting retained source data, or reopening the completed cutover as a required migration exercise.

## Safety boundary

- Briefly flush and quit Hunch while capturing each source snapshot; resume ordinary Hunch use as soon as a rehearsal snapshot and its hash are stable.
- Snapshot manifests must prove source-before/source-after equality. External backup creation or restoration demonstration is not a requirement of this plan.
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
2. Review the stable conversion recipe. For every requested run, briefly quiesce Hunch, hash/inventory the source, and require it to remain unchanged through snapshot capture.
3. Run inventory and dry-run twice. Require identical proposed output manifests, the reviewed keep/discard/ID decisions, zero duplicate IDs, and no unreviewed action. Counts may evolve as Hunch evolves; changes from the prior run must be explicit rather than treated as failure solely because they differ from the 2026-08-23 baseline.
4. Apply to a new run-specific destination and verify both source before/after equality and output against the dry-run manifest. Resume Hunch use after the snapshot is stable.
5. Open the destination through macOS arbord and inspect representative Markdown, all IDs/links/Home/assets, directory completion, search/backlinks, and diagnostics. Record known product gaps rather than weakening the conversion to accommodate them.
6. The local rehearsal is now ready for ordinary macOS evaluation. Experiment freely with editing, navigation, history, recovery, assets, and other currently available behavior.
7. Optionally promote a useful rehearsal for multi-device qualification: create a fresh private owner-only authority tree at a run-specific canonical path and verify public access is `none` before upload. Never reuse the final canonical path or another rehearsal's TreeID.
8. For a promoted rehearsal, sync Mac → authority → iOS and require identical accepted root hashes. Test edits from Mac and iOS, offline divergence/server merge, history restore, Recover, restart, and credential revoke. Confirm every added Markdown line survives near its original context and any unsafe case leaves no server record while the client retains the complete returned draft and both alternatives.
9. Record findings and retain or retire the isolated rehearsal. Do not feed its Arbor-only edits into the next import automatically.

## Final-adoption record

Joe accepted the existing Hunch-to-Arbor cutover as complete on 2026-08-25. This decision supersedes the previously proposed second rehearsal, promoted multi-device rehearsal, external-backup restoration demonstration, and fresh final-migration sequence as mandatory gates. The source-preserving converter and private records remain available for audit or a future explicitly requested rehearsal, but no further conversion action is implied.

## Verification

The checked-in tool itself must pass:

```sh
bun test tests/unit/hunch-rehearsal.test.ts
bun run typecheck
git diff --check
```

For any future explicitly requested rehearsal, run the Plan 017 gates relevant to the exact build and clearly record which Plan 018 capabilities are incomplete or unverified. When the source still matches the reviewed 2026-08-23 baseline, the private manifest reports:

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

- [x] The copy-only converter, stable private recipe, and first independently verified conversion were completed without modifying Hunch or overwriting a prior destination.
- [x] The verified conversion passed its recorded inventory/link/asset/ID checks and source-before/source-after equality gate.
- [x] External backup restoration is explicitly not required.
- [x] Joe separately accepted final Hunch cutover as already complete on 2026-08-25.
- [x] Future rehearsals remain optional, isolated, and unable to write back into the Hunch source or silently seed another run.

## STOP conditions

- A rehearsal destination or canonical path already exists, or the source changes during snapshot capture.
- Any retained page needs an unreviewed identity/link decision.
- The stable recipe would remint an existing page's PageID merely because this is a new run.
- Converted-tree inspection or any root equality required by an explicitly requested promoted rehearsal fails.
- The authority exposes the tree publicly or Hunch/Arbor could coauthor.
- A workflow would merge Arbor rehearsal edits back into Hunch or forward into a later run without an explicit reviewed operation.

## Maintenance note

Do not convert this operator workflow into a permanent import API after success. Preserve retained source data and rehearsals according to Joe's retention choice. Any future rehearsal is a disposable Arbor-owned fork for evaluation and does not reopen the completed adoption.
