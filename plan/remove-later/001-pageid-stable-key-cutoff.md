# Remove-later 001: Retire the PageID-shaped stable-key bridge

> **Drift check:** reconcile this plan against the active TypeScript and Swift
> locator contracts, Markdown identity codec, workspace owner indexes, private
> backlink index, deployed data roots, and current-device configuration before
> changing code. Stop if another migration has already changed any identity or
> locator representation described here.

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** the legacy bare-fragment retention window ending, a complete
  read-only data audit, and explicit operator approval to execute the cutoff
- **Progress:** WAITING — do not execute until Joe explicitly resumes it
- **Written against:** `f001bb7`

## Problem

Arbor's canonical locator contract already carries provider-neutral stable keys
through `#arbor-key=<base64url>` and `;arbor-key=<base64url>`. Markdown's
physical `id` frontmatter is nevertheless still encoded and decoded through
generic `pageIDStableKey` helpers, workspace identity indexes are named and
queried in PageID terms, and ordinary unprefixed fragments can be reinterpreted
as legacy PageID references after an owner lookup.

That bounded bridge now spreads a Markdown representation detail through core
URL parsing, directory placement, rendering, indexing, workspace resolution,
cross-tree backlinks, conformance fixtures, and the native clients. Future
identity work must understand both generic stable keys and PageID-shaped
candidates even when no compatibility behavior is wanted.

The desired end state is not deletion of document identity. Markdown files keep
their authored IDs, duplicate-ID diagnostics, ID minting, crash recovery, and
physical rename healing. The deletion target is the generic PageID codec and
the implicit conversion of ordinary content fragments into identity lookups.

## Required behavior

1. Give the Markdown representation/provider boundary one explicit identity
   codec for converting between an authored Markdown document ID and Arbor's
   canonical stable-key bytes. A likely home is
   `packages/editor/src/markdown-identity.ts`; choose a comparably literal
   provider-owned location if ownership has moved by execution time.
2. Keep `@arbor/core` provider-neutral. Remove `pageIDStableKey` and
   `pageIDFromStableKey` only after every production caller uses the Markdown
   codec or generic stable-key operations.
3. Key generic workspace owner maps, references, backlinks, and cross-tree
   resolution by canonical stable key. Keep any raw Markdown-ID lookup needed
   for physical discovery, duplicate diagnostics, minting, or recovery private
   to the Markdown/filesystem representation.
4. Replace the private backlink index's `target_page_id` representation with
   `target_stable_key`. The index is rebuildable: detect an old private schema,
   drop or migrate it deterministically, and rebuild from source rather than
   guessing at authored intent.
5. Remove `legacyStableKeyCandidate`, `legacyPageIDCandidate`, and equivalent
   Swift fields. An ordinary `#section` remains a content fragment and is never
   silently treated as identity. Explicit `#arbor-key=...` and
   `;arbor-key=...` locators continue to resolve canonically.
6. Preserve generic rename healing. A link with an explicit stable key may heal
   a stale path; removing the PageID bridge must not reduce that behavior.
7. Preserve authored Markdown byte-for-byte unless a separately authorized
   provider mutation or migration rewrites it. Do not change the frontmatter ID
   format, generate new IDs for existing documents, or rewrite links merely to
   complete this code cutoff.
8. Land the TypeScript, Swift, and shared conformance changes as one green
   compatibility tranche. Do not leave the two implementations with different
   interpretations of a bare fragment.

## Execution sequence

### 0. Prove the cutoff is safe

Before modifying source, run a read-only inventory across every active local
workspace in Arbor's private registry, the canonical hosted account tree and
all accessible hosted/current snapshots, and the configuration for other
active devices. Inventory:

- authored Markdown links containing bare fragments that could be PageIDs;
- canonical `#arbor-key=` and network `;arbor-key=` locators;
- ambiguous or unresolved legacy candidates;
- durable visit/navigation metadata that stores locators, if present;
- deployed data-root database names and the status of any pre-Canopy rollback
  copies relevant to the surrounding compatibility cutoff.

Write only a private receipt under
`~/.arbor/.state/migration/pageid-fragment-audit-<timestamp>/receipt.json`.
Include exact roots inspected, counts by locator form, ambiguous/unresolved
counts, inaccessible roots, and hashes or timestamps sufficient to repeat the
audit. Do not write source files or authored data.

If any bare PageID-shaped references remain, stop and review their exact count
and locations with Joe. He must choose between deliberately breaking them and
a separate source-preserving rewrite. Do not automatically rewrite or infer
intent. Source changes begin only after Joe explicitly confirms that the
retention window has ended and the audit coverage is sufficient.

### 1. Establish provider-owned Markdown identity

- Add the Markdown identity codec and focused round-trip/canonical-byte tests.
- Migrate wire projection, node sampling, filesystem node surfaces, directory
  projection, rendering, and indexing callers to that codec.
- Keep generic and provider-owned helpers briefly side by side only within this
  sequence; do not commit a new permanent compatibility layer.

Commit this phase independently once its focused tests, typecheck, protocol
tests, and builds are green.

### 2. Make workspace identity and backlinks generic

- Replace PageID-named workspace owner indexes with stable-key owner indexes.
- Pass stable keys end-to-end through workspace resolution, mutation refs,
  backlink queries, and cross-tree service calls.
- Retain a clearly separate representation-private Markdown ID view wherever
  filesystem discovery, duplicate diagnostics, minting, or journal recovery
  still requires the authored value.
- Rebuild the private link index using `target_stable_key` and remove
  PageID-shaped query paths.
- Prove explicit stable-key links still resolve and heal after renames,
  including cross-tree backlinks.

Commit this phase independently after the private-index rebuild and workspace
identity tests are green.

### 3. End bare-fragment compatibility in TypeScript and Swift

- Remove legacy candidate fields and translation from logical URL parsing.
- Remove legacy candidate matching from directory placement and rendering.
- Stop intercepting an ordinary local fragment as a navigation identity; leave
  it available to normal content-fragment behavior.
- Remove the legacy key from replica link-target extraction.
- Update shared conformance data and both implementations' tests in the same
  commit.

Commit this phase independently only when TypeScript and Swift agree on every
locator fixture.

### 4. Delete the bridge and close the plan

- Remove the generic PageID stable-key helpers and all stale imports.
- Remove obsolete compatibility fixtures, comments, and migration-only tests.
- Confirm remaining PageID terminology is limited to the physical Markdown
  representation and is not used by generic locator, workspace, or backlink
  APIs.
- Update this workstream index, record the audit receipt location and operator
  decision, and move the completed plan to the appropriate history workstream.

Commit the deletion and plan closure independently after the full verification
matrix is green.

## Scope

Refresh exact paths with `rg` before execution. Expected production surfaces
include:

- `packages/core/src/node-key.ts` and `packages/core/src/logical-url.ts`;
- `packages/editor/src/directory-document.ts` plus the new Markdown identity
  codec;
- `packages/wire-projection/src/projection.ts`;
- `packages/render/src/PageEditor.tsx`;
- `packages/stores/src/indexer.ts`;
- `packages/arborsync/src/workspace.ts`, `service.ts`, `node-sampling.ts`, and
  `filesystem-node-surface.ts`;
- `packages/fs/src/discovery.ts` and `workspace-fs.ts`;
- `packages/client/src/index.ts`;
- `native/Packages/ArborClient/Sources/ArborClient/LogicalURL.swift`;
- `native/Packages/ArborReplica/Sources/ArborReplica/ReplicaSemantics.swift`;
- shared conformance fixtures and focused TypeScript/Swift tests.

Out of scope: changing TreeID, NodeRef, wire-object, row-key, or Markdown
frontmatter formats; deleting physical Markdown identity; changing ID minting;
redesigning recovery journals; bulk rewriting authored links; or weakening
duplicate-ID diagnostics.

## Verification

Add explicit tests proving:

- bare `#section` remains a content fragment and never resolves as identity;
- explicit `#arbor-key=` and `;arbor-key=` locators resolve and heal stale paths;
- missing or ambiguous stable keys fail without guessing;
- duplicate Markdown IDs are still diagnosed;
- Markdown IDs still round-trip through the provider-owned codec;
- workspace rename healing and cross-tree backlinks operate on stable keys;
- rebuilding an old private backlink index produces the new stable-key schema;
- TypeScript and Swift produce identical locator results.

Run focused suites first, then the complete matrix:

```sh
bun test tests/unit/logical-url.test.ts tests/unit/directory-document.test.ts tests/unit/discovery.test.ts tests/integration/workspace.test.ts tests/integration/server.test.ts tests/integration/canopy/update-host.test.ts
bun run typecheck
bun run test:protocol
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborReplica
bun test
bun run build
bun run test:e2e
xcodebuild build -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' -derivedDataPath /tmp/arbor-pageid-macos CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/arbor-pageid-ios CODE_SIGNING_ALLOWED=NO
git diff --check
```

Compare E2E results with the baseline recorded immediately before execution;
all targeted identity and locator cases must pass, and this work may introduce
no new unrelated failures. Build macOS and iOS sequentially.

Before closure, run:

```sh
rg -n 'legacyStableKeyCandidate|legacyPageIDCandidate|pageIDStableKey|pageIDFromStableKey|target_page_id' packages native conformance tests
rg -n 'idOwners|idOwnerSets|pathPageIDs' packages/arborsync packages/fs
```

The first search must have no production compatibility callers. The second may
retain only deliberately renamed, representation-private Markdown identity
state; generic workspace ownership must be expressed in stable-key terms.

## Done criteria

- [ ] A complete private audit receipt records every inspected local, hosted,
  and device-relevant data source and Joe's explicit cutoff decision.
- [ ] Markdown owns the only PageID-to-stable-key codec; generic core does not.
- [ ] Generic workspace ownership, refs, indexes, and backlinks use stable keys.
- [ ] Bare fragments are content fragments in TypeScript and Swift.
- [ ] Canonical explicit-key resolution and rename healing remain intact.
- [ ] Physical Markdown IDs, minting, duplicate diagnostics, and recovery remain
  intact and representation-private.
- [ ] No authored data was rewritten without a separate explicit decision.
- [ ] Each phase has a focused commit and the full verification matrix is green.

## STOP conditions

- The audit finds bare PageID-shaped references and Joe has not chosen how to
  handle them.
- The canonical hosted snapshot, an active device configuration, or a deployed
  data root cannot be inspected well enough to establish coverage.
- Preserving rename healing or backlinks appears to require an authored-data
  rewrite rather than generic stable-key ownership.
- Work begins changing frontmatter ID, TreeID, NodeRef, wire-object, row-key,
  minting, or recovery-journal formats.
- An ambiguous fragment would be resolved by guessing.
- TypeScript and Swift cannot land with one locator contract.
- In-scope identity code has materially drifted from `f001bb7`; reconcile and
  revise the plan before continuing.
- The implementation deletes owner behavior instead of moving it behind the
  provider-neutral stable-key boundary.
