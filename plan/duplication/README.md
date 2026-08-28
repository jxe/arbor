# Duplication work

This workstream tracks the same invariant or behavior being maintained in
multiple places with a demonstrated risk of divergence. Numbers, when assigned,
are stable local identifiers rather than an execution order.

Do not introduce a framework merely because code looks similar. Promote an item
only after a second real consumer exists or two implementations have already
drifted.

## Active plans

There are no executor-ready plans yet.

## Smaller items

| Item | State | Promote when |
|---|---|---|
| Shared runtime protocol decoding | WAITING | A second trusted boundary besides Arbor Sync needs runtime decoding. Then colocate browser-safe pure decoders in `@arbor/core`; do not add schema generation solely to reduce repetition. |
| Provider scalar normalization | OWNED | Data 004 and Data 005 must freeze one language-neutral representation for blobs, 64-bit integers, booleans, nullability, and other provider scalars before TypeScript, Swift, queries, mutations, and observations can drift. |
| Bounded-placement conformance | OWNED | Data 003, 004, and 006 reuse the common placement corpus when deferred providers land; they must not create a second placement algorithm. |
