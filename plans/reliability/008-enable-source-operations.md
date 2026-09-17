# Reliability 008: Capture and submit client operations

Status: READY for client capture work; broader network emission depends on the
retention contract in [009](009-canopy-provenance-merges.md). Priority: P1. Execute
this plan on main. It owns editor capture, shared client durability and submission,
not operation interpretation or merge policy. Native review stays in
[010](010-client-conflict-review.md).

This is one of three coordinated plans: 008 clients, 009 Canopy, and Reliability
013 (`plans/_done/reliability/013-merge-operations-and-formats.md` on `codex/merge-tool`)
for full operation semantics and format/language rules. The merge tool can develop
against fixtures before client changes ship. A client need not wait for semantic
support when Canopy can safely accept its explicitly recorded, unvalidated intent.

## Starting point and contract gate

Inspect git status, current source and tests before trusting plan prose. Read the
[goal source-intent contract](../../spec/10-source-intent.md), Wire codecs and fixtures,
Swift/TS working-tree clients, Quagmire source ledger and editor bridge. The
[source queue](../../docs/source-admission-queue.md),
[installed source cutover](../../docs/native-source-cutover.md), and
[accepted conflicts](../../docs/accepted-entry-conflicts.md) record existing evidence.
Installed Native already emits supported source edits; filesystem clients emit
snapshots. This plan contains remaining work, not a request to rebuild that foundation.

Today supplied operations are authoritative intent. Before sending a broader subset,
009 must specify and deploy the distinction between recorded intent and verified
execution. Do not silently ignore an authoritative operation or weaken validation
of the already supported subset. No versioned API, capability advertisement, residual
field, local conflict hold, or coordinated per-operation cutover is required.

## 1. Capture intent at its source

- Capture editing transactions before serialization loses move/copy/undo distinctions.
  Map editor positions to exact UTF-8 material through the source ledger. Retain the
  authored basis, ordering, operation identity and exact resulting candidate.
- Broaden `editSource` capture across multiple selections, insert/delete/replace,
  equal-byte edits, CRLF, combining marks and retained source spans.
- Capture entry rename/move/copy/remove/replace, including directories and assets;
  preserve TreeID boundaries and destination scope.
- Capture source move/copy, paragraph/list reorder and split/join as operations or
  faithful compositions. Equal final bytes do not make copy and move equivalent.
- Carry operation-result and alternative references where the authoring action
  identifies them. Keep edits to hidden alternatives distinct from resolution.
- Preserve causal targets for undo/redo. Do not represent selective undo as restoring
  an old tree snapshot; if causal evidence is unavailable, retain the actual edit
  without inventing an undo claim.
- Start with Native/Quagmire and the maintained Swift/TS client APIs. Integrate the
  TS session consumer into its eventual editor host. Do not invent confident editor
  intent from filesystem observations; genuine snapshots remain first-class.

Local capture and fixtures can precede server deployment. Network emission of new
forms starts only after 009's envelope, references and retention support is verified.

## 2. Make the shared client own durability and submission

- EditorBridge owns exact source mapping, selections and editor transactions. The
  working-tree client owns basis binding, identities, admission, durable records,
  retries and acknowledgement. Keep these policies enforced by types/state transitions.
- Retain candidate bytes and exact captured operations atomically before acknowledging
  admission. Carry the distinction between recorded and validated evidence through
  transport, recovery, bootstrap and retained history; acceptance is not proof of
  semantic validation.
- Coalesce only unsent work with compositional lineage. Freeze submitted prefixes;
  retries resend the same digest-covered intent, and later edits retain their own
  authored predecessors. Do not rewrite an R1 edit against a newly observed R2.
- Preserve operations and dependencies through in-flight requests, other-page edits,
  mixed structural/source changes, restart and equal-root accepted transitions.
- Do not drop intent because today's rule cannot interpret it. Use only the explicit
  retention contract; if a form is not safely retainable, keep the local work and
  report that concrete admission problem rather than guessing a fallback meaning.
- Keep normal publication and remote catch-up running while accepted choices remain
  unresolved. Do not create a client merge engine over the pending queue.
- Persist explicit resolution guards with the submitted operations; ordinary editing
  or byte equality never resolves a choice. Review presentation belongs to 010.

## 3. Enable collection independently of merge quality

- Ship the Canopy retention contract first, then enable client emission one operation
  family at a time. Semantic rule support may arrive later. Record actual destination
  readiness in release evidence rather than adding a negotiation endpoint.
- Preserve supported authoritative execution while collecting additional intent under
  the new explicit semantics. Never rewrite an old pending request into the new form
  under the same identity; specify recovery/transition behavior with 009.
- Test coordinated Arbor/Quagmire edits locally, then follow the documented release,
  exact pin and local-workspace workflow. Use real editor transactions as release gates.
- Install the previously tested Native rejected-update cleanup when the user can quit
  both apps, preserving backups and verifying opening, publication and restart. This
  remaining deployment task is separate from building new operation capture; see the
  [queue checkpoint](../../docs/source-admission-queue.md#rejected-update-retirement-september-17).

## Verification and completion

Maintain paired fixtures with identical snapshots but different move/copy/undo intent.
Assert original bases, identities and referenced material survive every durable
boundary, including uncertain acceptance and restart. Test a Canopy that retains but
does not interpret an operation, then a newer tool validating it for a subsequent
merge without changing the original receipt. Test invalid envelopes, unavailable
material, unsupported retention, stale resolution and false lineage distinctly.

Update the client state-machine spec, TypeScript and Swift models, shared conformance
fixtures and reference docs for contract changes. Run focused client/ledger tests and
[development gates](../../DEVELOPMENT.md). Real Native admission plus disposable
Canopy must demonstrate R1 capture, R2 arrival, retained intent, accepted ambiguity,
continued editing and another client's guarded resolution. Record delivered slices
in status/docs and remove completed tasks here. Review caching remains deferred.
