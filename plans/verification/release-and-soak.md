# Remaining release and verification work

This checklist owns unfinished operational and manual gates transferred from mostly completed
plans. It does not authorize installation, restarting Joe's apps, production changes, deleting
backups or closing compatibility windows. Preserve live editors and recovery evidence.
Source implementation status is distinct from installed/deployed behavior.

## Native release and hands-on review

Owners: Native [008](../native/008-complete-native-move-copy-undo-capture.md) for operation capture and Native
[010](../native/010-client-conflict-review.md) for review behavior.

- [ ] Install the tested rejected-update retirement, broader operation capture and accepted-choice
  review when Joe can quit both apps. Verify the exact selected revision and destination server
  support first. Quagmire 0.8.0 is already pinned; do not repeat that dependency release.
- [ ] Verify opening existing state, automatic publication, cross-device propagation and restart
  without losing drafts, pending requests or newer editor work. Do not overwrite active source
  journals with an older snapshot-only build.
- [ ] Complete 010's macOS/iPhone hands-on gate: layout, typing, focus, selection, scrolling,
  keyboard routing, VoiceOver, large text and installed review-draft recovery.

Evidence: [source cutover](../../docs/native-source-cutover.md) records the older installed source-mode
build; [capture checkpoint](../../docs/source-admission-queue.md) and
[review checkpoint](../../docs/native-conflict-review.md) record newer implemented behavior.
Passing builds and automated tests do not establish interactive acceptance.

## Server refinements

Owner: Canopy [009](../canopy/009-canopy-provenance-merges.md).

- [ ] Rehearse, deploy and verify independent source-range inspection and the subsequent Markdown
  transfer/list-insertion refinements. Record the exact revision and packaged worker together.
  Preserve existing whole-file policy and format-required coupling.
- [ ] Record server readiness before enabling any newly captured client operation forms.
  Use [011](011-client-compatibility.md)'s mixed-client checks.

The [schema-12 merge-authority cutover](../../migrations/010-merge-state/live-cutover.md) is complete;
these later refinements are not another request to repeat that migration.

## Observation and soak closeout

These gates remain unconfirmed by this cleanup. Dated evidence is required to close them;
elapsed calendar time alone is insufficient.

- [ ] **Native 022:** record completion of the original ordinary-use working-tree soak before
  starting Web 023. The working-tree switch and subsequent Mac/iPhone source-mode installation
  are already live. Do not repeat the old re-place or rollout instructions.
- [ ] **Arbor Sync 001:** record the remaining raw-byte protocol soak, including ordinary use on
  both platforms. [Migration 005](../../migrations/005-file-bytes-are-the-object/README.md) already
  records matching rehearsals, unchanged authored bytes, both upgrades and round-trip edits.
  No history reset is requested.
- [ ] **Reliability 012 / accepted-state cutover:** record continued automatic Mac publication
  through subsequent edits, merges, offline work and reconnect without Sync Now. Installation,
  cross-device publication and restart have later evidence; the full original observation matrix
  is not certified. If a stall recurs, capture the machine phase and preparation error before
  retrying. Phone foreground refresh is expected, not a background-sync defect.

Historical plans: [Native 022](../_done/native/022-run-the-mac-app-as-a-working-tree-client.md),
[Arbor Sync 001](../_done/arborsync/001-file-bytes-are-the-object.md),
[Reliability 012](../_done/reliability/012-native-sync-progress.md).
The [progress investigation](../../docs/native-sync-progress.md) preserves the reproduced failures
without claiming to prove the original incident's exact cause.

## Compatibility windows remain separate

[Cleanup 001](../cleanups/001-pageid-stable-key-cutoff.md) and
[Cleanup 002](../cleanups/002-retire-v1-account-and-local-state-adapters.md) retain their own data audits,
operator decisions and backup conditions. A date passing does not close those windows.

When a gate passes, record exact revision/date/evidence in its owning checkpoint, then remove
that completed checkbox here. Do not keep finished release steps as an evergreen executor plan.
