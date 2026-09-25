# Native 008: Complete native move, copy, and undo capture

Historical identifier: **Reliability 008 / Sync 008**. Status: PARTIAL; priorities remain open.

## What this means

This plan covers command capture in the Native editor and its Quagmire bridge.
canopyd and the merge tool already execute the supported operation kinds; their
reconciliation policies remain in [canopyd 014](../canopyd/014-merge-handles-many-cases.md).

When you move a paragraph, copy blocks to another page or undo an earlier command, Overstory can
send canopyd both the resulting text and a record of what you did. That gives canopyd evidence
for combining your action with edits from another device. Final text alone cannot reliably
establish whether you moved something, copied it, or independently typed matching text.

For example, if you move a paragraph while another device edits it, preserving the move's
source identity gives the server a basis for reconciling the two actions. This is not a promise
that every move merges automatically: ambiguous cases still need preserved alternatives.
Similarly, undo should identify your earlier action so the server can preserve independent
peer edits rather than simply restore an old whole-document snapshot.

## Already implemented

Ordinary source edits, exact source-backed copies (including same-tree cross-document copies),
page/entry moves and copies, typing/copy undo, and turning blocks into a new page with undo/redo
have implementation evidence. Their exact scope and release status live in the
change log (journals in [the local system](../../docs/architecture/canopy-browser/local-state.md#change-logs), invariants in [editor sources](../../docs/implementing-editors/editor-source.md#6-change-invariants-and-trace-compaction)), especially
cross-document copy and page conversion (`docs/overstory-spec/conformance/cross-document-copy.json`, `docs/overstory-spec/conformance/page-conversion-undo.json`).
The durable change log and source publication path already exist. Do not rebuild them.

## Remaining command coverage

Start by mapping each existing command to its actual captured operations and tests. These are
coverage gaps to resolve, not a request to add new editor commands or treat every listed
command as wholly unimplemented.

| Existing action or case | What remains |
|---|---|
| Move to Document of blocks apart from each other | Copied exactly today. State it as one change once canopyd reconciles a move anchored on material an earlier move carried into another page in both arrival orders ([canopyd 014](../canopyd/014-merge-handles-many-cases.md) item 1). A single block, a subtree or a contiguous selection is already one change, and in-page moves are done ([status](../../status.md#implemented)). |
| Copy material whose text or formatting changes (phase 3) | A duplicate at a new depth, paste within a tree and inlining a child page. Express the copy and its edits faithfully (`copySource`, then edits addressed to its result); never identify a source by matching text. Paste and inline need Quagmire 0.9.0 to report, generically, which host block each reminted block came from and to carry host pasteboard data; the same release replaces today's convention (a move hands over the original block IDs) with an explicit move-to-document hook. Inline states the child's text as a cross-document `moveSource` into the parent; retiring the child stays a separate change, because a change mixing moves and entry removals is not merged automatically. |
| Undo compound commands (phase 4) | Undoing an in-page rearrangement already publishes moves back, because Quagmire's undo restores the same block identities. Undoing Move to Document and inline-and-retire must publish the inverse over both documents (a move back; restoring the retired page as snapshot creation), using Quagmire's `TransactionEvidence`, which Canopy does not read yet. When the destination changed meanwhile, publish the origin's side as an ordinary edit and show that the blocks also remain there; never retarget to a newer basis. Page-conversion undo is already implemented. |
| Creation/import and actions at nested-tree boundaries | Check which existing actions can truthfully use supported operation forms and which must remain snapshots. Preserve TreeID and destination boundaries. |
| Multiple selections and exact-text edge cases | Moves of several blocks, equal-byte blocks, CRLF and combining characters are covered by `source-moves.json` and the codec tests. Verify copies the same way when phase 3 lands. |

Split/join remains deferred. Cross-tree copies remain ordinary appends. Trash restore retains
snapshot-creation semantics; there is no invented server-side Trash identity. Restoring the OS
undo stack after restart is separate from retaining already-authored undo requests.

## Implementation boundaries

- The editor/bridge records the actual command before serialization loses its meaning. The
  source ledger maps it to exact UTF-8 material and the original authored basis. Where an action
  identifies an operation result or a hidden alternative, preserve that reference explicitly;
  editing an alternative is not resolving it.
- The shared client durably retains bytes and operations before acknowledging the save. Keep
  immutable submitted requests, exact retries, unsent-only coalescing with valid lineage, newer
  edits and existing undo dependencies safe through offline use and restart.
- Do not retarget an old action to a newer basis, infer identity from equal bytes or silently
  discard captured operations. Preserve local work and expose a problem if it cannot be encoded.
- canopyd executes and reconciles the operations. Its existing support must cover every emitted
  form before client release. Server policy belongs to [canopyd 014](../canopyd/014-merge-handles-many-cases.md);
  accepted-choice review is already implemented and is not owned by this plan; see
  [status](../../status.md#implemented).
- Keep publication running while accepted choices remain unresolved. Explicit guarded review
  resolves choices; ordinary editing and equal bytes do not.

Browser integration belongs to [Web 025](../canopy-web/025-arbor-web.md) (formerly Web 023).
Installation of already-built work belongs to [release verification](../release-and-soak.md).
Neither is unfinished Native command capture in this plan.

## Done for each selected command

Use the real editor command with a disposable canopyd. Assert that it captures the intended
move/copy/undo and exact resulting bytes, including a concurrent peer edit. Test uncertain
acceptance, offline work, restart, unavailable source material and continued editing. Two actions
that produce the same text must still retain their different meanings when that distinction matters.
Ambiguity must preserve work rather than claim a false automatic merge.

Run focused ledger/client tests and relevant [development gates](../../DEVELOPMENT.md).
Keep shared TS/Swift models, fixtures and protocol documentation aligned if a contract changes.
Test coordinated Quagmire changes locally and follow the exact-release pinning workflow.
Record completed command coverage in the checkpoint and remove it from the remaining table.
