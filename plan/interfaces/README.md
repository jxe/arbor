# Interface milestones

These milestones improve a concrete way a person or external tool uses Arbor.
They are independent unless the dependency column says otherwise; numbers are
stable local identifiers rather than a required execution order.

| Milestone | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-external-agent-access.md) | Let installed agents use structured Arbor CLI operations safely | P1 | PLANNED — read-only CLI work can begin | compiled handle invocation depends on Applications 001 |
| [002](002-web-editor.md) | Close the remaining web-editor interaction and fidelity gaps | P2 | BACKLOG | items are independently selectable unless noted |
| [003](003-native-acceptance-audit.md) | Finish the exact-artifact native image, rename, recovery, and accessibility audit | P1 | IN PROGRESS — implementation is complete; acceptance checks remain | completed native implementation in [history](../history/native/README.md) |
| [004](004-device-management-browser-e2e.md) | Add focused browser E2E for device management | P2 | DEFERRED — reconcile against the plural account/pairing surface | 005, completed native Plan 010 |
| [005](005-multi-canopy-connections.md) | Use multiple Canopy accounts and one aggregate `trees.yaml` through one Arbor Sync | P2 | PLANNED | completed native Plan 010 and account-configuration/self-sync foundation |
