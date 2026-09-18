# Apps 006: Combined authority and durable query/mutation authoring

## Status and ownership

**P1 · PLANNED · after Apps [004](004-mutation-permissions.md) and
[005](005-source-resolution-and-sidecar.md); coordinates [003](003-development-compiler-and-editor-tooling.md).**
Replace unused query/mutation authoring as needed. Own final authoring signatures,
workflow progress/receipt encoding and implementation in the sidecar, not another
Canopy execution engine. Portable semantics live in [executable documents](../../spec/07-executable-documents.md)
and [authoring API](../../spec/08-authoring-api.md). The illustrative syntax there
is a design starting point, not an implemented compiler claim.

## First deliverable: freeze concrete authoring

Draft and typecheck three complete corpus cases together before generalizing:

1. Public `popularPractices`: author database read, no user capability, validated
   SQL-backed projection, SSR hydration and live replacement results.
2. `saveNote`: user-selected notebook, user create authority, optional read only
   when checks require it, ordinary guarded update, stable retry identity.
3. `savePractice`: author SQLite reads/pending-save writes, user notebook creation,
   durable prepare transaction, Canopy page creation, completion transaction.

Use `authority: { author, user }` requirements over typed logical handles. Pin
source resources/schema and explicit user selections. No raw connection strings,
ambient credentials or caller-supplied author identity. Keep Standard Schema input
validation and inferred RowOf/ResultOf. Freeze resource-selection typing, implicit
single-domain transaction form, explicit transaction callback, named `step` and
workflow state APIs in spec and shared fixtures before coding their implementations.
Queries use the same authority declaration but remain deterministic declarative
plans; do not execute arbitrary callbacks per row or lose finite source bounds.

## Compiler and permission integration

Compile requirements to concrete source bindings or bounded validated selections;
keep author/user provenance separate for coverage checks, then combine authority.
Generate human descriptions and consent diffs using accepted `trees.yaml` rules.
No additional consent for ordinary public access or already-covered requirements.
Only expansion/new targets require approval by the affected grantor. New versions
inside an existing tree envelope remain trusted; code/module refactors do not erase
policy. Imported library code gains no grant independently. Host activation binds
the sponsor and coherent code version. Public bundle inspection must prove absence
of server implementations, backing credentials and private schema.

## Runtime durability

1. Preserve single-domain runner-owned transactions and same-transaction receipts.
   Handler checks, reads, constraints, cascades, writes and result commit atomically.
   Clock/generated IDs and retry principal are stable across ambiguous retries.
2. Add durable invocation records: validated input/digest, caller replay scope,
   pinned code, requirements, resolved bindings, status and per-domain observations.
   Use opaque stable mutation identity; mismatched reuse is conflict. Persist pinned
   artifacts and define retention before allowing restartable work.
3. Implement stable named step records with input digest, state and completed result.
   Persist intent before attempting an effect. Backing commit must include retry
   evidence or provide equivalent reconciliation; a local journal alone is insufficient.
   A whole SQLite transaction is one step. For Canopy reuse ordinary accepted-update
   identity/receipt and exact guards; extend result mapping only where needed.
4. Resume by replaying completed outputs under pinned code. Missing code/binding is
   blocked, not upgraded. Automatic keys only for provably stable straight-line calls;
   loops/branches require explicit stable keys. Reject changed intent for an old key.
   Forbid transactions held open across another provider's awaited durable step.
5. Reauthorize new effects and disclosure of recorded results. Revocation preserves
   committed facts but blocks further unauthorized work. Cancellation stops future
   work; compensation is explicit and separately authorized. Never claim global
   rollback or exactly-once external delivery without backing proof.
6. Expose pending/blocked/failed/completed with safe committed progress. Return a
   final result only on completion. Receipt streams may reconnect by invocation
   identity under current authority; query streams remain stateless replacement
   streams. No cross-domain scalar cursor claiming atomic visibility.

## Two-store crash matrix

For prepare-SQLite / create-page / complete-SQLite inject process death:

- before and after intent persistence;
- before and after each backing commit;
- after Canopy acceptance but before response/step recording;
- after final receipt commit before HTTP delivery.

At every restart prove one page, one logical save, deterministic payload/IDs, durable
partial progress and eventual completion when authorized. Test lost response, duplicate
concurrent invocation, changed input, changed code/schema/provider binding, guard
conflict, removed pinned artifact, revocation between steps and blocked compensation.
Use two independent clients and restart real sidecar/backing processes, not only mocks.

## Queries, React, and consent UX

Preserve snapshot-and-follow including child membership races, relevant invalidation,
output hashing and full replacement reconnect. Sidecar chooses Canopy/SQLite providers
from bindings. Mixed queries use explicit bounded joins and cursor vectors; no
implicit atomic snapshot across stores. Initial SSR values hydrate without duplicate
reads; new subscriptions reauthorize. Separate cache by execution authority/user.

`useCanInvoke` reports coverage/missing consent only, never predicts row checks.
Actions preserve no-JS forms and ordinary navigation, stable submission identity,
progress and safe errors. Handle authority changes while an action or query is open.
No stacks, private SQL/schema, tokens or replay-principal digests reach the browser.

## Corpus and plan integration

Update Supplies source/fixtures intentionally to the new language; retire the old
"unchanged corpus" constraint for API migration while preserving application behavior.
Update Apps 001/002/003 consumers and language service declarations/source maps.
Hosted agents use the same authorization and durable handles; agent/external effects
remain separately specified, not a new ambient capability. Do not require production
Supplies data cutover to prove the new language.

## Gates and completion

Run compiler positive/negative/type inference fixtures, provider equivalence, focused
query/mutation tests and the process crash matrix. Then `bun run typecheck`,
`bun run test`, `bun run test:protocol`, `bun run build`, paired Swift suites for
changed wire models, executable-document browser gates, relative links and
`git diff --check`. Record exact tested artifact and distinguish manual verification.

Done: all three scenarios execute and recover over the real HTTP bridge; consent
expansion/revocation and private-data non-disclosure pass; authored common cases
need no hand-written outbox/receipt bookkeeping; unsupported arbitrary continuation
or cross-store atomicity fails explicitly. Update spec, status, reference docs and
move this plan to completed history only when those gates pass.
