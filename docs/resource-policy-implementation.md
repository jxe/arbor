# Resource policy implementation checkpoint

[Apps 004](../plans/apps/004-mutation-permissions.md) is deployed on schema 13.
The September 18 cutover (migration 011, deleted after cutover; see git history)
converted the accepted and local configuration and installed matching Mac/iPhone
clients. Runtime provider integration and the remaining interactive/soak gates below
are still open.

## Implemented boundary

- Shared `ResourceAccessRule` grammar (`who`, `via`, `allow`, `within`), scope and
  operation evaluation, canonical rule identity and safe link redaction. TS and
  Swift consume `conformance/resource-policy.json`.
- New resource configuration parser, non-hosting entries, and legacy retained-root
  readers. Existing hosting consumers receive a deliberately restricted whole-tree
  projection while full policy remains in `resources` and exact authored sources.
- Governed configuration checks administrator authority over full policy, persists
  the resource index in the accepted transaction, and rejects legacy privilege
  rewrites after conversion. Non-owner delegation is bounded by current underlying
  access without recursive self-authorization. Public/direct access works through
  code; an author's private authority requires a matching caller/code rule.
- Host-private execution tokens with pinned code/version and capability provenance,
  per-request async context isolation, expiration, explicit revocation and current
  policy checks. `ExecutionAuthority.issue` is trusted host infrastructure, not a
  public mint endpoint. Its `active` callback must bind current session and activation;
  Apps 005 supplies that host integration. Tokens are process-local and invalidated
  on restart; durable update identity survives independently.
- Execution-token HTTP authentication, whole-tree read/watch checks, exact guarded
  snapshot updates, per-effect validation and atomic commit reauthorization. Narrow
  direct updates use the same validator without pretending to be an executable.
  Receipts recheck effects/authority; stale guards reveal no reconciliation graph to
  a caller lacking whole-tree read. Device credentials retain existing ordinary APIs.
- Internal `GET /.arbor/execution/authority-watch` authenticates an execution token
  and sends `refresh` or `revoked` SSE events with empty payloads. It conservatively
  invalidates on accepted updates; explicit revocation notifies immediately and
  expiry/session changes are polled. Providers must refresh authority after disconnect.
- CLI hosting edits preserve scoped/code rules; `--clear-access` intentionally removes
  all rules. Cross-account rehome of resource policy fails before mutation pending
  an explicitly reviewed policy-transfer contract. `GET /access` retains the legacy `snapshot` projection and adds safe
  `policy` for the authenticated account's new rules. TS and Swift expose this
  additive reference API response; legacy whole-tree consumers may continue reading
  `snapshot`, while rule-aware consumers read `policy`.
- Native sharing preserves granular, scoped and executable rules and policy-only
  entries. Its app-permissions screen reviews caller, executable, resource, scope,
  operations and the replaced rule before changing configuration. Exact source and
  current administrator checks reject stale reviews; iOS also guards the accepted
  configuration update. Link digests are never displayed. Native YAML edits reject
  aliases, duplicate keys and unsupported fields rather than silently dropping them.
- Concurrent policy edits install their restrictive intersection in the accepted
  transaction, retaining complete alternatives as a root conflict. Removal wins
  concurrent expansion for non-hosting entries. The index, accepted root and
  conflict survive restart together. A pending policy conflict locks further
  configuration edits until an administrator resolves all current alternatives
  against the exact current update; keeping the restrictive projection is valid.
  Canonical-hosting/account/device conflicts retain their existing rejection rules.
  Legacy-only merges do not implicitly convert the configuration. A durable
  account format marker prevents old privilege writes after all new rules have
  been removed; Migration 011 also sets it for all-private/empty configurations.

## Supported scoped update subset

One exact-guarded snapshot candidate is accepted per execution request. New ordinary
files/directories require create-child at the logical parent; changing raw file
content requires update-content; deletion of a file requires delete. Markdown
replacement conservatively requires write because it can change frontmatter.
Directory deletion/retyping, reserved representations/schema, and opaque child-store
changes require write. All logical scopes stop at TreeIDs; existing reserved-boundary
validation also runs. Newly created scoped directories cannot conceal nested trees or
opaque stores. The graph validator has explicit depth/work limits.

Executable operation-bearing updates, explicit conflict resolutions, updates to
already-conflicted trees, scoped object/snapshot/watch projections, and granular
property/store effects are not implemented: they fail closed, never widen to write.
Whole-tree read remains required for existing read/inspection/watch transports.
Snapshot creation currently needs a caller-supplied candidate; blind create-only
construction through an operation API remains future work.
Apps 005/006 may add provider-specific exact enforcement independently.

## Remaining integration and observation

Exercise Native consent/revocation and configuration conflict resolution on the
isolated production copy, including queued configuration writes. Provider-specific
operations, source resolution, activation consent prompts and hostile cross-tree
JS isolation remain Apps 005/006 work. No SQLite connection is made safe merely by
possessing a token. The coordinated live schema/configuration/client migration is
complete; retain its backups and keep Apps 004 active through observation and soak.

## Verification evidence

Checked with repository-required Bun 1.3.14 (the machine default Bun canary crashed
in parallel tests). TypeScript checking and CLI build pass. Shared protocol checking
passes with the documented local Quagmire editable override, including ArborWire,
ArborSyncClient, ArborKit, CanopyClient, ArborWorkingTree and live admission tests.
Migration 011 has three passing synthetic tests. Added tests cover restrictive
acceptance/restart/exact resolution, policy-only deletion and re-addition, metadata
privacy, Native consent/review/edit preservation, and legacy-only merge stability.
The local-workspace macOS and generic iOS app builds succeed without signing,
installation or launch.

The broad product suite retains a reproducible baseline failure in
`plural-account CLI place > places an existing private tree through its matching account`.
It reproduces in an untouched archive of starting commit `2416713` with Bun 1.3.14.
No placement or source-recovery fix is included in this permission change.

Intermediate broad runs also hit source-operation and daemon-start timeouts. The two
source-operation tests passed in a focused rerun (including the 80-update history).
Final product run: **1,006 passed, one baseline CLI placement failure** across
1,007 tests. Typechecking and CLI build pass. The focused authority/config suite
passes (31 tests), as do the additional default-scope merge regression, CLI grant
preservation regression, Migration 011 (3 tests), and Native configuration/consent
suite (16 tests). Repository-wide relative-link checking reports the same 34
pre-existing/example targets as the starting checkout, with no new missing links;
`git diff --check` passes.
