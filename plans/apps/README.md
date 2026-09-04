# Apps project

This project makes authored Arbor applications executable. It is organized around complete product slices that freeze the shared compiler, runtime, hosting, and agent contracts. Numbers are stable local identifiers; the dependency column, not filename order, determines sequencing.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-supplies-executable-site.md) | Run the unchanged Supplies tree locally, natively, and on Canopy | P1 | IN PROGRESS — depends on 003 | completed SQLite runtimes; historical Data 002; 003 |
| [002](002-canopy-hosted-agents.md) | Host authored conversational interfaces over compiled Arbor handles | P1 | PLANNED | 001 compiled handles, Arbor users, and Canopy execution |
| [003](003-development-compiler-and-editor-tooling.md) | Compile and typecheck executable documents consistently in `arbor check`, editors, local Arbor, and Canopy | P1 | PLANNED | historical Data 002; 001 Supplies corpus |

The implemented headless SQLite query, observation, and mutation phases are described in [`@arbor/data`](../../packages/data/README.md). The next vertical gate is the unchanged [`examples/supplies`](../../examples/supplies) corpus running as executable documents in local Arbor web, signed macOS Arbor, and its canonical Canopy website. Apps 001 owns that product slice; Apps 003 owns its shared compiler and development tooling.

Canopy-hosted agents follow the same compiled query/mutation handles and authenticated Arbor-user context after that slice exists. They are not a separate data/runtime framework.

## Later portable-deployment outcome

Portable deployment remains an accepted direction rather than a numbered executor plan until the Supplies compiler emits one concrete portable document graph. That future work should:

- bake static ref/object output only when every selected document and query is statically valid;
- preserve per-document assets, initial results, live handlers, capabilities, and schema requirements;
- add another live adapter only when a real site needs it and the adapter can preserve identity, transactions, subscriptions, and fresh reconnects;
- retain the same input validation, Arbor-user identity, execution principal, and process limits as Canopy;
- emit ordinary-web crosslinks such as `<link rel="arbor">` and `Arbor-Tree`.

Promote this outcome to a numbered plan only after Apps 001 supplies the graph and one concrete second deployment target supplies the acceptance case.
