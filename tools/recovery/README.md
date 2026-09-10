# ArborSync tree recovery

`tools/recover-arborsync-tree.ts` is a deliberately separate recovery path for
a placed tree whose disk, pending ArborSync transition, retained editor
admissions, and current Canopy snapshot may disagree.

Preparation reads all four sources, verifies their immutable object graphs,
and writes a mode-`0700` evidence directory. It creates independently named
candidate bundles rather than silently deciding that disk or the last editor
record is authoritative. For every editor record it produces both the record's
historical tree and a disk-structure candidate with that record's exact
document source overlaid. Nothing is submitted during preparation.

```sh
bun tools/recover-arborsync-tree.ts prepare \
  --tree tr_example \
  --output /private/path/recovery-evidence \
  --exclude /placed/tree/Trash
```

Inspect `manifest.json`, the extracted Markdown under `sources/`, and the
candidate names before selecting one. Submission is a distinct command:

```sh
bun tools/recover-arborsync-tree.ts submit \
  --manifest /private/path/recovery-evidence/manifest.json \
  --candidate disk-with-admission-009 \
  --expect-current-update 1336 \
  --expect-current-root sha256:... \
  --expect-candidate-root sha256:...
```

The three expected values are deliberate typed confirmations from the reviewed
manifest. Submission refuses candidates with structural conflicts or
approximate Markdown placements, verifies that the bundle has not changed,
rechecks the exact Canopy update and root captured at preparation time, and
uses `onConflict=reject`. It does not rewrite ArborSync's journal or the placed
directory; normal reconciliation remains a separate step after the accepted
Canopy root is verified.
