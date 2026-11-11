# Apps 002: Host authored agents on overstoryd

**Why and when:** after widgets in Story ([Apps 011](../soon/apps-011-widgets-in-story.md)): authored agents hosted beside an app, calling its own query and mutation handles. No timing yet.

> **Execution-model revision (2026-09-18):** Resource policy is the deployed
> [access-control grammar](../../docs/overstory-spec/3.2-access-control.md), source resolution and runtime extraction
> by [Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08), and replacement authoring /
> durable workflows by [Apps 006](apps-006-durable-authoring.md). These supersede inherited
> named-permission, single-domain-only and unchanged-syntax instructions below.
> Preserve Supplies behavior while intentionally adapting its source to the new API.


**Status:** Planned. Depends on the compiler, query/mutation handles, Overstory-user context, and overstoryd execution delivered by [Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08) and [Apps 011](../soon/apps-011-widgets-in-story.md).

## Target result

An authored Markdown agent at an ordinary canonical Overstory location gives people a conversational way to inspect and change the same live data exposed through React components.

The host runs the agent because it already hosts the relevant executable documents, private backing trees, compiled query and mutation handles, and authenticated Overstory-user context. A visitor can open the agent's ordinary location, converse through a generic Overstory agent surface, and let the agent call only its declared handles. A mutation committed by the agent appears immediately in the ordinary React surface, and a component mutation is visible to the agent on its next query.

This is the agent product described by the original proposal. It is distinct from letting a person's separately installed Codex or Claude Code use the `story` CLI. The external-agent plan is an integration convenience for a workspace owner; this plan makes an agent part of a hosted Overstory application that other people can visit and use.

## Authored agent document

An agent remains an ordinary Markdown document. Its body is the primary instruction, while frontmatter names the model policy, compiled context/query handles, callable mutation handles, and transcript destination. For example:

```markdown
---
model: capable
context:
  - ./scripts/queries.ts#findPractices
  - ./scripts/queries.ts#getList
tools:
  - ./scripts/mutations.ts#createList
  - ./scripts/mutations.ts#addPractice
transcripts: ./conversations
---

Help a person find practices that fit what they are trying to do. Explain your
suggestions, and create or update a list only when they ask you to.
```

The exact frontmatter schema should be frozen against the checked-in Supplies agent rather than a synthetic schema exercise. Model/provider tuning may be namespaced, but authored context and tool references identify portable Overstory handles rather than provider function definitions.

The compiled agent manifest contains:

- agent `(TreeID, path, stable key or null)`, source revision, and code/version
  identity;
- resolved context and tool handle identities and their input/output schemas;
- required tree/store prefixes inherited from those handles;
- whether anonymous use is valid or an Overstory user is required;
- transcript destination and visibility policy; and
- model/runtime policy without embedding provider credentials.

## Visitor experience

Opening an agent document in an Overstory-aware client or at its canonical overstoryd URL presents a generic conversation surface in place of an authored React component.

- The location bar, title, provenance, access, source-view, and revision controls remain ordinary Overstory controls.
- The initial screen explains what the agent can help with and which consequential operations it may perform.
- The visitor writes natural language rather than constructing handle inputs.
- Tool progress is legible at the level of “searched practices” or “created list,” not raw model protocol frames.
- Query results may be summarized or rendered as compact linked Overstory results.
- Mutation success links to the affected Overstory documents and includes the durable receipt in the transcript.
- A visitor may open the ordinary React documents at any time; the agent is another interface to the application, not a replacement data model.

The generic conversation surface is supplied by Overstory. Authored agents do not ship their own chat React application, authentication UI, or model-provider client.

## Execution model

overstoryd starts one bounded conversation run from the compiled agent version and authenticated visitor context.

1. Resolve and pin the agent document revision and compiled handle versions.
2. Establish the caller's safe `OverstoryUser | null` projection and verify that the selected agent is executable for that caller.
3. Evaluate declared initial context handles using the same query runner and disclosure rules as executable documents.
4. Give the model the authored prompt, safe user context, query results, and declared tool schemas.
5. Validate each tool call against the compiled handle input schema and invoke it as the current Overstory user.
6. Return query results or mutation receipts to the model and stream the resulting answer and visible tool states to the client.
7. Persist the conversation transcript and committed mutation receipts as ordinary content at the declared destination.

The reference model host is replaceable. It may use a direct model API, a managed agent service, or a conforming hosted Codex/Claude runtime, but provider conversation state is not the canonical transcript and provider tool definitions are derived from the Overstory manifest rather than authored separately.

## Data, identity, and effects

Agents reuse the executable-document boundaries established by Supplies:

- Context queries return authorized shaped results, not raw SQLite or private backing-tree access.
- Query and mutation handlers receive the same authenticated Overstory user used by React documents.
- Person-valued data remains stable `ProfileID` references resolved from profile trees.
- Mutations execute through the ordinary handle runner with validation, transactions, retry-stable IDs/time, safe public errors, and durable receipts.
- The agent never converts a natural-language name, email address, or mutable handle into proof of identity.
- An agent response is commentary; the committed query stream and mutation receipt remain authoritative state.

The first slice includes no non-Overstory service effects. Email, calendar, payments, and arbitrary network tools require a later concrete effect contract; do not smuggle them through model-host capabilities.

## Conversations and transcripts

A conversation has a stable Overstory-generated ID and pins the agent revision used to start it. Continuations retain ordered user messages, assistant messages, visible tool calls/results, failures, and mutation receipts.

overstoryd writes transcripts through an ordinary durable mutation. A transcript records:

- agent identity/revision and runtime/model identity;
- visitor ProfileID when authenticated;
- context and tool handle versions;
- ordered messages and safe tool inputs/results;
- exact mutation IDs and receipts; and
- completion, interruption, or failure state.

Provider reasoning traces, credentials, raw private rows not disclosed by a handle, server stack traces, and secret headers are not transcript content. Large safe results may be referenced by content hash.

Transcript visibility follows the destination tree. For the Supplies slice, each authenticated visitor's conversations must not become public merely because the agent document is public. The authored tree should select a private per-user or application-owned transcript destination before the first production run.

## Streaming and recovery

Use one host-owned streaming response for a conversation turn. The stream carries visible answer fragments, tool-start/tool-result states, mutation receipts, completion, and a resumable conversation identifier.

The durable boundary is the stored conversation plus ordinary mutation receipts, not replay of every transient token. On reconnect, the client fetches the stored conversation and resumes or begins another turn. If the model outcome is lost after a mutation commits, the receipt remains in the transcript and the model may summarize it on continuation; the mutation is never repeated under a new identity merely to regenerate prose.

Cancellation stops further model/tool work but cannot roll back an already committed mutation. The UI reflects that distinction.

## Concrete Supplies slice

Add one checked-in agent document to `examples/supplies` after its query and mutation handles run unchanged in local and overstoryd-hosted React documents.

The agent can:

1. ask what the visitor is trying to accomplish;
2. search authorized practices and public or visitor-visible lists;
3. explain a small set of suggestions with links to their ordinary Overstory documents;
4. create a private list for the authenticated visitor after an explicit request; and
5. add selected practices to that list through existing compiled mutations.

Do not give the first agent a general SQL tool, arbitrary tree write, source-editing capability, or application-administration operation. The point is to prove that an agent and React components are two interfaces over the same typed application operations.

## Implementation order

### Phase 1 — compile an agent manifest

1. Add the Supplies agent document and resolve its relative context, tool, and transcript references.
2. Extend the executable-document compiler to recognize an agent document and emit a versioned manifest from its frontmatter and body.
3. Reuse compiled query/mutation handle schemas and inferred access; reject missing, stale, incompatible, or client-only handles before execution.
4. Expose diagnostics through `story check` and the ordinary source-view surface.

### Phase 2 — overstoryd conversation runner

1. Add a provider-neutral conversation runner that consumes the compiled manifest and streams normalized events.
2. Inject the overstoryd-authenticated Overstory user and evaluate initial context through the existing query runner.
3. Translate declared handles into model-visible tools and validate every call before invoking the existing handle runner.
4. Preserve stable tool-call/mutation identities across provider retries and interrupted turns.
5. Add bounded provider configuration, time, token, and tool-call limits as reference-host operational settings.

### Phase 3 — transcripts and recovery

1. Define the ordinary Markdown/transcript representation and private destination used by Supplies.
2. Persist messages, safe tool results, failures, and receipts incrementally enough that a committed effect cannot disappear with the model process.
3. Implement reconnect, continuation, cancellation, provider failure, and mutation-committed/answer-lost behavior.
4. Render historical conversations as ordinary readable Overstory content as well as resumable agent sessions.

### Phase 4 — web and Overstory client surface

1. Render the generic agent conversation at the document's ordinary local and canonical HTTP location.
2. Reuse Overstory's session UI and user identity rather than adding Supplies authentication.
3. Show linked query results, clear mutation progress/results, and ordinary navigation to affected documents.
4. Present the same overstoryd-hosted surface in the signed Mac Story app's constrained web runtime without a second native chat/data implementation.

### Phase 5 — end-to-end parity

1. Ask the Supplies agent to find relevant practices as an anonymous visitor and verify that private lists are not disclosed.
2. Authenticate, create a private list through conversation, and observe the ordinary React list UI update without refresh.
3. Change the list through the React component and verify the agent's next query sees the committed state.
4. Interrupt after a committed tool call, reconnect, and prove the receipt is retained without duplicating the mutation.
5. Open the transcript from its Overstory location and verify its agent revision, user, tool versions, messages, and receipts.

## Completion gate

At the canonical overstoryd-hosted Supplies agent location, an authenticated visitor can describe a goal, receive authorized practice suggestions, create a private list, and add practices through declared compiled handles. The same committed data appears immediately in the ordinary React documents. Another visitor cannot see the private list, an interrupted post-commit turn does not duplicate it, and the readable versioned transcript retains the exact agent/handle versions and mutation receipt.

The same authored agent and overstoryd runner render through local Story for the web and the signed Mac Story app without an application-specific chat implementation.

## Deliberate absences

- no dependence on the external-agent CLI skill or an installed coding agent;
- no separate application database, user table, route system, or authentication UI;
- no general filesystem, shell, SQL, network, or credential tool;
- no provider transcript as canonical Overstory state;
- no requirement to replace the ordinary React component surface;
- no external-service effects in the first slice; and
- no generic multi-agent, scheduling, memory, or connector framework before one hosted agent works end to end.

## Text moved from the spec (2026-11-11)

Joe moved these undecided designs out of [apps and views](../../docs/overstory-spec/4.1-apps-and-views.md) on 2026-11-11, since they aren't built. They come back into the spec when this plan decides them. Old section numbers are from that chapter before the move.

### From §13 Agents

#### 13.1 Agent files

An agent is an ordinary Markdown document. Its body is the primary instruction/prompt; frontmatter declares configuration such as model policy, named tools, context roots or queries, and transcript destination. Model/provider-specific tuning may be present as optional namespaced metadata, but the portable agent remains readable without a proprietary database. The portable frontmatter key set is not yet defined ([deferred 4](../../docs/overstory-spec/README.md#deferred)).

An agent file is versioned, linked, shared, and access-controlled like other
authored Markdown. Moving it preserves the stable key derived from its `id`
property; execution uses the resolved tree/path and revision chosen by the
caller.

#### 13.2 Tools and context

Every runtime may expose Overstory's built-in read, navigate, search, backlinks,
node-query, and mutation operations. The node-query surface includes schema-
governed collection and relational capabilities when the addressed source
provides them. An agent may additionally name compiled
[app](../../docs/overstory-spec/4.1-apps-and-views.md#3-modules-and-named-handles) query and mutation handles. Each
tool has a typed input/output boundary and retains tree/path provenance in its
results.

Context is assembled from explicit tree roots, locator selections, or deterministic query handles. It is not ambient retrieval over every host-readable file. Context results record their source locator and revision or observation cursor so a transcript can explain what the agent saw.

#### 13.3 Confinement

Before execution, the runtime resolves an effective namespace from:

- the agent file's declared roots and tools;
- the caller's visible placements and remote access;
- the selected historical/live revisions; and
- an optional stricter process ceiling.

The intersection is the complete authority. The agent and its tools cannot address a path, tree, credential, network target, or host capability outside it. A tool cannot widen the namespace of the agent that called it. Access changes during a run take effect before subsequent operations.

This specification does not prescribe isolation technology, worker language, or process topology. The [no-ambient-authority rule](../../docs/overstory-spec/4.1-apps-and-views.md#2-source-forms) applies to agents and their tools.

#### 13.4 Consent and effects

Before an effectful run, the client presents the [consent statement](../../docs/overstory-spec/4.1-apps-and-views.md#6-components-imports-and-consent) with the agent's effective values, including its tools, transcript destination, and any explicitly granted non-tree effect.

All tree effects pass through ordinary Overstory or store mutations and produce normal durable receipts, conflicts, events, access checks, and nested-boundary enforcement. An agent cannot make a direct host-filesystem edit and label it an Overstory mutation. Ambiguous mutation retries reuse the original mutation identity.

#### 13.5 Transcripts

An effectful run produces a readable transcript as ordinary tree content. It includes the agent identity/revision, caller-approved authority summary, model/runtime identity where available, ordered tool calls and results with secrets redacted, mutation receipts, failures, and final output. Large binary/tool payloads may be referenced by content hash rather than duplicated.

Transcripts are versioned and access-controlled by their destination tree. They never contain raw credentials or access-link secrets. A caller may choose not to persist a read-only exploratory transcript, but an effectful run cannot omit the durable record of its committed mutation receipts.

The same agent can run from the CLI, a human client, or another conforming orchestration client. No Overstory-specific screen or control is required.
