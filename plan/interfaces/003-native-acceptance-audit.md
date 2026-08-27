# Interface 003: Finish the native acceptance audit

## Status

- **Priority**: P1
- **Effort**: S–M hands-on verification
- **Risk**: LOW unless an acceptance check exposes a product defect
- **Depends on**: the completed native implementation recorded in
  [`history/native`](../history/native/README.md)
- **Category**: native acceptance
- **Progress**: IN PROGRESS — implementation, exact Quagmire `0.3.0` adoption,
  automated package/app gates, and the watch/snapshot deployment are complete.
  The exact-artifact image, title-rename, recovery, and accessibility checks
  below remain.

## Target result

The exact current macOS and iOS 27 Arbor artifacts pass the small set of
hands-on checks that automated provider, editor, synchronization, and build
tests cannot establish. Completion closes the former native Plan 018 without
reopening the accepted Hunch conversion or repeating already accepted voice,
link-preview, transcript-polishing, navigation, menu, and gesture work.

The historical implementation inventory and parity dispositions remain in
[`history/native/hunch-parity.md`](../history/native/hunch-parity.md). This
milestone contains only the checks that still determine acceptance.

## Artifact boundary

- Use exact newly built Arbor artifacts, not an installed stale copy.
- Use the existing iOS 27 simulator/device; do not create another simulator.
- Use a disposable or already designated Arbor test tree for destructive
  image, rename, recovery, and conflict checks.
- Do not write to the former Hunch source workspace or rerun its conversion.
- Record platform, page, and observed result for every failure.

## Images and assets

- [ ] Paste one image while editing text and one while navigating blocks;
  confirm each appears once, in place, and survives reopening.
- [ ] Paste several images together and confirm visual and Markdown ordering;
  undo and redo the import as one edit.
- [ ] Drag from Finder and a browser on macOS, then exercise the available
  Photos/files paste or drag path on iOS 27.
- [ ] Rename or move the containing page, relaunch, and confirm its logical
  asset references render; reopen a previously synchronized image offline.
- [ ] Paste the same image twice and confirm the provider's collision policy
  cannot silently overwrite bytes.
- [ ] Confirm read-only, historical, ordinary-file, and conflict surfaces
  cannot insert assets or create broken Markdown.
- [ ] Confirm a failed asset store inserts no broken block, exposes no host
  path, and does not reorder successful siblings.
- [ ] Confirm bytes follow the tree-root `Assets` policy and no standalone
  Import Asset command appears.
- [ ] Open the page twice and confirm delayed loads or source changes never
  display an earlier image in the wrong block.

## Title-driven rename

- [ ] On macOS and iOS, edit the H1, wait for the rename proposal, then test
  acceptance, dismissal, emoji, case-only changes, and a collision.
- [ ] Confirm acceptance preserves PageID, current tab/session state, Home,
  sidebar, search, backlinks, and the provider-authored filename.
- [ ] Follow an old inbound PageID link, relaunch, and confirm another device
  converges through ordinary synchronization without an eager workspace-wide
  rewrite.

## Recovery and conflict presentation

- [ ] Restore one trashed page and one local document revision as new local
  work; confirm no authority history is rewound.
- [ ] Exercise one visible sync conflict choice and confirm both sides remain
  recoverable, labels are understandable, and no filesystem path is exposed.
- [ ] Relaunch after the recovery action and confirm the accepted result and
  remaining recovery entries are stable.

## Accessibility and platform fit

- [ ] Audit image loading/missing state, rename proposals, recovery actions,
  conflict choices, and error banners with VoiceOver on macOS and iOS 27.
- [ ] Check reduced motion, keyboard-only navigation on macOS, touch focus and
  scrolling on iOS, and actionable labels for every acceptance control.
- [ ] Recheck one internal link, Back, Move To, offline edit/reconnect, and one
  non-document node so the audited paths retain Arbor's node-first behavior.

## Completion

When every check passes:

1. record the platforms, exact artifacts, and acceptance date in
   [`history/outcomes.md`](../history/outcomes.md);
2. update the historical parity matrix only with the resulting accepted state;
3. move this file to `history/interfaces/003-native-acceptance-audit.md` without
   renumbering it; and
4. remove the active row from [`interfaces/README.md`](README.md).

If a check fails, keep this milestone open and create the smallest focused fix.
Do not use a failure to broaden the audit into a native redesign.
