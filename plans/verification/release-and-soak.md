# Remaining release and verification work

This checklist owns unfinished operational and manual gates transferred from mostly completed
plans. It does not authorize installation, restarting Joe's apps, production changes, deleting
backups or closing compatibility windows. Preserve live editors and recovery evidence.
Source implementation status is distinct from installed/deployed behavior.

## Native release and hands-on review

Owners: Native [008](../soon/008-complete-native-move-copy-undo-capture.md) for operation capture and Native
[010](../swift/010-inline-choice-context.md) for review behavior.

- [ ] Install the tested rejected-update retirement, broader operation capture and accepted-choice
  review when Joe can quit both apps. Verify the exact selected revision and destination server
  support first. Quagmire 0.8.0 is already pinned; do not repeat that dependency release.
- [ ] Verify opening existing state, automatic publication, cross-device propagation and restart
  without losing drafts, pending requests or newer editor work. Do not overwrite active source
  journals with an older snapshot-only build.
- [ ] Complete 010's macOS/iPhone hands-on gate: layout, typing, focus, selection, scrolling,
  keyboard routing, VoiceOver, large text and installed review-draft recovery.

Evidence: the source cutover, capture, and review checkpoints are in git history (`docs/native-source-cutover.md`, `docs/source-admission-queue.md`, `docs/native-conflict-review.md`); their surviving facts are in [the local system](../../docs/architecture/arborsync/data-home.md), [editor sources](../../docs/implementing-editors/editor-source.md), and [Native 010](../swift/010-inline-choice-context.md).
Passing builds and automated tests do not establish interactive acceptance.

## Server refinements

Owner: canopyd [014](../soon/014-merge-moved-text.md). Deployed with `5ef1fe20` (2026-09-22); hand verification not yet recorded.

- [ ] Rehearse, deploy and verify independent source-range inspection and the subsequent Markdown
  transfer/list-insertion refinements. Record the exact revision and packaged worker together.
  Preserve existing whole-file policy and format-required coupling.
- [ ] Record server readiness before enabling any newly captured client operation forms.

The schema-12 merge-authority cutover (migration 010, deleted after cutover; see git history) is complete;
these later refinements are not another request to repeat that migration.

## Observation and soak closeout

These gates remain unconfirmed by this cleanup. Dated evidence is required to close them;
elapsed calendar time alone is insufficient.

- [ ] **Native 022:** record completion of the original ordinary-use working-tree soak before
  starting Web 025. The working-tree switch and subsequent Mac/iPhone source-mode installation
  are already live. Do not repeat the old re-place or rollout instructions.
- [ ] **Arbor Sync 001:** record the remaining raw-byte protocol soak, including ordinary use on
  both platforms. Migration 005 (migration 005, deleted after cutover; see git history) already
  records matching rehearsals, unchanged authored bytes, both upgrades and round-trip edits.
  No history reset is requested.
- [ ] **Clients 001 soak:** ordinary use of the one update machine on Mac, iPhone and the
  daemon. It absorbs the Reliability 012 observation, whose publication path Clients 001
  replaced: record continued automatic Mac publication through subsequent edits, merges,
  offline work and reconnect without Sync Now. Installation, cross-device publication and
  restart already have evidence. If a stall recurs, capture the machine phase and
  preparation error before retrying; see the automatic-publication recipe below. Phone
  foreground refresh is expected, not a background-sync defect.
- [ ] **Clients 001 / Hetzner sync lab:** run `packages/canopyd/deploy/hcloud-sync-lab` against
  the update-machine daemon. Its binary scenario now expects Canopy to accept both versions as an
  unresolved alternative instead of a daemon conflict; it has not run since that rewrite.

Historical plans: Native 022 (completed plan, deleted; see git history),
Arbor Sync 001 (completed plan, deleted; see git history),
Reliability 012 (completed plan, deleted; see git history; its soak is now part of the
Clients 001 soak).
The deleted progress investigation (git history: `docs/native-sync-progress.md`) preserved the reproduced failures
without claiming to prove the original incident's exact cause.

## Compatibility windows remain separate

[Cleanup 001](../cleanups/001-pageid-stable-key-cutoff.md) retains its own data audit,
operator decision and backup conditions. A date passing does not close that window.
Cleanup 002 closed on 2026-09-21; its evidence is in [status](../../status.md#v1-account-and-local-state-cutoff--2026-09-21).

When a gate passes, record exact revision/date/evidence in its owning checkpoint, then remove
that completed checkbox here. Do not keep finished release steps as an evergreen executor plan.

## Manual recipes retained from the deleted checkpoints

**Editor recovery.** Rebuild the app and use a disposable page: edit offline,
reconnect without Sync Now, and verify host and peer convergence. Quit the app
while offline with unpublished edits and verify the reopened page shows them
from the change log, then that they publish. Preserve real user text before
intentionally testing process interruption.

**Automatic publication.** Verify ordinary automatic Mac edit publication and
subsequent edits after a merge or reconnect without Sync Now. If publication
stalls again, capture the machine phase and the actual preparation error
before any manual retry; the two historical stalls were a no-work pass that
left `preparing: true` with no task, and a preparation failure raised outside
the submission error handler. The fix must never clear a pending request,
rewrite its digest, discard a saved head, or alter protocol semantics.

**Resource policy soak.** Exercise Canopy consent and revocation and
configuration conflict resolution on the isolated production copy, including
queued configuration writes. Keep the schema 13 migration backups until this
soak closes.
