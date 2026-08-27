# Application milestones

These milestones build authored Arbor applications and the shared execution
capabilities those applications require. Their numbers are stable local
identifiers; the dependency column, not filename order, determines sequencing.

| Milestone | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-supplies-executable-site.md) | Run the unchanged Supplies tree locally, natively, and on Canopy | P1 | IN PROGRESS — compiler and development typechecking are next | completed SQLite runtimes; Data 002 provider-neutral node/query contract |
| [002](002-canopy-hosted-agents.md) | Host authored conversational interfaces over compiled Arbor handles | P1 | PLANNED | 001 compiled handles, Arbor users, and Canopy execution |

Portable deployment remains a roadmap outcome rather than an executor
milestone until the Supplies compiler produces a concrete portable document
graph to target.
