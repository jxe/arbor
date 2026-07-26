# Scripts: compilation and execution
*Part of the [Arbor spec](../spec.md): how colocated queries, mutations, and components compile and run. The authoring surface — what a `.tsx` script looks like on disk — is in [format.md](format.md) §6.*

## 1. Compilation, not graph guessing

`query` and `mutation` are explicit compiler markers.

- The **UI build** replaces each handler implementation with a typed handle carrying a stable function ID.
- The **arbord build** retains the handler and only the dependencies reachable from inside that explicit boundary.
- The **validator build** derives a runtime validator from each handler's TypeScript input type. A parameter type that originates in a Zod schema reuses that schema; other types get structurally generated checks. Input validation is therefore a compiler guarantee, not an authoring chore.
- The **access build** records the read/write prefixes gathered from literal `tree(...)` paths in the handler; a computed path without an explicit `reads`/`writes` option is a compile error.
- The **predicate build** compiles collection callbacks (`filter`, `sortBy`, …) into a driver-executable predicate IR — pushed down as SQL on database-backed folders, evaluated over frontmatter on file-backed ones. Constructs outside the analyzable subset are compile errors, which is what makes backing migration transparent in cost as well as in correctness.
- The **public manifest** records IDs, generated validators, inferred declarations, reads/writes, and code hashes for agents and foreign clients, and flags queries using the relational escape hatch (`tree(path).sql`) as backing-coupled.
- A remote static import receives the component or handle surface, not another realm's implementation by accident.

There is no general export-graph slicer and no requirement that the entire ES-module top level be inert. A handler still cannot close over render props/state or import UI-only capabilities; realm violations are compile errors. Shared schemas, literals, deterministic helpers, and other handles are allowed.

## 2. Queries

A query is a deterministic function of `(workspace snapshot, validated input)`:

- Its placement defaults to **following the data**. A query whose read prefixes are materialized locally — local folders and synced mounts — runs in the reader's arbord. A query over an unsynced tree (a visited tree or a lazy mount) runs at the endpoint that hosts it (an **upstream-hosted query**): the host controls data egress, patches handler code immediately without waiting for readers to sync new script revisions, and serves large or sensitive stores without materializing them downstream. An author or host may additionally mark a query `hosted`, forcing authority placement even for synced readers (egress control, secret-touching handlers); a reader forces local placement by syncing the tree, where their grant covers the read set. V1 requires all read prefixes of one query to share a placement; mixed-residence queries produce a diagnostic. The deterministic contract is identical in both placements, so results are cacheable and comparable.
- No direct filesystem, network, clock, or randomness APIs exist in its realm; the scoped tree client is its only data door.
- Reads outside the inferred-or-declared prefixes throw.
- The runtime records the actual read set. When a local change or Merkle delta intersects it, subscribed queries re-run and emit a structural diff.
- A query may call another query through its typed handle so dependencies remain visible to the runtime.

The handle's input and result are inferred by TypeScript. `arbor run ./reading-room.tsx#recentEssays --tag governance` invokes the same handle and prints the JSON seen by the component.

An upstream-hosted query is automatically a versioned API. The public manifest (§1) already records function IDs, validators, and code hashes; the endpoint keeps a version lineage per query ID, and a consumer's handle binds to a version. The host may publish a fix to an existing version — same interface, corrected implementation — or a new version alongside old ones; existing consumers keep working until they re-resolve. Reactivity is preserved across the boundary: the endpoint tracks the query's read set server-side and pushes invalidations and structural diffs over watch. When the endpoint is unreachable, cached results render with explicit staleness, and a tree synced locally may fall back to local evaluation of the same deterministic handler.

## 3. Mutations and the authority boundary

A mutation is the local write-side twin: validated code running in arbord against declared write prefixes. File-backed collection mutations create ordinary file changes in writable workspace folders, mounts, or overlays. Database-backed collection mutations run through the driver's transaction boundary and emit a new consistent store revision. Changes within a shared tree are observable and revertible through its revision history; all changes remain visible to agents through the tree/store interface.

An **authority action** would be deliberately different: centralized invariants or external effects—for example, claiming the last event seat—cannot be disguised as a deterministic local mutation. General authority actions are not specified. The only remote execution in this spec is the explicitly described upstream-hosted query, which is read-only.

## 4. Components and imports

Components are real React—JSX, hooks, state, and component composition—in a sandboxed UI realm. Workspace data enters only through statically imported query and mutation handles. General network APIs are absent; timers, animation, and focus remain available.

Cross-tree script imports use absolute `arbor://` URLs, resolve through the current workspace, then lock the resolved ES-module graph to hashes for that execution. Imported queries and mutations remain typed handles. Consent is computed from the full handle graph and its resolved mounts: *“This component reads `essays` and appends to `arbor://paxmachina.org/inbox`.”* Enforcement makes that statement true.
