# Build plan
*Forward roadmap for Arbor and the reference implementation. Delivered work and evidence live in [history](history/outcomes.md); the [native history](history/native/overview.md) records Arbor, Hunch conversion, Quagmire integration, offline replicas, and Canopy-backed synchronization.*

## Status at a glance

The local daily driver and the reference community-hosting foundation are implemented. Arbor can browse and edit the local filesystem, promote ordinary folders into canonical Arbor trees, host person and group profiles, claim reserved profiles, synchronize placements, and apply whole-tree access through the browser and CLI.

Workspace composition is now implemented. The roadmap now begins with one vertical live-data document milestone, using the Supplies port to design and prove data, named handles, components, Arbor users, and Canopy-hosted streaming together rather than committing the data API in isolation.

| Status | Milestone | Outcome |
|---|---|---|
| **Implemented** | 1. Workspace composition | Distinct trees mount in a reader-local layout; visits and merged surfaces preserve provenance. |
| **Next** | 2. Live data documents | Portable relational data, colocated queries/mutations/components, Arbor users, efficient subscriptions, and one Canopy-hosted Supplies site. |
| **Planned** | 3. Canopy-hosted agents | File-defined conversational interfaces over the same compiled query/mutation handles and Arbor users as live React documents. |
| **Planned** | 4. Portable deployment | Static baking and additional live adapters over the location/handle manifest proven in Milestone 2. |
| **Later** | 5. Account lifecycle and hosting administration | Pairing, identity switching/recovery UX, disputes, and production operational tooling. |

Milestone numbers express product priority, not a claim that every implementation task is serial. Milestone 2 is now the checked-in [`sites/supplies`](../sites/supplies) vertical slice: implement only what makes that unchanged tree run in local Arbor web, signed macOS Arbor, and its canonical Canopy website, then migrate the real Meaning Supplies corpus. The site, rather than a synthetic framework demo or a backing matrix, freezes the relational authoring surface, location model, collection contract, and observation behavior. Canopy-hosted agents follow and reuse the same compiled query/mutation handles as a conversational alternative to the React documents. Additional backing/deployment adapters follow only when a concrete second target needs them.

A separate [external-agent CLI access plan](interfaces/001-external-agent-access.md) lets installed agents such as Codex or Claude Code work with a person's Arbor workspace through a reusable skill and structured CLI. That work does not implement authored or Canopy-hosted Arbor agents and may proceed independently as the relevant CLI operations become available.

```text
implemented local + community-hosting foundation + workspace composition
   ├── external-agent CLI access
   └── live data documents (Supplies) ── Canopy-hosted agents ── portable deployment

account lifecycle, hosting administration, and hardening follow
without blocking those forward product capabilities
```

## Baseline and contract sources

The local daily driver, community hosting foundation, and workspace composition
milestone are complete. Their behavior, ownership, limits, and verification
evidence live in [history](history/outcomes.md); this forward roadmap does not
repeat their executor instructions.

Durable product contracts live in the topic specifications:

- the [data model](../spec/01-data-model.md) owns the global TreeID space,
  partial availability, trees, nodes, identities, properties, content, children,
  derived references/relationships, the secondary canonical URL index,
  structured-data interpretation, and equivalence;
- [directory projection](../spec/02-directory-format.md) and
  [locators](../spec/03-locators.md) own exact filesystem/Markdown source,
  `_index.md`, frontmatter, child placement, tree-relative references,
  canonical names, raw TreeID fallback, schema-stable keys, application-query
  separation, content fragments, and immutable revision selection;
- [Wire and community hosting](../spec/04-wire.md) owns remote model sampling,
  exact projection objects, canonical boundaries, promotion, profiles, claims,
  access, refs, updates, watch/retry/resync, query/mutate transport, secrets, and
  HTTP projection;
- [configuration](../spec/05-configuration.md) owns synchronized account, tree, device, placement, ACL, and governance data;
- [stores](../spec/06-stores.md), [executable documents](../spec/07-executable-documents.md), and [agents](../spec/08-agents.md) own their respective authored contracts;
- the [reference documentation](../docs/reference-implementation.md) owns the Local Arbor REST API, CLI, data home, client interaction design, runtime algorithms, and platform behavior.

## Milestone 2 — live data documents

**Status: Next.**

Phase 1, the headless Supplies SQLite query engine, was implemented on 2026-08-26. Phase 2, race-free query-result streaming over the shared Local/Wire contract, and Phase 3, the transactional mutation runner with durable retry receipts, were implemented on 2026-08-27. Phase 4, compilation and development typechecking, is next; the milestone remains incomplete until every surface and the real-data migration pass the gate below.

Outcome: the checked-in Supplies tree is the first complete executable Arbor site—SQLite-backed, live, editable, Arbor-user-aware, locally browsable, native-presented, Canopy-hosted, and finally populated from the real service.

1. Build the SQLite query engine against every checked-in Supplies callable query plan, including schema/result type inference, named relationship metadata, and profile-tree joins. Support `query.many`/`one`/`maybe`, `pick`, callable relations, typed predicates and counts, omitted no-input schemas, inferred stable keys, and automatic deterministic tie-breakers. Keep query returns factual; calculate editability and other presentation state in React with `useUser()`.
2. Add race-free query-result streaming from committed SQLite/profile changes with semantic sensitivity, snapshot-then-follow, output hashing, and one self-contained stateless SSE request for the mounted query graph.
3. Add the mutation runner with Standard Schema inputs, injected Arbor users, a default transaction exposed as `tx`, in-transaction authorization, retry-stable IDs/time/receipts, ordered relation primitives, and post-commit change publication.
4. Add MDX/TSX compilation and development typechecking, server/client extraction, literal Arbor path/schema resolution, provider-neutral node-source handles, Standard Schema-derived handle types, generated `NodeOf`/`RowOf`/`ResultOf` declarations, zero-import Tailwind, manifests, watch diagnostics, and `arbor check`. Adapt the completed SQLite relation engine as one capability provider for the generic query algebra rather than freezing database relations as the public node model.
5. Make the components run first in local `arbor open` and then through the same SSR/hydration/Action/stream stack at ordinary Canopy HTTP paths after explicit tree activation.
6. Present the same local runtime in signed macOS Arbor through a constrained native web surface while preserving native tab/location/provenance and source controls.
7. Add the deterministic fixture, import the real Postgres corpus into SQLite with reviewed legacy-ID/ProfileID mapping, stage side by side, and cut over with redirects, backups, and rollback.

SQLite is the one required backing for this milestone. The portable contract must leave room for Postgres, but implementing and operating two database compilers before Supplies works is no longer a gate. The first correctness strategy remains dependency-directed reruns, output hashing, and complete replacement results; keyed transport diffs and incremental maintenance follow only if measurement requires them.

Completion gate: the unchanged `sites/supplies` source runs in local Arbor web, signed macOS Arbor, and its canonical Canopy website; two clients update without refresh after related mutations and profile edits; unrelated precise changes avoid reruns; reconnects cannot leave stale results; raw private data stays private; every person-valued row uses a stable Arbor ProfileID; and the verified real-data migration can cut over with stable redirects and rollback. The remaining implementation plan is [Application 001](applications/001-supplies-executable-site.md).

## Milestone 3 — Canopy-hosted agents

**Status: Planned. Depends on the compiled handles, Arbor users, and Canopy-hosted execution available after Milestone 2.**

Outcome: a Markdown-defined agent at an ordinary Arbor location gives visitors a conversational interface to the same live application data exposed through React documents.

- Compile agent Markdown into a versioned manifest of its prompt, context query handles, mutation tools, transcript destination, model policy, and inferred data access.
- Host the conversation on Canopy that already owns the executable documents, private backing trees, handle runner, and authenticated Arbor-user context.
- Present a generic agent conversation at the document's ordinary local and canonical HTTP location; authored applications do not ship a separate chat UI or model client.
- Invoke only declared compiled handles with their existing validation, authorization, transactions, retry identities, public errors, and durable receipts.
- Store readable versioned conversations and committed receipts as ordinary Arbor content while streaming visible answers and tool progress to the visitor.

Completion gate: at the canonical Supplies agent location, an authenticated visitor can find authorized practices and create a private list through conversation; the same committed data appears in the ordinary React documents, another visitor cannot see it, an interrupted post-commit turn cannot duplicate it, and the transcript retains the exact agent/handle versions and receipt. The concrete implementation plan is [Application 002](applications/002-canopy-hosted-agents.md).

## Milestone 4 — portable deployment

**Status: Planned. Follows the compiled executable-document graphs proven by Milestone 2.**

Outcome: the same tree and executable documents can be published statically where valid and run on additional supported live hosts without adapter-specific source.

- `arbor bake` emits a static ref/object directory for a dumb host when every selected document and query is statically valid.
- Preserve portable per-document graphs for assets, static query results, live handlers, capabilities, and schema requirements.
- Add another live adapter only after a concrete site needs it and it can implement the document graphs' identity, transaction, subscription, and fresh-reconnect semantics honestly.
- Protect deployed handlers with the same Standard Schema input contracts, Arbor user identity, tree execution principal, and process limits as the reference Canopy host.
- Emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.

Completion gate: one Arbor site publishes statically with working links/assets, and one concrete additional live target runs unchanged executable documents with equivalent identity, mutation, and resync behavior.

## Milestone 5 — account lifecycle and hosting administration

**Status: Later. These follow-ups do not block the forward workspace, data, or executable-document milestones.**

Outcome: communities can recover identities and operate persistent hosts without relying on development escape hatches or manually transferred raw credentials.

- Pair another device through an end-user flow while keeping raw credentials out of content and diagnostics.
- Switch among stored identities while retaining one explicit active identity per Arbor data home.
- Define understandable claim recovery, dispute resolution, and administrator reset without changing profile `TreeID` identity.
- Add confirmed removal and restoration flows for claimed community members.
- Add historical/recovery UI for access changes and revocation.
- Productize permanent-domain, persistent-volume, graceful-restart, backup/restore, and migration diagnostics for community hosts.

Completion gate: an operator restores a persistent community on a replacement host, and a member with a lost device recovers the same profile identity onto a new device through an auditable user-facing flow.

Nested groups, cross-community membership, boundary moves/aliases, simultaneous active local identities, and production HA remain deferred unless this milestone explicitly adopts them.

## Deferred workspace extensions

These are not required for mounting distinct trees together, visits, aggregate workspace surfaces, or the first agent/runtime milestones:

- placing the same `TreeID` at several local OS paths simultaneously;
- placement-specific read-only ceilings, which become meaningful when one tree has several placements;
- durable pinned placements of immutable historical revisions;
- reader-local annotation/proposal overlays that shadow or augment a mounted tree.

Historical revisions may still be browsed transiently when revision locators are implemented. A nested mount is path composition, not a reader-local overlay: longest-prefix resolution enters the mounted child tree instead of merging two versions of the same file.

## Continuous hardening

Hardening is not a numbered product dependency:

- expand browser coverage for group creation, access revocation, disconnect, and restoration flows;
- perform focused accessibility and responsive audits;
- strengthen malformed and partial legacy-state recovery;
- add richer bounded ordinary-file metadata and safe previews;
- add provider-specific materialization controls where reliable;
- measure cold/warm behavior on representative large trees;
- keep lazy indexing extension-aware so it never parses binary or placeholder bytes.

## Deliberate absences

Unless an accepted milestone supplies a concrete need:

- no path-scoped remote access: a subtree with different access is a nested Arbor tree;
- no separate local multi-tenant account or group-administration database: groups are authored trees;
- no REST v2 or compatibility adapter for in-place REST v1 changes;
- no SDK generation or universal capability negotiation;
- no persisted event replay across daemon epochs;
- no universal durable identity for every ordinary local file;
- no generic store, transport, credential, or deployment plugin framework;
- no production HA, horizontal-scaling, or retention subsystem.

## Open problems

These are unresolved design questions, not hidden implementation status:

1. **Shared-tree recovery and endpoint movement.** A stable `TreeID` needs a durable, verifiable way to refresh endpoint hints without recreating a central registry.
2. **Identity and recovery UX.** Device replacement, profile recovery, and disputes need understandable proof-of-control flows without turning local arborsync into a multi-user account service.
3. **Merge semantics.** Text has three-way merge; structured collections and whole-database SQLite revisions need backing-appropriate logical conflict semantics.
4. **Determinism discipline.** Query and agent-tool runtimes must keep clock, randomness, I/O, and runtime upgrades from changing supposedly deterministic results.
5. **Compiler correctness.** Handle extraction, validator generation, realm separation, and access inference are security boundaries and need independent verification.
6. **Schema evolution.** Mounted consumers may remain on older shapes while an Arbor tree or external database changes schema.
7. **Consent precision.** Prefix declarations are enforcement-true but may be broader than actual reads/writes; computed paths must remain visibly broad rather than producing false reassurance.
8. **Cross-server executable data.** Define query discovery, delegated authorization, and server-to-server execution routing so an allowed executable document hosted by one server can use data hosted by another without treating network reachability as authority.

## Planning reference

The topic specs describe the complete intended product. This file records implementation order, temporary cuts, completion gates, and current status. [History](history/outcomes.md) records completed evidence; [Interface 003](interfaces/003-native-acceptance-audit.md) contains the only remaining native acceptance work.

- **Implemented** means the focused behavior and its acceptance checks pass in current source.
- **Next** identifies the immediate substantial product milestone.
- **Planned** has an accepted product contract but no complete reference slice.
- **Later** is accepted follow-up work intentionally placed behind the forward product capabilities.

Implement the smallest end-to-end system that proves a visible product feature while preserving data, durable acknowledgement, conflict safety, deterministic protocol behavior, and cross-language agreement. Prefer direct readable code and fixtures to version adapters, generic provider actions, plugin frameworks, or production administration. Introduce an abstraction only when a second concrete implementation needs it.

Future agents must inspect source, tests, and `git status` before trusting a status label. Do not rewrite a partial implementation as future work, and do not weaken a future-product topic spec to match a staged reference UI.
