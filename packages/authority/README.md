# @arbor/authority

The trusted, single-process Arbor authority implementation. It depends on `@arbor/wire`; the wire package never depends on it.

Update handling is divided by independently testable responsibility:

- `updates/decision.ts` — the complete identity-only current/accept/merge table;
- `updates/reconcile.ts` — invokes the merge engine only when both sides changed;
- `updates/merge.ts` — pure graph and exact-source Markdown merging;
- `updates/store.ts` — private accepted history, derived-request replay lookup, schema upgrade, and the ref/reflog/accepted-row transaction;
- `authority.ts` — validation, object durability, bounded race coordination, and other authority features;
- `host.ts` — HTTP authentication, decoding, response mapping, and no update policy.

Accepted roots and reachable objects are retained indefinitely as private operational state. HTTP object authorization considers only current readable roots; there is no accepted-history or historical-object route.
