# Apps 002: Host authored agents on Canopy

**Status:** Planned. Depends on the compiler, query/mutation handles, Arbor-user context, and Canopy execution delivered by [Apps 001](001-supplies-executable-site.md).

## Target result

An authored Markdown agent at an ordinary canonical Arbor location gives people a conversational way to inspect and change the same live data exposed through React components.

The Canopy hosts the agent because it already hosts the relevant executable documents, private backing trees, compiled query and mutation handles, and authenticated Arbor-user context. A visitor can open the agent's ordinary location, converse through a generic Arbor agent surface, and let the agent call only its declared handles. A mutation committed by the agent appears immediately in the ordinary React surface, and a component mutation is visible to the agent on its next query.

This is the agent product described by the original proposal. It is distinct from letting a person's separately installed Codex or Claude Code use the Arbor CLI. The external-agent plan is an integration convenience for a workspace owner; this plan makes an agent part of a hosted Arbor application that other people can visit and use.

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

The exact frontmatter schema should be frozen against the checked-in Supplies agent rather than a synthetic schema exercise. Model/provider tuning may be namespaced, but authored context and tool references identify portable Arbor handles rather than provider function definitions.

The compiled agent manifest contains:

- agent `(TreeID, path, stable key or null)`, source revision, and code/version
  identity;
- resolved context and tool handle identities and their input/output schemas;
- required tree/store prefixes inherited from those handles;
- whether anonymous use is valid or an Arbor user is required;
- transcript destination and visibility policy; and
- model/runtime policy without embedding provider credentials.

## Visitor experience

Opening an agent document in an Arbor-aware client or at its canonical Canopy URL presents a generic conversation surface in place of an authored React component.

- The location bar, title, provenance, access, source-view, and revision controls remain ordinary Arbor controls.
- The initial screen explains what the agent can help with and which consequential operations it may perform.
- The visitor writes natural language rather than constructing handle inputs.
- Tool progress is legible at the level of “searched practices” or “created list,” not raw model protocol frames.
- Query results may be summarized or rendered as compact linked Arbor results.
- Mutation success links to the affected Arbor documents and includes the durable receipt in the transcript.
- A visitor may open the ordinary React documents at any time; the agent is another interface to the application, not a replacement data model.

The generic conversation surface is supplied by Arbor. Authored agents do not ship their own chat React application, authentication UI, or model-provider client.

## Execution model

The Canopy starts one bounded conversation run from the compiled agent version and authenticated visitor context.

1. Resolve and pin the agent document revision and compiled handle versions.
2. Establish the caller's safe `ArborUser | null` projection and verify that the selected agent is executable for that caller.
3. Evaluate declared initial context handles using the same query runner and disclosure rules as executable documents.
4. Give the model the authored prompt, safe user context, query results, and declared tool schemas.
5. Validate each tool call against the compiled handle input schema and invoke it as the current Arbor user.
6. Return query results or mutation receipts to the model and stream the resulting answer and visible tool states to the client.
7. Persist the conversation transcript and committed mutation receipts as ordinary content at the declared destination.

The reference model host is replaceable. It may use a direct model API, a managed agent service, or a conforming hosted Codex/Claude runtime, but provider conversation state is not the canonical transcript and provider tool definitions are derived from the Arbor manifest rather than authored separately.

## Data, identity, and effects

Agents reuse the executable-document boundaries established by Supplies:

- Context queries return authorized shaped results, not raw SQLite or private backing-tree access.
- Query and mutation handlers receive the same authenticated Arbor user used by React documents.
- Person-valued data remains stable `ProfileID` references resolved from profile trees.
- Mutations execute through the ordinary handle runner with validation, transactions, retry-stable IDs/time, safe public errors, and durable receipts.
- The agent never converts a natural-language name, email address, or mutable handle into proof of identity.
- An agent response is commentary; the committed query stream and mutation receipt remain authoritative state.

The first slice includes no non-Arbor service effects. Email, calendar, payments, and arbitrary network tools require a later concrete effect contract; do not smuggle them through model-host capabilities.

## Conversations and transcripts

A conversation has a stable Arbor-generated ID and pins the agent revision used to start it. Continuations retain ordered user messages, assistant messages, visible tool calls/results, failures, and mutation receipts.

The Canopy writes transcripts through an ordinary durable mutation. A transcript records:

- agent identity/revision and runtime/model identity;
- visitor ProfileID when authenticated;
- context and tool handle versions;
- ordered messages and safe tool inputs/results;
- exact mutation IDs and receipts; and
- completion, interruption, or failure state.

Provider reasoning traces, credentials, raw private rows not disclosed by a handle, server stack traces, and secret headers are not transcript content. Large safe results may be referenced by content hash.

Transcript visibility follows the destination tree. For the Supplies slice, each authenticated visitor's conversations must not become public merely because the agent document is public. The authored tree should select a private per-user or application-owned transcript destination before the first production run.

## Streaming and recovery

Use one Canopy-owned streaming response for a conversation turn. The stream carries visible answer fragments, tool-start/tool-result states, mutation receipts, completion, and a resumable conversation identifier.

The durable boundary is the stored conversation plus ordinary mutation receipts, not replay of every transient token. On reconnect, the client fetches the stored conversation and resumes or begins another turn. If the model outcome is lost after a mutation commits, the receipt remains in the transcript and the model may summarize it on continuation; the mutation is never repeated under a new identity merely to regenerate prose.

Cancellation stops further model/tool work but cannot roll back an already committed mutation. The UI reflects that distinction.

## Concrete Supplies slice

Add one checked-in agent document to `sites/supplies` after its query and mutation handles run unchanged in local and Canopy-hosted React documents.

The agent can:

1. ask what the visitor is trying to accomplish;
2. search authorized practices and public or visitor-visible lists;
3. explain a small set of suggestions with links to their ordinary Arbor documents;
4. create a private list for the authenticated visitor after an explicit request; and
5. add selected practices to that list through existing compiled mutations.

Do not give the first agent a general SQL tool, arbitrary tree write, source-editing capability, or application-administration operation. The point is to prove that an agent and React components are two interfaces over the same typed application operations.

## Implementation order

### Phase 1 — compile an agent manifest

1. Add the Supplies agent document and resolve its relative context, tool, and transcript references.
2. Extend the executable-document compiler to recognize an agent document and emit a versioned manifest from its frontmatter and body.
3. Reuse compiled query/mutation handle schemas and inferred access; reject missing, stale, incompatible, or client-only handles before execution.
4. Expose diagnostics through `arbor check` and the ordinary source-view surface.

### Phase 2 — Canopy conversation runner

1. Add a provider-neutral conversation runner that consumes the compiled manifest and streams normalized events.
2. Inject the Canopy-authenticated Arbor user and evaluate initial context through the existing query runner.
3. Translate declared handles into model-visible tools and validate every call before invoking the existing handle runner.
4. Preserve stable tool-call/mutation identities across provider retries and interrupted turns.
5. Add bounded provider configuration, time, token, and tool-call limits as reference-host operational settings.

### Phase 3 — transcripts and recovery

1. Define the ordinary Markdown/transcript representation and private destination used by Supplies.
2. Persist messages, safe tool results, failures, and receipts incrementally enough that a committed effect cannot disappear with the model process.
3. Implement reconnect, continuation, cancellation, provider failure, and mutation-committed/answer-lost behavior.
4. Render historical conversations as ordinary readable Arbor content as well as resumable agent sessions.

### Phase 4 — web and Arbor client surface

1. Render the generic agent conversation at the document's ordinary local and canonical HTTP location.
2. Reuse Arbor's session UI and user identity rather than adding Supplies authentication.
3. Show linked query results, clear mutation progress/results, and ordinary navigation to affected documents.
4. Present the same Canopy-hosted surface in signed macOS Arbor's constrained web runtime without a second native chat/data implementation.

### Phase 5 — end-to-end parity

1. Ask the Supplies agent to find relevant practices as an anonymous visitor and verify that private lists are not disclosed.
2. Authenticate, create a private list through conversation, and observe the ordinary React list UI update without refresh.
3. Change the list through the React component and verify the agent's next query sees the committed state.
4. Interrupt after a committed tool call, reconnect, and prove the receipt is retained without duplicating the mutation.
5. Open the transcript from its Arbor location and verify its agent revision, user, tool versions, messages, and receipts.

## Completion gate

At the canonical Canopy-hosted Supplies agent location, an authenticated visitor can describe a goal, receive authorized practice suggestions, create a private list, and add practices through declared compiled handles. The same committed data appears immediately in the ordinary React documents. Another visitor cannot see the private list, an interrupted post-commit turn does not duplicate it, and the readable versioned transcript retains the exact agent/handle versions and mutation receipt.

The same authored agent and Canopy runner render through local Arbor web and signed macOS Arbor without an application-specific chat implementation.

## Deliberate absences

- no dependence on the external-agent CLI skill or an installed coding agent;
- no separate application database, user table, route system, or authentication UI;
- no general filesystem, shell, SQL, network, or credential tool;
- no provider transcript as canonical Arbor state;
- no requirement to replace the ordinary React component surface;
- no external-service effects in the first slice; and
- no generic multi-agent, scheduling, memory, or connector framework before one hosted agent works end to end.
