# Smaller project 006: Attribute accepted updates and show line provenance

> **Executor instructions:** Read this plan completely before editing. Preserve
> unrelated working-tree changes. Run each verification gate before moving on,
> and stop rather than weakening identity, authorization, retention, or source
> fidelity when a STOP condition applies.
>
> **Drift check:** This plan was written from commit `0ea0f31` plus the
> uncommitted plural-update work visible on 2026-09-05. Before implementation,
> run:
>
> ```sh
> git diff --stat 0ea0f31..HEAD -- \
>   packages/canopy packages/wire packages/arborsync \
>   native/Packages/ArborWire native/Packages/ArborSync native/Packages/ArborKit \
>   native/ArborApp spec conformance tests migrations plans/canopy-storage
> git status --short -- \
>   packages/canopy packages/wire packages/arborsync \
>   native/Packages/ArborWire native/Packages/ArborSync native/Packages/ArborKit \
>   native/ArborApp spec conformance tests migrations plans/canopy-storage
> ```
>
> Reconcile any changes to accepted-update shapes, schema version, update
> batching, history retention, or client source/history APIs against this plan.
> A semantic mismatch is a STOP condition, not permission to restore old code.

## Status

- **Priority:** P2
- **Effort:** XL
- **Risk:** HIGH — this adds durable identity metadata, a Canopy schema
  migration, bounded access to private history, and cross-language protocol
  surface
- **State:** PLANNED
- **Depends on:** no implementation milestone; coordinate retention with
  [Canopy storage 001](../canopy-storage/001-pack-object-storage.md), which must
  not prune history required by this feature without an equivalent checkpoint
- **Planned at:** `0ea0f31`, 2026-09-05

## Target result

For the exact current UTF-8 Markdown source of a synchronized document, an
authorized reader can ask who introduced each current line. Arbor returns
ordered, complete line spans naming the accepted update, acceptance time, and
safe actor associated with that update. The first product presentation lives
in the native **Source and Properties** inspector as an optional read-only
line-provenance view; the Local Arbor REST API remains independently usable by
other clients.

The feature is analogous to `git blame`, but its claims remain narrower and
literal:

- it reports which accepted update first introduced the current exact line;
- for an authenticated device write, it reports the permanent person Profile
  TreeID bound to that device's account when Canopy accepted the update;
- it says **submitted by**, not **authored by** or **signed by**, because paired
  device credentials, not the profile private key, submit ordinary updates;
- automatic merging does not reattribute unchanged accepted lines to the
  device whose candidate triggered the merge;
- public, access-link, system, and un-attributable legacy updates remain
  explicitly distinguishable without exposing credentials or digests; and
- it exposes no deleted source, rejected candidates, conflict drafts, generic
  historical snapshot, or accepted-history listing.

This is current-line provenance, not a general revision browser.

## Current state

Canopy already has the content lineage needed for a derived blame calculation:

- `packages/canopy/src/updates/store.ts` records a private linear accepted
  history with `previous_root`, `root`, `accepted_at`, credential-scoped
  `subject`, merge provenance, request digest, and transition payload.
- `packages/canopy/src/objects.ts` stores immutable hash-verified Wire file and
  directory objects and can materialize complete retained snapshots.
- `packages/canopy/src/updates/transition.ts` builds one exact transition for
  each accepted root without folding history.
- `packages/wire/src/objects.ts` represents a file as exact bytes, so Markdown
  source and its LF, CRLF, or CR line endings remain available for comparison.
- `packages/canopy/src/updates/merge.ts` correlates uniquely identified
  Markdown pages across moves and renames and the additive Markdown merge works
  on exact source lines.
- `spec/02-directory-format.md` defines a materialized Markdown document's
  stable `id` and requires it to survive rename and move.

The missing foundation is immutable profile attribution. HTTP bearer
authentication resolves a credential to `device:<DeviceID>` and an account in
`packages/canopy/src/accounts.ts`; `packages/canopy/src/access.ts` authorizes
that account through its current `profileTree`; but accepted history stores
only the device subject. The current relation
`accepted update -> device -> account -> profile_tree` can be reconstructed
while those rows retain their original meaning, but the accepted row itself
does not freeze the Profile TreeID used at acceptance.

History is deliberately private. `packages/canopy/README.md`,
`spec/01-tree-operations.md`, and `plans/_done/native/overview.md` reject a
generic accepted-history collection. Keep that decision: compute provenance
inside Canopy and return only metadata for lines that exist in the currently
readable source.

The native app already has `ArborSourceInspector` in
`native/ArborApp/ArborDailyDriverViews.swift`. `ArborKit` has local recovery
history, but that is not Canopy accepted history and must not be relabeled as
shared line provenance.

## Contract to freeze first

Add a language-neutral line-provenance contract to
`spec/01-tree-operations.md` and its authorization rule to
`spec/05-access-control.md` before implementing routes. Use these semantics:

```ts
type LineProvenanceActor =
  | { kind: "profile"; tree: TreeID }
  | { kind: "public" }
  | { kind: "access-link" }
  | { kind: "system" }
  | { kind: "unknown" };

type LineProvenanceSpan = {
  startLine: number; // one-based, inclusive
  endLine: number;   // one-based, inclusive
  update: string;
  acceptedAt: number;
  actor: LineProvenanceActor;
};

type LineProvenance = {
  tree: TreeID;
  path: LogicalPath;
  stableKey: string | null;
  root: Hash;
  update: string;
  contentHash: Hash;
  continuity: "stable-key" | "path";
  spans: LineProvenanceSpan[];
};
```

The portable `AcceptedUpdate` shape must replace its current raw `subject`
field with this safe `actor`. Keep the credential-scoped subject only in
private Canopy storage. This is a coordinated protocol change: update the
TypeScript and Swift models, language-neutral fixtures, documentation, and
focused tests together rather than letting line provenance become a second
inconsistent interpretation of accepted-update identity.

`spans` is ordered, non-overlapping, coalesces adjacent lines with identical
metadata, and covers every exact current source line once. An empty source has
an empty span list. Line tokenization retains each original line ending; the
last unterminated line is still one line. `contentHash` identifies the exact
Wire file object used for the result.

`continuity: "stable-key"` means every historical lookup used the document's
unique stable Markdown `id`. `"path"` means the current path was the only
identity available; a rename or ambiguous/missing historical ID ends the walk
and the first state at the current path becomes the provenance boundary. Never
claim rename continuity from title similarity or content similarity.

The remote request must name the currently displayed accepted update. Use a
read-only route shaped consistently with existing Wire tree routes:

```text
GET /.arbor/trees/{TreeID}/blame?path={logical-path}&at={accepted-update-id}
```

Canopy returns `409 stale-update` with the safe current update ID when `at` is
not current. It returns a typed unsupported/too-large error for non-Markdown,
invalid UTF-8, or work exceeding explicit history/source limits; it never
returns a partial result that looks complete. Authorization is the same
current read check as the tree and current snapshot routes.

Expose the same result through a Local Arbor REST endpoint using the existing
complete `NodeRef` query convention. Arbor Sync forwards only for a clean
synchronized document whose displayed content matches the named accepted
update. A document with pending local work reports provenance as temporarily
unavailable rather than labeling unsynchronized lines with stale actors.

## Storage design

Keep replay identity and attribution separate. `accepted_updates.subject`
continues to scope request replay; do not parse it at read time to decide the
actor. Add immutable columns:

```text
actor_kind          profile | public | access-link | system | unknown
actor_profile_tree  nullable TreeID; present exactly for actor_kind=profile
```

The accepted-update commit path derives these values from the authorization
context that already passed `canWrite`, not from caller JSON:

- authenticated account device: `profile` plus the account's Profile TreeID;
- access-link write: `access-link`, with no secret or digest copied;
- unauthenticated public write: `public`;
- Canopy-owned bootstrap or maintenance transition: `system`;
- legacy state that cannot be proven: `unknown`.

An initiating profile remains the actor for synchronous derived accepted
updates, such as a parent boundary rewrite committed by the same governed
configuration update. Store the device subject separately for operational
audit/replay, but never return DeviceID, account ID, bearer digest, link digest,
or request digest as line attribution. Do not store the ACL rule or group path
that happened to authorize the request; blame answers who submitted the
accepted change, not why that subject had permission.

`subject` is currently present on the portable `AcceptedUpdate` returned in
update results and watch transitions. Remove it from that public shape when
adding `actor`; otherwise an access-link writer's private digest or a device ID
could be mistaken for safe attribution. Compatibility, TypeScript, Swift, and
fixture changes must land atomically with the server change.

Increment the Canopy schema version and create the next available disposable
migration directory under `migrations/` following
`migrations/001-if-match-and-model-hash/` and `migrations/README.md`. At the
time this plan was written the next number was `005`; if that number has been
used, take the next available number and update this plan/index before work.
The migration must:

1. operate only on an exact supported source schema;
2. add and validate the two actor columns;
3. backfill `device:<id>` by joining the retained device to its account and
   copying that account's Profile TreeID;
4. backfill `account:<id>`, `public`, and access-link subjects to their safe
   actor kinds without retaining a link digest in the actor columns;
5. mark null, malformed, missing-device, or otherwise unprovable history as
   `unknown` rather than guessing;
6. report only counts by actor kind—never TreeIDs, device IDs, digests, paths,
   roots, or content;
7. preserve every tree ref, accepted update ID/order/root, observation,
   request digest, transition, account, device, ACL, and object byte exactly;
   and
8. be rehearsed on copies and require separate operator authorization before
   any live deployment or migration.

Do not make Canopy startup silently migrate a stored database.

## Blame algorithm

Implement the pure engine separately from HTTP in a new focused Canopy module,
then wrap it with storage lookups.

1. Resolve the current logical Markdown body and exact file-object hash at the
   requested accepted root. Capture its unique stable `id` when present.
2. Tokenize exact source into lines including original terminators. Initialize
   every current line to the current accepted update.
3. Walk accepted updates backward. Resolve the predecessor body by the same
   unique stable ID; if no stable ID exists, use the same logical path only.
4. Match unchanged exact line tokens between the later and predecessor source.
   Carry matched lines backward; freeze new or changed lines at the later
   update. Coalesce spans only after attribution is complete.
5. Use deterministic occurrence-aware matching for duplicate lines. When more
   than one valid match remains, prefer the newer attribution rather than
   claiming an older origin that cannot be proven.
6. A merge is compared first with its immediately previous accepted root.
   Existing accepted lines therefore keep walking backward while lines
   introduced by the submitted candidate stop at the merged update. Use stored
   base/candidate/remote roots in tests to prove this behavior; do not assign
   every merged line to the triggering device.
7. A restore ordinarily attributes reintroduced lines to the restoring update,
   because they were absent from its immediate predecessor. Do not add
   copy-detection or search all deleted history in this version.
8. Stop honestly at initial, pruned, corrupt, ambiguous-identity, or explicit
   history boundaries. Initial and migrated `unknown` actors remain visible as
   unknown.

Do not reuse the merge rule's quadratic LCS table for unbounded source. Use a
bounded-memory deterministic line matcher, set explicit maximum source bytes,
line count, history rows, and work units, and return a typed error when the
request exceeds them. Measure before selecting final limits. Add a private,
rebuildable cache keyed by `(tree, current update, stable key or path,
contentHash)` only if the measured repeated-request cost justifies it. Cache
construction must not delay accepted-update acknowledgement.

The blame calculation needs retained accepted roots and their reachable
objects, not an indefinitely retained copy of every sparse transition payload.
Watch/replay may keep its independently promised transition window. Do not
couple blame correctness to transition JSON after that window.

## Retention and movement boundaries

Until a blame checkpoint format is implemented, every accepted root and object
needed by supported provenance remains retained. Packing may change physical
representation but not actor metadata, roots, update order, or reconstructable
source. Canopy storage 001 must treat blame-required roots as retained roots;
it may not silently shorten provenance to meet a storage target.

Do not invent cross-Canopy federation in this plan. A future cross-Canopy tree
move must either transfer the verified accepted history and actor metadata or
record a verifiable predecessor boundary that a later authorized provenance
request can follow. If the move instead restarts history, the UI must display
that explicit boundary. Update the move design before implementing such moves;
do not infer lineage merely because the destination reuses a TreeID and root.

## Scope and git workflow

Expected implementation scope:

- `packages/canopy/src/model.ts`, `schema.ts`, `accounts.ts`, `canopy.ts`,
  `host.ts`, `updates/store.ts`, and one focused new provenance module;
- `packages/wire/src/` models, strict JSON decoding, exports, and client;
- `packages/arborsync/src/service.ts` and `server.ts`, plus `packages/client`;
- `native/Packages/ArborWire`, `ArborSync`, and `ArborKit` models, clients, and
  focused tests;
- `native/ArborApp/ArborAppModel.swift`, `ArborRootView.swift`, and
  `ArborDailyDriverViews.swift` for the first visible presentation;
- `spec/01-tree-operations.md`, `spec/05-access-control.md`, conformance
  fixtures, reference implementation documentation, and focused Bun/Swift
  tests; and
- the next disposable `migrations/NNN-accepted-update-actors/` directory and
  its lifecycle test/runbook.

Out of scope even if it looks adjacent:

- changing object hashes, canonical CBOR, root identity, update ordering,
  merge acceptance, or request-digest replay;
- a general history/snapshot API, historical editing, or remote restore;
- database-row, generated-result, binary, arbitrary-text, or copy provenance;
- profile-key signing of every device update, profile succession/recovery, or
  cross-Canopy history federation; and
- implementing Canopy storage 001's pack format as part of this feature.

Use branch `codex/line-provenance` unless the operator supplies another name.
Make focused commits for the contract/schema, migration, blame engine, protocol
clients, and visible native slice; match the repository's imperative commit
style. Do not push, deploy, migrate live data, stop/restart Arbor, or launch an
app unless Joe separately authorizes that action.

## Implementation order

### Phase 1 — actor schema and accepted-row invariants

1. Add internal actor types and actor columns in
   `packages/canopy/src/model.ts`, `schema.ts`, and `updates/store.ts`.
2. Thread a server-derived actor through every accepted-update insertion in
   `packages/canopy/src/canopy.ts`, including activation, configuration,
   canonical boundary changes, bootstrap, restore, and test helpers.
3. Keep `subject` as private credential-scoped replay identity. Add invariant
   checks rejecting a profile actor without a valid person Profile TreeID or a
   non-profile actor carrying one.
4. Add the disposable schema migration and exact before/after verification.

**Verify:**

```sh
bun test tests/unit/canopy/update-store.test.ts tests/unit/canopy/schema-migration.test.ts tests/integration/canopy/update-host.test.ts
bun run test:migration migrations/*-accepted-update-actors
```

Expected: all focused tests pass; migration comparison reports unchanged roots,
accepted IDs/order, observations, transitions, objects, accounts, devices, and
ACLs, with only the schema stamp and actor columns changed.

### Phase 2 — pure current-line provenance engine

1. Add the pure exact-line matcher and span builder under
   `packages/canopy/src/`, with no HTTP, account lookup, or UI dependency.
2. Add snapshot/document resolution that follows a unique Markdown stable ID
   across rename/move and same-path continuity otherwise.
3. Cover direct edits, insert/delete/replace, repeated lines, blank lines,
   final unterminated lines, LF/CRLF/CR, frontmatter, rename/move, missing and
   duplicate IDs, merge, restore, initial state, and unknown legacy actors.
4. Add bounded-work and corruption tests. Measure a representative long
   document and long accepted history before freezing limits.

**Verify:**

```sh
bun test tests/unit/canopy/line-provenance.test.ts tests/unit/canopy/update-merge.test.ts
bun run test:performance
```

Expected: every fixture's spans cover its current exact lines once; ambiguous
duplicates stay newer; existing merge lines retain their earlier actor; limits
fail with typed errors rather than high memory growth or partial results.

### Phase 3 — Wire and Local Arbor REST surfaces

1. Add TypeScript request/response models and strict decoders in `@arbor/wire`.
   Remove raw `subject` from portable `AcceptedUpdate` and add the safe `actor`
   in the same cross-language change; retain the database subject privately.
2. Add the authenticated current-only Canopy route in
   `packages/canopy/src/host.ts` and a focused daemon method in `canopy.ts`.
3. Add `WireClient` support, then route the complete `NodeRef` through
   `packages/arborsync/src/service.ts`, `server.ts`, and `@arbor/client`.
4. Add matching Swift models and methods in `ArborWire`, `ArborSync`, and
   `ArborKit`; do not make local recovery history pretend to be server blame.
5. Update TypeScript/Swift language-neutral fixtures, reference API docs, and
   focused protocol tests in the same change, as required for every protocol
   change.

**Verify:**

```sh
bun run typecheck
bun test tests/integration/canopy/update-host.test.ts tests/integration/self-sync.test.ts
bun run test:protocol
swift test --package-path native/Packages/ArborClient
```

Expected: TypeScript and Swift decode identical fixtures; current authorized
Markdown succeeds; stale, unreadable, pending-local, binary, oversized, and
unsupported requests fail with the specified typed result; no route enumerates
history or returns non-current source.

### Phase 4 — native visible behavior

1. Extend the native source-inspection model without changing the editable
   document session or local recovery API.
2. Add an optional **Line provenance** view to `ArborSourceInspector`. Render
   exact source in a monospaced line list with a compact gutter that groups
   adjacent spans and shows the current resolved profile label when available,
   its stable Profile TreeID, and acceptance time.
3. Label non-profile actors literally: **Public**, **Access link**, **System**,
   or **Unknown**. Label pending local work **Available after changes sync**.
4. Profile labels are presentation resolved from the returned stable TreeID;
   changing a display name must not rewrite stored attribution.
5. Add accessibility labels that read line number, submitter, and date without
   reading the gutter as unrelated duplicate content.

**Verify:**

```sh
swift test --package-path native/Packages/ArborWire
swift test --package-path native/Packages/ArborSync
swift test --package-path native/Packages/ArborKit
xcodebuild build -project native/Arbor.xcodeproj -scheme Arbor \
  -destination 'platform=macOS' \
  -derivedDataPath /tmp/arbor-line-provenance-macos CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -project native/Arbor.xcodeproj -scheme Arbor \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/arbor-line-provenance-ios CODE_SIGNING_ALLOWED=NO
```

Expected: all package tests and builds exit zero; a real two-device sequence
shows the correct profile per line after synchronization; merge-preserved lines
keep the earlier profile; pending local edits never show stale provenance as
current. Leave final hands-on visual acceptance to Joe.

### Phase 5 — documentation, retention coordination, and migration handoff

1. Update `status.md` only after the feature is implemented and tested.
2. Update `packages/canopy/README.md`, `docs/arborsync-api.md`, and
   `docs/reference-implementation.md` with the implemented current-only
   boundary.
3. Amend Canopy storage 001 so pruning either preserves blame-required roots or
   first lands a separately reviewed checkpoint design.
4. Prepare and rehearse the disposable migration, but stop before live backup,
   deployment, migration, app launch, or process control for Joe's explicit
   authorization.

## Test plan

Use `tests/unit/canopy/update-store.test.ts` for accepted-row transaction
structure, `tests/integration/canopy/update-host.test.ts` for authorization and
route behavior, and the shared merge fixtures for source/merge cases. Add at
least these assertions:

- two devices under different profile accounts introduce alternating lines;
- two devices under one profile report the same profile but remain distinct
  private replay subjects;
- revoking a device does not erase or change historical attribution;
- direct profile access and group-derived access record the submitting profile,
  not the grant or group profile;
- public and access-link writes reveal no token, DeviceID, account ID, or link
  digest;
- an accepted merge attributes only newly introduced lines to its submitter;
- rename/move follows a unique stable ID, while path-only continuity ends
  honestly;
- repeated identical lines never receive an unprovable older attribution;
- initial and unprovable migrated updates display `unknown` rather than a
  guessed actor;
- current read revocation removes blame access immediately;
- a stale `at` update, pending local edit, binary body, invalid UTF-8, oversized
  body/history, and missing object all fail closed; and
- the API never enumerates updates, returns deleted lines, or makes a retained
  non-current object generically readable.

## Repository gates

After focused development tests, run the maintained gates from
`DEVELOPMENT.md`:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:e2e
bun run test:performance
swift test --package-path native/Packages/ArborClient
git diff --check
```

Expected: every command exits zero. Also run the repository-wide relative-link
check required for documentation changes and the focused migration suite while
the migration exists.

## Done criteria

- [ ] Every new accepted update stores an immutable, server-derived safe actor.
- [ ] Existing provable device/account history is migrated without changing
  roots, accepted IDs/order, observations, transition payloads, or object bytes.
- [ ] Current exact Markdown lines receive deterministic, complete provenance
  across ordinary edits, merges, and stable-ID moves/renames.
- [ ] The Wire and Local Arbor REST APIs are current-only, read-authorized,
  stale-safe, bounded, and cross-language conformant.
- [ ] No provenance or accepted-update response exposes device/account
  identity, credentials, link digests, request digests, deleted source,
  rejected candidates, or generic history; portable updates carry only their
  safe actor.
- [ ] Native Source and Properties presents the result accessibly and refuses
  stale provenance while local work is pending.
- [ ] Canopy storage retention cannot prune required provenance without an
  explicitly equivalent checkpoint design.
- [ ] The disposable migration is rehearsed and awaits separate authorization
  before touching live state.
- [ ] Focused tests, maintained repository gates, the relative-link audit, and
  `git diff --check` pass.

## STOP conditions

Stop and report rather than improvising if:

- the accepted-update model is no longer a complete linear chain of retained
  roots, or current code has introduced a revision DAG;
- the schema version or next migration number differs from this plan and no
  exact supported migration source can be identified;
- profile attribution would have to trust a caller-supplied TreeID instead of
  the authenticated account state at acceptance;
- migration backfill would guess across a missing/reused DeviceID or changed
  account/profile binding;
- the only implementation requires exposing accepted-history enumeration,
  non-current source, device IDs, account IDs, credentials, or link digests;
- bounded exact-line matching cannot distinguish duplicate-line ancestry and
  would claim an older actor without proof;
- a cross-Canopy move has already begun restarting history without an explicit
  predecessor/boundary design;
- implementation requires accepted-update acknowledgement to wait for blame
  computation or cache construction; or
- a focused verification fails twice or work expands into a generic history,
  diff, storage-plugin, or federation framework.

## Deliberate absences and maintenance notes

- No Git commit object, branch, revision DAG, per-line canonical metadata, or
  profile signature on every update.
- No attribution of rejected candidates, pending local generations, database
  rows, generated query results, binary files, or arbitrary ordinary text in
  the first version.
- No copy detection across unrelated documents or deleted history.
- No generic accepted-history browser or restoration from Canopy history.
- No promise that a submitting profile was the human who typed a line; the
  record identifies the profile account whose device submitted the accepted
  change.
- Review future packing, pruning, account recovery, profile succession,
  cross-Canopy movement, mutation execution, and agent execution changes
  against the actor and continuity invariants in this plan.
