# Native 008: Capture copies with changes and compound undo

Historical identifier: **Reliability 008 / Sync 008**; formerly "Complete native move, copy,
and undo capture". Status: PLANNED; in-page moves and Move to Document are done
([status](../../status.md#implemented)).

## What this means

When you copy blocks and change them, paste within a tree, inline a child page, or undo
a command that touched two pages, the Native editor should send canopyd a record of what
you did, not only the resulting text. That record is what lets canopyd combine your action
with another device's edits; final text alone cannot tell a copy from matching text typed
independently. This plan covers capture in the editor and its Quagmire bridge. Merge
policy is [canopyd 014](../canopyd/014-merge-handles-many-cases.md)'s.

The change log, source publication, moves (`source-moves.json`) and Move to Document as
one change already exist. Do not rebuild them.

## Remaining work

| Action or case | What remains |
|---|---|
| Copies whose text or depth changes | A duplicate at a new depth, paste within a tree, and inlining a child page. State the copy and its edits faithfully (`copySource`, then edits addressed to its result); never identify a source by matching text. |
| Quagmire 0.9.0 | Paste and inline need Quagmire to report, generically, which host block each reminted block came from, and to carry host pasteboard data. The same release replaces today's convention (a move hands over the original block IDs) with an explicit move-to-document hook. |
| Inline a child page | State the child's text as a cross-document `moveSource` into the parent. Retiring the child stays a separate change, because a change mixing moves and entry removals is not merged automatically. |
| Undo of compound commands | Undoing an in-page rearrangement already publishes moves back, because Quagmire's undo restores the same block identities. Undoing Move to Document and inline-and-retire must publish the inverse over both documents (a move back; restoring the retired page as snapshot creation), using Quagmire's `TransactionEvidence`, which Canopy does not read yet. When the destination changed meanwhile, publish the origin's side as an ordinary edit and show that the blocks also remain there; never retarget to a newer basis. |
| Move to Document of blocks apart from each other | Copied exactly today. State it as one change once canopyd reconciles a move anchored on material an earlier move carried into another page in both arrival orders (canopyd 014 item 1). |
| Creation, import and nested-tree boundaries | Check which existing actions can truthfully use supported operation forms and which must remain snapshots. Preserve TreeID and destination boundaries. |
| Exact-text edge cases for copies | Verify multiple selections, equal-byte blocks, CRLF and combining characters for copies as `source-moves.json` does for moves. |

Split/join remains deferred. Cross-tree copies remain ordinary appends. Trash restore
retains snapshot-creation semantics. Restoring the OS undo stack after restart is separate
from retaining already-authored undo requests.

## Implementation boundaries

- The editor records the actual command before serialization loses its meaning, mapped to
  exact UTF-8 material and the original authored basis.
- The change log retains bytes and operations durably before acknowledging a save; submitted
  requests stay immutable through offline use, restart and exact retries.
- Do not retarget an old action to a newer basis, infer identity from equal bytes, or silently
  discard captured operations. Preserve local work and show a problem if it cannot be stated.
- canopyd must execute every emitted form before a client that emits it is installed
  ([release and soak](../release-and-soak.md)).

Browser integration belongs to [Web 025](../canopy-web/025-arbor-web.md).

## Done for each command

Use the real editor command with a disposable canopyd. Assert the captured operations and
exact bytes, including a concurrent peer edit in both arrival orders, offline work, restart,
unavailable source material and continued editing. Ambiguity must preserve work rather than
claim a false automatic merge. Keep TypeScript and Swift models and fixtures aligned; test
Quagmire changes locally and pin the exact release in both manifests. Record completed
coverage in `status.md` and remove it from the table above.
