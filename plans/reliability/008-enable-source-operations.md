# Reliability 008: Capture and submit client operations

Status: PARTIAL. Source lineage, equal-byte admission, ordinary entry move/copy
and compound entry actions are implemented; see the [capture checkpoint](../../docs/source-admission-queue.md#supported-operation-capture-checkpoint--september-17). Emit the eight authoritative operation kinds supported by the
deployed merge tool. Priority: P1. Execute
this plan on main. It owns editor capture, shared client durability and submission,
not operation interpretation or merge policy. Native review stays in
[010](010-client-conflict-review.md).

[009](009-canopy-provenance-merges.md) owns Canopy policy and inspection;
[013](../_done/reliability/013-merge-operations-and-formats.md) delivered operation
execution. Server support precedes client emission. Retain-only operations and
opaque unvalidated payloads are out of scope.

## Starting point and contract gate

Inspect git status, current source and tests before trusting plan prose. Read the
[goal source-intent contract](../../spec/10-source-intent.md), Wire codecs and fixtures,
Swift/TS working-tree clients, Quagmire source ledger and editor bridge. The
[source queue](../../docs/source-admission-queue.md),
[installed source cutover](../../docs/native-source-cutover.md), and
[accepted conflicts](../../docs/accepted-entry-conflicts.md) record existing evidence.
Installed Native already emits supported source edits; filesystem clients emit
snapshots. This plan contains remaining work, not a request to rebuild that foundation.

Supplied operations remain authoritative intent. Do not silently ignore operations
or weaken execution validation. No versioned API, capability advertisement, residual
field, local conflict hold, or coordinated per-operation cutover is required.

## 1. Capture intent at its source

- Capture editing transactions before serialization loses move/copy/undo distinctions.
  Map editor positions to exact UTF-8 material through the source ledger. Retain the
  authored basis, ordering, operation identity and exact resulting candidate.
- Broaden `editSource` capture across multiple selections, insert/delete/replace,
  equal-byte edits, CRLF, combining marks and retained source spans.
- Extend entry capture to tree-boundary entries and creation/import where supported
  operation forms can faithfully express the action. Compound sibling-body
  move/copy/rename, copy page-ID edits and private-trash removals are implemented.
  Restore intentionally remains snapshot creation from private retained material;
  do not invent server-side Trash identity or causal undo. Preserve TreeID boundaries
  and destination scope.
- Extend source capture with explicit block-copy and transaction evidence for
  source move/copy and split/join. Stable-block reorders already retain verified
  lineage, including equal-byte reorders. Do not infer copies from matching text.
- Carry operation-result and alternative references where the authoring action
  identifies them. Keep edits to hidden alternatives distinct from resolution.
- Preserve causal targets for undo/redo. Do not represent selective undo as restoring
  an old tree snapshot; if causal evidence is unavailable, retain the actual edit
  without inventing an undo claim.
- Start with Native/Quagmire and the maintained Swift/TS client APIs. Integrate the
  TS session consumer into its eventual editor host. Do not invent confident editor
  intent from filesystem observations; genuine snapshots remain first-class.

Use existing supported operation forms; add server execution before emitting any new kind.

## 2. Make the shared client own durability and submission

- EditorBridge owns exact source mapping, selections and editor transactions. The
  working-tree client owns basis binding, identities, admission, durable records,
  retries and acknowledgement. Keep these policies enforced by types/state transitions.
- Retain candidate bytes and exact captured operations atomically before acknowledging
  admission. Validate exact execution against the candidate and preserve intent
  through transport, recovery, bootstrap and retained history.
- Coalesce only unsent work with compositional lineage. Freeze submitted prefixes;
  retries resend the same digest-covered intent, and later edits retain their own
  authored predecessors. Do not rewrite an R1 edit against a newly observed R2.
- Preserve operations and dependencies through in-flight requests, other-page edits,
  mixed structural/source changes, restart and equal-root accepted transitions.
- If captured intent cannot be validly expressed with supported operations, retain
  local work and report the admission problem rather than inventing operation meaning.
- Keep normal publication and remote catch-up running while accepted choices remain
  unresolved. Do not create a client merge engine over the pending queue.
- Persist explicit resolution guards with the submitted operations; ordinary editing
  or byte equality never resolves a choice. Review presentation belongs to 010.

## 3. Enable supported operations incrementally

- Enable client emission one supported operation family at a time. Record destination
  readiness in release evidence rather than adding a negotiation endpoint.
- Never rewrite a submitted request under the same identity. Preserve exact retries
  and existing retained records when expanding capture.
- Test coordinated Arbor/Quagmire edits locally, then follow the documented release,
  exact pin and local-workspace workflow. Use real editor transactions as release gates.
- Install the previously tested Native rejected-update cleanup when the user can quit
  both apps, preserving backups and verifying opening, publication and restart. This
  remaining deployment task is separate from building new operation capture; see the
  [queue checkpoint](../../docs/source-admission-queue.md#rejected-update-retirement-september-17).

## Verification and completion

Maintain paired fixtures with identical snapshots but different move/copy/undo intent.
Assert original bases, identities and referenced material survive every durable
boundary, including uncertain acceptance and restart. Test invalid operations,
unavailable material, stale resolution and false lineage distinctly.

Update the client state-machine spec, TypeScript and Swift models, shared conformance
fixtures and reference docs for contract changes. Run focused client/ledger tests and
[development gates](../../DEVELOPMENT.md). Real Native admission plus disposable
Canopy must demonstrate R1 capture, R2 arrival, retained intent, accepted ambiguity,
continued editing and another client's guarded resolution. Record delivered slices
in status/docs and remove completed tasks here. Review caching remains deferred.
