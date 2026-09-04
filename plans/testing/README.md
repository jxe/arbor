# Testing work

These plans establish maintained evidence for important invariants that do not
yet have one trustworthy automated or manual gate.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-ci.md) | Run the maintained TypeScript, browser, protocol, performance, and Swift gates in CI | P2 | TODO | 002 should land first if the repeated parallel lane is not stable |
| [002](002-parallel-integration-isolation.md) | Make parallel integration tests independent of process-global fixture state and scheduling | P1 | TODO | — |

## Smaller items

| Item | State | Promote when |
|---|---|---|
| Deterministic stale-save sequences | READY | Extend the clock-controlled coordinator suite across external rewrites, in-flight undo, failed structural undo, retry, and navigation during a pending generation. |
| Developer browser smoke harness | READY | Preserve DOM/state/network probes for deterministic invariants and reserve hands-on checks for hover, focus, pointer drag, and feel. |
| Canopy authorization characterization | READY | Cover revoked grants, read-link write denial, non-admin access mutation, and removal of transitive group access in a dedicated daemon suite. |
| Cross-client group workflow coverage | WAITING | Add browser and native creation/membership coverage after the smaller-project product gap has a designed first-party flow; do not freeze manual YAML as the UX. |
| Accessibility and responsive browser audits | READY | Establish repeatable keyboard, focus, semantic, contrast, and narrow/wide layout checks around the existing objective editor audit. |
| `mergeBlocks` characterization | READY | Add direct unit coverage for conservative conflict behavior before changing its alignment algorithm. |
| Markdown/BlockNote round-trip fixtures | READY | Add table-driven source-fidelity coverage for marks, raw fallback, nesting, and untouched bytes before expanding Smaller project 005 editing behavior. |

Exact-artifact native acceptance and completed device-management browser E2E
remain in [history](../_done/README.md); they are not duplicated here.
