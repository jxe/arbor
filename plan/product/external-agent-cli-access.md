# External agent access through the Arbor CLI

**Status:** Planned. This is an independent enabling plan, not the Canopy-hosted agent milestone. Read-only work can begin against the implemented arborsync/client surface; compiled executable-document handle invocation follows the live-data document work.

## Target result

An installed general-purpose agent such as Codex or Claude Code can work with a person's Arbor workspace without Arbor hosting the model or implementing a model-provider client.

The agent learns Arbor through a small reusable skill and addresses Arbor through a structured CLI. It may use its own browser, shell, skills, plugins, or connected services to gather outside information, then use `arbor` to read or change local, mounted, and remote Arbor data. Arbor supplies the data interface; the external agent supplies reasoning and orchestration.

This plan is deliberately useful before authored Arbor agents exist. It does not implement `arbor run`, a Canopy chat surface, a model loop, an MCP server, or provider-specific data integrations.

## Product boundary

The external agent is a client of Arbor, like a human UI or another program. It does not become an Arbor-authored agent merely because it has read an agent Markdown file.

Arbor owns:

- locator resolution across local paths, placed trees, remote trees, and revisions;
- exact source and structured collection access;
- durable, retryable mutations and their receipts;
- stable machine-readable output and errors; and
- the reusable instructions that teach an agent how to use those operations.

Codex, Claude Code, or another external agent owns:

- model selection, conversation state, scheduling, and reasoning;
- deciding which Arbor commands to invoke;
- access to its separately installed web, browser, or service integrations; and
- combining outside information with Arbor content.

An external service does not need an Arbor-specific adapter when the chosen agent can already reach it through a plugin, MCP server, browser, or vendor CLI. Continuous synchronization or transactional mirroring of an external service remains a separate store/workflow problem rather than an implicit property of this agent access.

## Agent-oriented CLI surface

Add thin CLI commands over the existing `ArborSyncRESTClient` operations. Commands resolve operands as Arbor locators and use arborsync or the relevant server rather than reading private Arbor state.

The initial read surface is:

```text
arbor status [<locator>] --json
arbor resolve <locator> --json
arbor read <locator> [--source|--json]
arbor children <locator> [--cursor <cursor>] --json
arbor search <locator> --query <text> [--cursor <cursor>] --json
arbor backlinks <locator> [--cursor <cursor>] --json
arbor collection <locator> [--table <name>] [--cursor <cursor>] --json
arbor recovery <locator> [--recursive] [--cursor <cursor>] --json
```

The initial mutation surface is:

```text
arbor write <locator> --stdin --base-revision <revision> [--mutation-id <id>] --json
arbor create <parent-locator> --name <name> [--stdin] [--mutation-id <id>] --json
arbor move <locator>... --to <directory-locator> [--mutation-id <id>] --json
arbor copy <locator>... --to <directory-locator> [--mutation-id <id>] --json
arbor trash <locator>... [--mutation-id <id>] --json
arbor restore <locator> [--mutation-id <id>] --json
```

Names may be reconciled with the final portable CLI specification before implementation, but the behaviors must remain individually composable. Do not replace them with one prompt-shaped `arbor agent` command.

After compiled handles exist, add:

```text
arbor call <script-locator#handle> --input <json> [--mutation-id <id>] --json
```

`arbor call` validates against the compiled handle schema and returns the ordinary query result or durable mutation receipt. It does not start a model or interpret an agent document.

## Output contract

Machine-readable mode is a product surface, not a rendering of human terminal prose.

- Successful JSON identifies the resolved tree, logical path, PageID when present, selected revision, observation cursor where relevant, and command-specific result.
- Paginated commands return the next cursor explicitly and never silently truncate.
- Mutations return the caller-supplied or generated mutation ID and the ordinary durable receipt.
- A transport failure with an uncertain mutation outcome is distinct from a known rejection; the error tells the caller to retry with the same mutation ID.
- Expected failures have stable error codes and safe messages. Diagnostics go to stderr; stdout contains only the requested result.
- Raw credentials, access-link secrets, private state paths, and unrelated configuration never enter output.

Human-readable output may remain concise, but every command needed by the skill must support JSON without scraping text.

## Reusable Arbor skill

Create one source skill with thin packaging for Codex and Claude Code rather than maintaining divergent instructions. The skill teaches the agent to:

1. verify that arborsync is available with `arbor status --json`;
2. resolve a locator before assuming its tree, path, placement, or writability;
3. use `children`, `search`, `backlinks`, and `collection` instead of recursively scanning guessed filesystem roots;
4. retain provenance and revisions when summarizing or editing;
5. read exact source before making an exact-source change;
6. pass the observed base revision and a stable mutation ID for writes;
7. retry an ambiguous mutation only with the same ID;
8. use the external agent's own connected tools for non-Arbor systems; and
9. report which Arbor locations changed and include their receipts.

Keep the skill procedural and small. Command help and JSON schemas remain authoritative; do not duplicate the entire Arbor specification into agent instructions.

## Implementation order

### Phase 1 — read and discovery commands

1. Add a shared CLI request/output layer over `ArborSyncRESTClient`.
2. Implement `status`, `resolve`, `read`, `children`, `search`, `backlinks`, `collection`, and `recovery` with deterministic JSON.
3. Exercise local paths, mounted nested trees, unplaced remote trees, historical locators, pagination, missing content, and inaccessible content.
4. Document concise examples in CLI help without requiring a running model.

### Phase 2 — durable mutation commands

1. Implement revision-aware write/create and structural mutation commands through ordinary arborsync mutations.
2. Accept an explicit mutation ID and return it on every result path.
3. Test exact retry, stale-base conflict, partial transport failure, cross-tree rejection, nested-boundary behavior, and receipt serialization.
4. Keep direct filesystem writes and private-state manipulation out of the CLI implementation.

### Phase 3 — skills and real workflows

1. Package the shared Arbor operating instructions for Codex and Claude Code.
2. Run both agents from a directory outside the Arbor repository so success does not depend on repository source knowledge.
3. Test a research-only task spanning two mounted trees.
4. Test an edit task that reads exact source, applies one focused change, and reports the receipt.
5. Test a mixed integration task in which an agent reads from one of its existing connected services and writes a sourced result into Arbor without an Arbor-specific service client.
6. Revise command descriptions and skill routing from observed failures before adding a richer protocol.

### Phase 4 — compiled handle invocation

After the live-data document compiler and handle runner exist, implement `arbor call` for one Supplies query and one Supplies mutation. Prove that the external agent can use application-level operations without database credentials or knowledge of the backing schema.

## Completion gate

From outside the Arbor source checkout, both Codex and Claude Code can discover the Arbor skill, use only documented CLI commands to research two mounted trees, make a revision-safe update to one document, and report the exact changed locator and durable receipt. One agent also reads an already-connected external service and writes a sourced result into Arbor without any service-specific code in Arbor.

After compiled handles land, the same agents can invoke a checked-in Supplies query and mutation through `arbor call` with validated JSON input.

## Deliberate absences

- no model-provider API client or Arbor-owned conversation loop;
- no Canopy-hosted chat UI;
- no authored-agent execution semantics or transcript format;
- no MCP requirement before the CLI proves insufficient;
- no generic external-service connector registry;
- no claim that an ad hoc agent run continuously synchronizes an external system; and
- no weakening of mutation revisions, retry identity, or durable acknowledgement for convenience.
