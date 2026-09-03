# Smaller projects

These are bounded product or model outcomes that do not yet justify a major
project directory. They remain outcome-oriented plans rather than being filed
under whichever implementation theme they happen to touch.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-representation-equivalence.md) | Preserve node identity and logical equivalence when a child set changes representation | P1 | PLANNED | historical Data 002 and 011 |
| [002](002-locator-identity-surfaces.md) | Give stable keys one spelling per surface and one segment-parameter grammar | P2 | PLANNED | 001; Cleanup 001 |
| [003](003-native-offline-collection-file-projection.md) | Present synchronized collection-file rows through native offline replicas | P2 | DEFERRED until product need | historical Data 002 and 011; Apps 003 |
| [004](004-external-agent-access.md) | Let installed agents use structured Arbor CLI operations safely | P1 | PLANNED — read-only CLI work can begin | compiled handle invocation depends on Apps 001 |
| [005](005-web-editor.md) | Close the remaining web-editor interaction and fidelity gaps | P2 | BACKLOG | items are independently selectable unless noted |

When several related plans accumulate around one of these outcomes, promote
that cluster to a named top-level project without preserving this folder as an
extra indirection.
