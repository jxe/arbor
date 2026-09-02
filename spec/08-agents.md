# Agents
*Part of the [Arbor spec](../spec.md): authored agents, their tools, context, confinement, consent, effects, and transcripts.*

## Agent files

An agent is an ordinary Markdown document. Its body is the primary instruction/prompt; frontmatter declares configuration such as model policy, named tools, context roots or queries, and transcript destination. Model/provider-specific tuning may be present as optional namespaced metadata, but the portable agent remains readable without a proprietary database. The portable frontmatter key set is not yet defined ([deferred 6](../spec.md#deferred)).

An agent file is versioned, linked, shared, and access-controlled like other
authored Markdown. Moving it preserves the stable key derived from its `id`
property; execution uses the resolved tree/path and revision chosen by the
caller.

## Tools and context

Every runtime may expose Arbor's built-in read, navigate, search, backlinks,
node-query, and mutation operations. The node-query surface includes schema-
governed collection and relational capabilities when the addressed source
provides them. An agent may additionally name compiled
[executable-document](07-executable-documents.md) query and mutation handles. Each
tool has a typed input/output boundary and retains tree/path provenance in its
results.

Context is assembled from explicit tree roots, locator selections, or deterministic query handles. It is not ambient retrieval over every host-readable file. Context results record their source locator and revision or observation cursor so a transcript can explain what the agent saw.

## Confinement

Before execution, the runtime resolves an effective namespace from:

- the agent file's declared roots and tools;
- the caller's visible placements and remote access;
- the selected historical/live revisions; and
- an optional stricter process ceiling.

The intersection is the complete authority. The agent and its tools cannot address a path, tree, credential, network target, or host capability outside it. A tool cannot widen the namespace of the agent that called it. Access changes during a run take effect before subsequent operations.

This specification does not prescribe isolation technology, worker language, or process topology. The [no-ambient-authority rule](07-executable-documents.md#authored-component-forms) applies to agents and their tools.

## Consent and effects

Before an effectful run, the client presents the [consent statement](07-executable-documents.md#component-and-data-packages) with the agent's effective values, including its tools, transcript destination, and any explicitly granted non-tree effect.

All tree effects pass through ordinary wire or store mutations and produce normal durable receipts, conflicts, events, access checks, and nested-boundary enforcement. An agent cannot make a direct host-filesystem edit and label it an Arbor mutation. Ambiguous mutation retries reuse the original mutation identity.

## Transcripts

An effectful run produces a readable transcript as ordinary tree content. It includes the agent identity/revision, caller-approved authority summary, model/runtime identity where available, ordered tool calls and results with secrets redacted, mutation receipts, failures, and final output. Large binary/tool payloads may be referenced by content hash rather than duplicated.

Transcripts are versioned and access-controlled by their destination tree. They never contain raw credentials or access-link secrets. A caller may choose not to persist a read-only exploratory transcript, but an effectful run cannot omit the durable record of its committed mutation receipts.

The same agent can run from the CLI, a human client, or another conforming orchestration client. No Arbor-specific screen or control is required.
