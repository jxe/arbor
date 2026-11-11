# Apps 006: Combined authority and durable query/mutation authoring

**Why and when:** part of the same push as Apps 005, after it: the authoring API that declares author and user authority together is what exercises the permissions and lending models.

## Status and ownership

**PLANNED · after Apps
[005](../../status.md#views-on-the-host-and-declared-views--2026-11-08); coordinates [011](../soon/apps-011-widgets-in-story.md).**
**Superseded in part (Joe, 2026-11-11):** views and mutations are now written in the
declarative view language, UVL ([reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views)),
and TypeScript authoring is gone ([Apps 015](../soon/apps-015-the-view-language.md)). The
TypeScript signatures below (`authority`, `step`, transaction callbacks) are a record of the
earlier design; durable workflows and combined author/user authority must be redesigned as
language statements before any of this is built. Code with general effects is
[runners](apps-017-data-runners.md).

## First deliverable: freeze concrete authoring

Draft and typecheck three complete corpus cases together before generalizing:

1. Public `popularPractices`: author database read, no user capability, validated
   SQL-backed projection, SSR hydration and live replacement results.
2. `saveNote`: user-selected notebook, user create authority, optional read only
   when checks require it, ordinary guarded update, stable retry identity.
3. `savePractice`: author SQLite reads/pending-save writes, user notebook creation,
   durable prepare transaction, overstoryd page creation, completion transaction.

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
keep each grant's lender separate for coverage checks, then combine authority.
Generate human descriptions and consent diffs using accepted `access.yaml` and
`apps.yaml` rules.
No additional consent for ordinary public access or already-covered requirements.
Only expansion/new targets require approval by the affected grantor. New versions
inside an existing tree envelope remain trusted; code/module refactors do not erase
policy. Imported library code gains no grant independently. Host activation binds
the lenders and coherent code version. Public bundle inspection must prove absence
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
   A whole SQLite transaction is one step. For overstoryd reuse ordinary accepted-update
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
- after overstoryd acceptance but before response/step recording;
- after final receipt commit before HTTP delivery.

At every restart prove one page, one logical save, deterministic payload/IDs, durable
partial progress and eventual completion when authorized. Test lost response, duplicate
concurrent invocation, changed input, changed code/schema/provider binding, guard
conflict, removed pinned artifact, revocation between steps and blocked compensation.
Use two independent clients and restart real sidecar/backing processes, not only mocks.

## Queries, React, and consent UX

Preserve snapshot-and-follow including child membership races, relevant invalidation,
output hashing and full replacement reconnect. Sidecar chooses overstoryd/SQLite providers
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
Update Apps 002/011 consumers and language service declarations/source maps.
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
or cross-store atomicity fails explicitly. Update spec, status and reference docs,
and delete this plan only when those gates pass.

## Text moved from the spec (2026-11-11)

Joe moved these undecided designs out of [reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views) on 2026-11-11, since they aren't built. They come back into the spec when this plan decides them. Old section numbers are from that chapter before the move.

### From §5 Mutations

A mutation may coordinate multiple domains through durable steps. This is a
recoverable workflow, not a distributed atomic transaction. A later failure does
not roll back previously committed steps. The runtime records stable step identity,
input, code/binding identity and completed output; each backing atomically couples
effects with retry evidence or supplies equivalent crash recovery. A sidecar journal
alone cannot close the committed-but-response-lost gap. Pending work resumes against
its pinned code and bindings, reauthorizes remaining effects, and reports blocked
or failed progress without disguising partial completion. Compensation is explicit.

Portable mutable schema includes primary and alternate unique keys, ordered
foreign-key field pairs, nullability, and explicit constraint actions. Primary
keys are immutable. The first portable foreign-key subset supports `restrict`,
`cascade`, and `set-null` on delete, validated at transaction end so declared
deferred or cyclic inserts succeed. `ON UPDATE CASCADE`, `SET DEFAULT`, and
backing-default collation or coercion are not portable. A foreign key may cross
collections only inside one logical data tree and one transaction domain; a
cross-tree Overstory reference is a typed authored property, not a transactional
foreign key. An accepted mutation contains every direct and cascading effect.
Overstory never invents cascade intent for an ambiguous concurrent file edit or
imprecise invalidation, and separate collection files do not imply a shared
transaction domain.

For each atomic step the runtime records retry identity and its completed result
in the same transaction domain as its data effects, or uses an equivalent crash-recoverable
mechanism that distinguishes a completed commit from an unexecuted intent after
restart. Backing adapters provide guarded physical commit primitives; they do
not define transaction scope, retry identity, or mutation semantics.

### From §12.4 Durable workflow execution

The query/mutation Overstory shapes above describe single-domain values and remain a
basis for the runtime bridge, not a compatibility requirement for unused APIs.
Workflow calls additionally expose `pending`, `blocked`, `failed`, or `completed`
status and domain-specific receipts. They must not invent one `observedThrough`
that promises atomic cross-domain visibility. [Apps 006](apps-006-durable-authoring.md)
owns the paired language-neutral request/progress/receipt encoding before implementation.

A durable step key is unique within an invocation, has canonical input, and is
bound to pinned code and resolved source identities. Reusing a key for different
intent fails. Completed output is replayed without repeating effects. Clock and
ID values needed for replay are captured durably before use. Branches and loops
require stable keys; automatic identity is allowed only where the compiler proves
it remains stable. No arbitrary JavaScript continuation or process heap is durable.
Transactions cannot span a suspension awaiting another provider. Restart without
the pinned code or binding yields a diagnosable blocked run, never execution with
new code. Receipts/results remain subject to current disclosure authority.

Query SSR/hydration may reuse validated initial values; subscription always
reauthorizes and establishes snapshot-and-follow. SQLite changes use provider
observation, tree changes use host watch, and policy changes invalidate both.
Mutation completion and subscribed results may arrive in either order. A disconnected
client does not cancel already committed steps; explicit cancellation stops only
future steps and reports what committed. Durable records must retain pinned code,
bindings, step receipts and pending effects until safe recovery/retention expiry.

### From §16.3 Mutations

Views and mutations declare `authority: { author: [...], user: [...] }`.
Requirements identify resolved source handles and operations, not credentials or
arbitrary authority-bearing strings supplied by callers. Both parties' requirements
are checked separately, then their granted capabilities combine for execution.
Expansion beyond existing resource rules requires renewed consent; module/export
renames within a code TreeID do not discard grants. Omission never confers ambient
authority. Ordinary caller read permission, including `everyone`, works through code.

The following is illustrative authoring syntax; [Apps 006](apps-006-durable-authoring.md)
freezes the exact overloads, resource-selection typing and step API using the Supplies
corpus before implementation. The previous `permission()` and `{ requires }` forms
are superseded, not compatibility obligations.

```ts
export const savePractice = mutation({
  input: inputSchema,
  authority: {
    author: [practices.read(), saves.create()],
    user: [notebook.createChildren()],
  },
  async run({ input, user, step }) {
    const prepared = await step("prepare", () => database.transaction(async tx => {
      const practice = await tx.practices.get(input.practiceID)
      return tx.saves.prepare({ practice, user })
    }))
    const page = await step("page", () => notebook.create(prepared.page))
    return page
  },
})
```

Runtime handles choose their provider through the host's provider bindings, after their locators resolve by the ordinary [resolution rules](../../docs/overstory-spec/1.6-locators.md#4-resolution-rules).
Single-domain handlers retain an implicit runner-owned transaction where declared;
multi-domain handlers use explicit transaction blocks and stable durable steps.
Straight-line handle calls may receive compiler-generated stable steps; loops,
branches or dynamic repetition require explicit keys where stability is not proved.
The runtime owns receipts and deterministic IDs; authors do not implement receipt
or outbox tables. A transaction callback is one atomic step, not a sequence of
independently replayed row writes. Throws roll back only the active transaction.
