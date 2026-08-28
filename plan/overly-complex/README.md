# Overly-complex work

This workstream tracks implementations whose avoidable ownership, state, or
control-flow complexity makes ordinary changes unsafe. Numbers, when assigned,
are stable local identifiers rather than an execution order.

Complex domain behavior is not enough to qualify. A plan belongs here only when
there is a simpler ownership boundary to adopt and characterization evidence can
prove that the simplification preserves behavior.

## Active plans

There are no executor-ready plans yet.

## Smaller items

| Item | State | Promote when |
|---|---|---|
| Split `ArborService` responsibilities | NEEDS CHARACTERIZATION | Protocol routing, the virtual system projection, and community/Wire orchestration currently share one large service. Promote this only after focused tests establish the seams and a current change needs one of them independently. |

Workspace undo/history architecture remains owned by
[Interface 002](../interfaces/002-web-editor.md), where its user-visible
semantics can be decided together rather than treated as a free-standing
refactor.
