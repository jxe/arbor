# Merge improvements

Joe wants related work on editor intent, client publication, host merging and
conflict review together. These plans cover different stages of the same edit;
keep their implementation boundaries explicit and share the end-to-end fixtures.

| Plan | Owns | When to take it |
| --- | --- | --- |
| [008: Capture copies with changes and compound undo](008-copies-with-changes-and-compound-undo.md) | Capture what the user actually did in the editor and Quagmire bridge. | A command loses identity before publication or unnecessarily reaches review. |
| [002: Identity-preserving coalescing](002-identity-preserving-coalescing.md) | Reduce already captured operations and intermediate objects in Swift and TypeScript clients. | Start with frequent typing/deletion bursts, then moves with edits; measure actual wire savings. |
| [014: Handle more merge cases](014-merge-handles-many-cases.md) | Reconcile concurrent operations in canopyd, including format rules and merge notes. | A real edit reaches review although its contributions can be preserved. |
| [015: Resolve reconciled choices](015-resolve-reconciled-choices.md) | Recognize when later work discharges an existing choice, record why, and explain the current result in clients. | After the page-transfer fixes prompted by the Psych conflict. |

The numbers retain their previous identities: Clients 002, Native 008, and
canopyd 014/015. They are identifiers, not an execution order.

## How they fit together

008 supplies truthful command evidence. 002 can simplify that evidence after it
exists; coalescing must not invent missing copy or move identity. 014 must support
the emitted operation forms before those clients are installed. 015 concerns
choices already created and shares 014's rule revisions and explanation format.
Keep those shared contracts in the protocol/docs and link to them from each plan.

These remain separate files because capturing a command, simplifying a burst,
merging concurrent edits and resolving an existing choice have different proofs
and release boundaries. They should share examples rather than duplicate tasks.
The shared automatic-resolution explanation work remains in 014; 015 implements
a specific rule and its review flow on that foundation.

## Related work elsewhere

- [History and restore](../history/007-document-history-routes-and-restore.md) and
  [line provenance](../history/006-line-provenance.md) expose past work and its
  attribution. They support explanation but do not improve merge decisions.
- [Server refinements](../small-work.md#server-refinements) tracks installation,
  deployment and manual verification of already implemented merge rules.
- [Web 025](../canopy-web/025-arbor-web.md) owns rebuilding the web reviewer;
  the plans here define the behavior and client evidence it consumes.

- [Ideas](../ideas.md#speed) retains unplanned merge replay performance work;
  its [testing candidates](../ideas.md#testing) include editor alignment and
  round-trip characterization. Promote these only when their stated trigger is met.
