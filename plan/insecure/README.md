# Insecure work

These plans close injection, authorization, secret-handling, hostile-input,
sandboxing, and trust-boundary gaps. Numbers are stable identifiers within this
workstream, not an execution order.

## Active plans

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-search-excerpts.md) | Render search excerpts without treating indexed content as HTML | P1 | TODO | — |
| [002](002-path-decoding.md) | Decode URL paths once at the external boundary | P1 | TODO | — |
| [003](003-canopy-host-responses.md) | Apply safe response headers and trustworthy pairing-rate-limit identity | P2 | TODO | — |
| [004](004-access-link-secrets.md) | Keep access-link secrets out of loopback navigation and durable visit state | P1 | TODO | — |

## Smaller items

| Item | State | Promote when |
|---|---|---|
| Isolate Canopy application-code execution | WAITING | Before Canopy executes synchronized `schema.ts`, SSR, query, or mutation code. Use one separately contained, quota-bound, version-pinned execution boundary shared with Application 003 rather than a schema-only retrofit. |
| Validate directory-entry names on every Wire client read path | READY | Add shared rejection of empty, dot, parent, and separator-bearing names before materialization; reuse the server graph invariant and add hostile-object fixtures. |
| Replace prose-derived authorization status | READY | Canopy/Wire responses must classify authorization failures with typed errors rather than matching English error text. Coordinate this with Plan 003 if it touches the same response helper. |
| Bound unauthenticated object reachability checks | NEEDS DESIGN | Build a staleness-safe reachability index before replacing full readable-tree graph scans on object requests. The performance work belongs in `slow`; the access invariant remains security-critical. |
| Upgrade reachable YAML parsing advisory | READY | Move the direct `yaml` dependency to a release containing the nested-collection stack-overflow fix, then run frontmatter and `_store.postgres` parsing tests. |
