# Native 008: Complete native move, copy, and undo capture

Historical identifier: **Reliability 008 / Sync 008**. Status: PARTIAL; priorities remain open.

## What this means

This plan covers command capture in the Native editor and its Quagmire bridge.
canopyd and the merge tool already execute the supported operation kinds; their
reconciliation policies remain in [canopyd 009](../canopyd/009-canopy-provenance-merges.md).

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
the admission queue (journals in [the local system](../../docs/canopy-browser/local-state.md#source-admission-journals), invariants in [client state machines](../../docs/canopy-browser/document-admission.md#7-admission-invariants-and-trace-compaction)), especially
cross-document copy and page conversion (`spec/conformance/cross-document-copy.json`, `spec/conformance/page-conversion-undo.json`).
The durable queue and source publication path already exist. Do not rebuild them.

## Remaining command coverage

Start by mapping each existing command to its actual captured operations and tests. These are
coverage gaps to resolve, not a request to add new editor commands or treat every listed
command as wholly unimplemented.

| Existing action or case | What remains |
|---|---|
| Move source blocks, including Move to Document | Preserve the actual source/destination relationship where the existing command does not yet capture it. Distinguish moving text from moving a whole page entry. |
| Copy material whose text/formatting changes | Extend beyond the byte-exact source spans currently captured. Express the copy and actual edits faithfully; never identify a source by searching for matching text. |
| Undo compound commands such as moving blocks or inlining a child page and retiring it | Inventory their actual effects, then retain enough action identity to undo those effects without implicitly erasing peer work. Page-conversion undo is already implemented. |
| Creation/import and actions at nested-tree boundaries | Check which existing actions can truthfully use supported operation forms and which must remain snapshots. Preserve TreeID and destination boundaries. |
| Multiple selections and exact-text edge cases | Verify existing capture first; fix demonstrated gaps involving ordering, equal-byte edits, CRLF or combining characters. These are not separate new features. |

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
  form before client release. Server policy belongs to [canopyd 009](../canopyd/009-canopy-provenance-merges.md);
  conflict review belongs to [Native 010](010-client-conflict-review.md).
- Keep publication running while accepted choices remain unresolved. Explicit guarded review
  resolves choices; ordinary editing and equal bytes do not.

Browser integration belongs to [Web 025](../canopy-web/025-arbor-web.md) (formerly Web 023).
Installation of already-built work belongs to [release verification](../verification/release-and-soak.md).
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
