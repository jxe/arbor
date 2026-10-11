# Merge improvements

Joe wants related work on editor intent, client publication, host merging and
conflict review together. These plans cover different stages of the same edit;
keep their implementation boundaries explicit and share the end-to-end fixtures.

| Plan | Owns | When to take it |
| --- | --- | --- |
| [015: Explain automatic resolutions and clear reconciled choices](015-resolve-reconciled-choices.md) | The portable explanation of any automatic outcome (notes, the three outcomes, rule revisions), the rule that clears a choice later work has reconciled, and its review flow in clients. | Now: the active merge plan. |
| [002: Identity-preserving coalescing](002-identity-preserving-coalescing.md) | Reduce already captured operations and intermediate objects in Swift and TypeScript clients. | Later. Start with frequent typing/deletion bursts, then moves with edits; measure actual wire savings. |
| [014: Handle more merge cases](014-merge-handles-many-cases.md) | A menu of concurrent edits overstoryd could reconcile, by format. | Parked. A real edit reaches review although its contributions can be preserved. |
| [008: Capture copies with changes and compound undo](008-copies-with-changes-and-compound-undo.md) | Capture what the user actually did in the editor and Quagmire bridge. | Parked. A command loses identity before publication or unnecessarily reaches review; needs a Quagmire release. |

The numbers retain their previous identities: Clients 002, Native 008, and
overstoryd 014/015. They are identifiers, not an execution order.

## How they fit together

008 supplies truthful command evidence. 002 can simplify that evidence after it
exists; coalescing must not invent missing copy or move identity. 014 must support
an emitted operation form before a client that emits it is installed. 015 gives
every automatic outcome its explanation, which 014's "merge with a note" candidates
wait for.

They stay separate files because capturing a command, simplifying a burst,
merging concurrent edits and resolving an existing choice have different proofs
and release boundaries. They share examples rather than duplicate tasks.

## Related work elsewhere

- [History and restore](../history/007-document-history-routes-and-restore.md) and
  [line provenance](../history/006-line-provenance.md) expose past work and its
  attribution. They support explanation but do not improve merge decisions.
- [Server refinements](../small-work.md#server-refinements) tracks the hand checks
  of merge rules that are already deployed.
- [Web 025](../story-web/025-story-web.md) owns rebuilding the web reviewer;
  the plans here define the behavior and client evidence it consumes.
- Merge replay cost is [Performance 003](../performance/003-fast-historical-catch-up.md).
  The [testing candidates](../ideas.md#testing) in ideas include editor alignment and
  round-trip characterization. Promote these only when their stated trigger is met.
