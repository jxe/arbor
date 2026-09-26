# Merge sidecar and accepted history

canopyd keeps accepted history as immutable **log entries** in its object store and
asks a **merge sidecar** one question when concurrent work has to combine. The
reference implementation's sidecar is the TypeScript package `@overstory/canopyd-merge`,
run by Bun as the `arbor-merge` executable. canopyd owns authorization, guards,
conflict identity, accepted history and atomic acceptance; the sidecar owns the format
rules and the tree merge, and whatever it caches. [Writing a
sidecar](writing-a-sidecar.md) is the whole API on one page; this page describes how
canopyd and the reference sidecar use it.

The two share only the object store (`@overstory/object-store`) and the JSON contract
(`@overstory/merge-protocol`). canopyd does not depend on `@overstory/canopyd-merge` and
stores none of its state. The sidecar has no database connection or credentials; it is
a trusted local process, not an OS sandbox for arbitrary plugins.

## Accepted history

Every accepted update is one log entry, written by canopyd as canonical JSON
(`stableJSONString`) into the object store before the transaction that records it, as
roots are. The accepted row keeps only the entry's hash (`accepted_updates.entry`) and
its `conflicted` flag; everything else about the update's merge (its trace, the keys it
resolved, the decisions open after it, how the sidecar was asked and its evidence) is
in the entry. An entry names the one before it, so a tree's history is a hash chain;
a tree's first retained entry has `previous: null` (tree creation, and each head
migration 018 converted). canopyd's SQLite schema stays private.

Every acceptance path writes an entry: client updates, tree creation, pairing, account
configuration and boundary rewrites. canopyd's own acceptances write theirs directly;
when the head has open decisions they ask the sidecar to carry them onto the new root
(with `conflictProjection: "incoming"`, so the root is shown as given).

Inspection pages, resolution guards and alternative bindings read decisions from the
entry. A decision's public id is derived from its tree and key, an alternative's from its
index, and an alternative's `revision` from its value and contributions, so an edit
elsewhere in the tree changes none of them. A decision without `path` is a `directory`
decision at `/` whose values are its roots; with `path` and no `range` it is an `entry`
decision placed at that path, whose values are each alternative root's file, folder or
absence there; with `range` it is a `content` decision affecting that range of the file,
whose values are the alternatives' bytes.

The integrity audit (`/.arbor/integrity`) checks every row against its entry (tree, root,
conflicted flag, and that its predecessor row's entry is its `previous`), and walks every
chain, verifying each entry's root and every alternative root and range object.

## The merge question

canopyd asks one kind of question (`MergeQuestion`): the entry the candidate was
authored on, the tree's current entry, the earlier candidates of the same batch that
were authored on that base (`prefix`), the candidate itself with the decision keys its
guards resolved and the alternatives its operations name, and the rules. The answer is
the root to accept, the new objects the sidecar staged, the decisions open afterwards and
evidence. canopyd records the question in the entry's `asked` field (its base when it is
not the head, the prefix, the candidate root when neither the trace's end nor the
accepted root, the bindings, the rules), so a sidecar can ask it again later.

### Fast-forward

A traced update authored directly on the head is accepted by canopyd without a question
when every frame's operations are `moveSource` and then `editSource` over basis material,
or `addEntry` of a new name into a basis directory, canopyd reproduces every frame's
`after` exactly
(`checkPlainTrace` in `@overstory/protocol`, beside `composeSourceEdits`), it resolves
nothing, and no open decision concerns what it touches: a decision about the root, the
edited file or an added entry, or a folder containing one. Open decisions carry over,
each entry choice's alternative roots rebased onto the new root. Anything canopyd cannot
check goes to the sidecar, which remains the authority on validity; the fast path never
rejects. Each fall-through is logged with its reason (`Fast-forward fell through: ...`)
and counted in the request's timings (`fast-forward-miss`).

A move lands beside basis material that stays in place, or beside the whole source
of an earlier move in the frame, and an edit inside moved material edits it where it
lands (`arrangeSources` in `@overstory/protocol`). A placement whose order basis
coordinates do not decide (two moves beside one anchor, an insertion at a moved span's
edge) falls through. The sidecar's own exact-basis path accepts the same basis moves
and ordered lineage; operation and alternative references, copies and entry
operations take its full evaluator.

A batch is checked before anything in it is accepted: plain elements are checked by
canopyd, each on the one before it, and any other traced element is asked of the sidecar
against the request's base (with the earlier elements as `prefix`). An unsupported or
invalid element never accepts a prefix. At acceptance, an element accepted exactly as
authored on the entry before it becomes the next element's base; any other is carried in
`prefix`. A preflight answer is reused only for a verbatim question.

When a batch extends an already accepted prefix, canopyd rechecks that prefix's
retained traces for plainness before allowing the new tail to use the fast path.
A receipt alone is insufficient: the earlier acceptance may have required causal
execution. Plain prefixes therefore avoid an unnecessary sidecar question for the
tail, while reordered lineage, resolutions, and other non-plain prefixes still
require causal preflight. A fully receipted retry returns its receipts without
rechecking traces or asking the sidecar.

### Snapshots

A snapshot (a candidate with `trace: null`) that equals the head's root or its own base
is unchanged without a question, unless it resolves decisions. Otherwise the sidecar
merges it (below) and an answer that leaves the head's root and decisions exactly as
they were is also reported unchanged.

## Transport and execution

```sh
bun run arbor-merge serve --objects /data/objects --staging /data/merge-workers/worker-example/objects --cache /data/merge-cache
```

`serve` answers one question per stdin line with one line on stdout, in order: an
answer, `{ "refusal": { "code", "message" } }` for a typed refusal (`invalid`,
`missing-context`, `unsupported`, `limit`), or `{ "error": { "message", "code"? } }` for a
failure to evaluate. Each question's timings go to stderr as one
`{"timings": ...}` line. canopyd keeps one sidecar alive across jobs with a bounded
FIFO queue, stages each question's uncommitted inputs, checks the answer, then clears
staging before the next job. A verified answer, a well-formed refusal and a well-formed
`{error}` line all leave the process in service with its cache. A timeout, a crash,
unparseable or malformed output, or an answer that fails the checks below retires it:
it is reaped before cleanup, and the queued successor starts a replacement. canopyd
shutdown drains the active job, rejects queued work, and closes the process. A custom
executable (`ARBOR_MERGE_EXECUTABLE`) speaks the same protocol.

### Answer checks

canopyd trusts the sidecar it runs. It checks each answer's shape (strictly: nothing
but the four fields), hash-checks every staged object as it reads it back, verifies the
complete closure of the accepted root and of every alternative root, and reads every
range alternative and `at` object. It does not re-execute operations or look inside the
sidecar's reasoning. Returned objects are kept in memory until canopyd durably stores
them before the accepted transaction; writing an object alone never creates accepted
state.

## The reference sidecar

### Cache and replay

The sidecar keeps an engine state per log entry, decoded in memory, and the objects
its answers generate in the same memory (never in canopyd's store). To answer a question
it needs the states of `base` and `head`; it walks `previous` from each to the nearest
cached or saved entry, or to the chain's start, and replays forward:

- a chain's first entry is imported from its root and decisions;
- any later entry asks its recorded question again with its `previous` entry as head
  (for an entry with no `asked`, a fast-forward, the trace on `previous` under the
  current rules), then **aligns** to the entry's root and decisions: decisions whose log
  form already matches keep their retained detail, the rest are removed and imported
  from the entry. An entry whose question is now refused is aligned to from the
  previous state. A failure to evaluate it (the time budget, a store error) is not a
  property of the question, so it fails the question being answered instead.

Replay is how every state is built, warm or cold, so a cache wipe changes no answer.
The last 32 solved questions are kept, so replaying the entry canopyd just recorded from
an answer reuses that answer's state. The cache is dropped whole when its objects and
the estimated size of its states exceed `ARBOR_MERGE_CACHE_MB` (default 512).

A cold rebuild (after a restart, a crash or a dropped cache) replays each chain from its
start, and chains only grow: about 17 ms an entry at 110 files, locally. So one question
replays for at most `ARBOR_MERGE_REPLAY_MS` (default 10 s, which with canopyd's 20-second
evaluation budget stays inside its 30-second timeout), then answers
`{"error": {"code": "unavailable"}}` and keeps every state it rebuilt; canopyd answers a
retryable 503 and the client's retry continues the rebuild. Every attempt replays at
least one entry. Without the budget canopyd's timeout would end the process and lose the
partial rebuild, and a long enough chain could never be rebuilt. Replay never starts
partway along a chain: an imported start would lose the retained history a later merge
reads, including the attribution of the current side of a choice.

**Saved states.** With `--cache DIR` the sidecar also saves some entries' states there,
so a restart does not replay each chain from its start. After answering, it saves the
question's head state once 32 of that tree's entries were replayed since the tree's last
save, and keeps the tree's two newest saves (`DIR/<tree>/<entry digest>.json`, written
whole and renamed into place). A save holds the entry's state, every state its decisions
name, and the objects they name that only the sidecar holds. The encoding keeps each
value's key order and each map's bucket shape, so a saved state loads as the state replay
built, byte for byte; loading checks every state's identity and every object's hash, and
a save that fails either is deleted and replayed instead. A restart therefore replays at
most about 32 entries more than a warm sidecar. On the 2026-09-24 production copy the
282-entry chain replayed in about 1 s locally; a restarted sidecar answered the same
question from the save in 37 ms, and the save took 44 ms and 2.5 MB. canopyd passes
`/data/merge-cache`, never reads it, and does not back it up: deleting it changes no
answer. A saved state is not an imported start: it is the replayed state itself, retained
history included, so replay still begins at the chain's start or at a state it built.

What replay cannot recover is recorded as fact: an entry that migration 018 wrote from
a schema-18 record has no `asked`, so a concurrent merge in it is aligned to rather than
re-evaluated, and a source choice it carries is imported from its range and fragments.
Both give conservative later merges (more choices, never silent loss).

### Log decisions

The engine's decisions are converted to log decisions against the accepted root: a
choice about one file, folder or existence names whole alternative roots (the root with
each version at the path); a source choice names its range in the displayed file (or the
older file it was about, with `at`, once enclosed) and each alternative's bytes; any other
choice is about the root and names its roots. Importing reverses it.

### Snapshot merges

An untraced snapshot (as filesystem sync sends) is merged as a tree against
the head's root (by [`@overstory/tree-merge`](../../../packages/tree-merge/README.md))
and then checkpointed onto the head's state. It encloses only
choices whose own material it touches: a
choice about one file is untouched by edits elsewhere, and a snapshot of the
displayed version continues that alternative, as a traced edit would. When a
snapshot itself conflicts, each conflict becomes a choice about one entry and
the rest of the snapshot merges: a conflicting file (or file against its
deletion) is a choice about that file, and a conflict inside a folder the tree
merge could not reconcile (a divergent page move, a collection schema
conflict), or at an entry that is not a file in both versions, is a choice
about the nearest folder both versions hold. A choice inside another choice's
folder is part of that choice, and a folder choice depends on the open choices
already inside it, so replacing the folder must resolve them too. Only a
conflict at the root, or one no folder below the root contains, is a single
whole-root choice. The current material stays displayed and the candidate's
is the alternative. The current alternative is
attributed to each change accepted since the request's base that touched the
path (as a change, never an operation); the candidate to its own change. A
batch suffix whose basis showed a hidden alternative of an open file or folder
choice continues that alternative: the choice keeps its identity, and the
alternative becomes the suffix's version instead of a second choice about the
same entry.

When the tree merge itself fails, ordinary content is kept as one whole-root choice that
shows the current tree, and the failure goes to stderr.

## Tree configurations

Tree configuration files are canopyd's policy: it parses them, authorizes every change
before and after merging, and writes them itself. So their three-way merge runs in
canopyd (`packages/canopyd/src/tree-config-policy.ts`, using `mergeTreeConfigs` from
`@overstory/protocol`), beside that authorization, and the sidecar has no configuration
rule. canopyd then asks the sidecar a question authored on the head with the merged root
as candidate, and adds a restrictive access-policy choice to the entry itself. Parsing
and the canonical writer are in `@overstory/protocol` (`config/tree-config.ts`).

## Operation evaluation

A traced candidate is evaluated by the engine against the author's basis state and the
head's state, both from the cache. There is one evaluator; snapshots, alignment and
imports are different inputs to it. Equal roots never imply equal retained intent, and
the evaluator never invents operations from a diff.

**Frames.** Operations arrive as a trace: a chain of `{ before, after,
operations }` frames from the request's base root to the candidate. References
are frame-local, operation keys are unique across the trace, and every frame
must reproduce its own `after`. A trace is evidence the evaluator checks in
full, never a hint; an empty trace is snapshot semantics. The protocol bounds
a trace to 64 frames and 1024 operations. `undoOperation` is not in the
grammar; editors express undo and redo as ordinary edits, and the evaluator
answers `unsupported` if it sees the kind. Clients compact a burst of plain
`editSource` frames before publication: `compactTrace` in
`packages/working-tree/src/local-change.ts` (and the Swift `ChangeLog`) composes
them with `composeSourceEdits` (see [trace compaction](../../implementing-editors/editor-source.md#trace-compaction)).
The evaluator does not compact; it checks the trace it receives.
`composeFrames` in `tests/support/source-edits.ts` implements the same rule by
executing the composition, and serves as a test reference for it.

**Results.** Success returns `outcome: "evaluated"`, `result: { object, state }`,
`authored: { object, state }` for the exact candidate before reconciliation, a
generated-object manifest, decision proposals, and evidence naming the three
input roots, the change and operation keys, the rule revision, configuration,
and policy reasons. The rule is deterministic, so the three roots reproduce
every object it read; the read set itself is not retained. Typed inabilities
are `invalid`, `missing-context`, `unsupported`, and `limit`. Unsupported
operation kinds are not successful no-ops, invalid candidates publish no staged
output, and an inability to evaluate is neither a conflict resolution nor an
accepted receipt; canopyd decides admission and fallback.

**Choices.** Text choices identify immutable basis ranges and their material
alternatives; independent overlaps can remain separate decisions, and a format
refusal can couple the file. Structural ambiguity couples the containing tree.
Explicit alternative bindings map canopyd's authorized material references into
the retained proposal. Enclosing choices retain the old context and depend on
the enclosed decisions; discarding guarded child material requires coherent
declarations. Selective undo preserves independent edits, and if later work
interferes with the inverse the tool retains the pre-undo tree as an
alternative rather than discarding that work. canopyd defaults to independent
source choices with current material selected; `mergeTool.contentChoices:
"file"` restores whole-file presentation, and format rules can still couple
choices.

A pre-existing source choice does not widen a later independent overlap or make
it dependent on that choice. Hidden source successors match the retained whole
branch context, then advance the affected fragment using source provenance.
When a transformation scatters a choice so it cannot remain a contiguous range,
an edit confined to one file retains a file-scoped enclosure and its child
choices; it does not escalate to the root directory. A newly authored enclosure
is not itself evidence of a concurrent conflict. A selected deletion has no
pieces to follow: its anchor moves with later edits, and only an edit spanning
the anchor encloses it. A choice already retained in its own context is not
re-evaluated against later edits to the live file. A file deleted on one side
and changed on the other is an existence choice about that file alone: its
kept alternative is the file, the deleted alternative names no node, and every
other concurrent change still merges into the projection.

Evaluation time-budget exhaustion is an execution failure, not a refusal: the
sidecar answers `{"error": {"message": "Evaluation time budget exceeded", "code":
"limit"}}`, and canopyd returns a retryable HTTP 503 `merge-failed`, not a
malformed-request HTTP 400. The host grants evaluations 20 seconds by default,
capped by the sidecar timeout (`evaluationMillis` can configure a smaller budget);
the standalone evaluator retains its 5-second default. Deterministic budgets (the
object and generated byte budgets, node, depth and work budgets) are `limit`
refusals, and invalid input is an `invalid` refusal. A store failure other than an
absent object is also an `{error}`, and so is any other exception the engine did
not type: it is the sidecar's failure, never reported as the client's invalid request.

### Format support contract

Rules preserve bytes by applying verified source spans; they never print or
normalize a parsed tree, and parser success alone is not enough to merge. These
are the automatic subsets; other simultaneous changes retain alternatives.

| Format | Automatic subset | Requires review |
| --- | --- | --- |
| Text | Disjoint verified origins, including retained lineage and transport | Overlaps and competing anchors by default |
| Markdown | Stable host structure; prose, heading/list text, task values and simple table cells; independent embedded regions; concurrent known embedded edits delegate to their format; identity-verified [transfers](#transfers) of paragraphs, list items and table rows, with contextual links whose binding is proven | Structural delimiter/order changes, ambiguous links, escaped tables and unsupported embedded combinations |
| JSON | Different values under unique, unchanged object-key paths; identity-verified keyed member [transfers](#transfers) within one file | Duplicate keys, array ordering, key creation/removal or competing values |
| JSONL | Independent record fields with configured unique `recordKey` and stable order | Missing/nonunique keys, key/order/schema changes |
| YAML | Different mapping values with unique stable keys and preserved source; identity-verified keyed member [transfers](#transfers) within one file | Anchors, aliases, tags, sequences, multiline scalars and parse warnings |
| TOML | Different mapping values under stable unique tables/keys | Dotted keys, arrays, multiline constructs and structural changes |
| CSV/TSV | Different cells with configured unique `recordKey`, unchanged header and row order | Key/schema/order changes, malformed quoting and duplicate keys |
| TS/JS, Swift, Python | Parser-backed literal changes in distinct uniquely named declarations or supported members; syntax and binding topology unchanged; TS/JS only: identity-verified moves of top-level function declarations within one file ([transfers](#transfers)) | Binding/operator/import/export changes, overloads, decorators, macros, wrappers, directives and ambiguous declarations; Swift and Python declaration moves |
| HTML | Different values under unique element/attribute structure with unchanged order | Repeated unkeyed siblings, duplicate IDs, scripts/styles and event handlers |
| XML | Distinct values in a strict, uniquely structured namespace-free document | Namespaces, DTDs/entities and repeated sibling identity |
| CSS | Different unique declaration values with stable selectors/properties/order | Duplicate declarations, variables, unsupported selectors and cascade-changing structure |
| Binary/media | Entry move/copy and independent tree changes | Competing opaque content; no byte concatenation |

#### Transfers

A `moveSource` or `copySource` on either side (in the candidate or accepted
since its base) is merged by replaying the candidate's operations on the
current state by piece identity, never by similarity, and then asking the
format's transfer rule about every file the replay changed, with its base,
current, authored and replayed versions (`evaluateTransfer` in
`packages/canopyd-merge/src/format-rules.ts`). Each rule states its
commutation proof in code: why a change means the same in the combined file
as where it was authored, whichever side arrived first. When the proof does
not hold the candidate is reviewed as before; a rule never guesses.

- **Markdown** (`markdown-source-transfer`). All four versions keep every
  protected host block and embedded region byte for byte, and differ only in
  plain and self-contained formatted paragraphs, in *list items* within a list
  host of the same bullet, and in *body rows* within a table host of the same
  header and alignment. A list host is a block of single-line top-level
  bullet items (one bullet character, one space, self-contained inline content
  that begins no other block); a table host is a pipe table whose lines all
  start and end with `|`, without escapes, whose every row has the header's
  cell count. Ordered, nested, indented, multi-line and continued items, a
  host directly followed by an opaque region, a host that appears or empties,
  and a changed bullet, header or alignment require review.
- **Contextual links.** A relative destination, a `#fragment` and a
  reference (`[text][label]`, `[label][]`, `[label]`) bind to their document:
  its directory, headings and definitions. Headings and definitions are
  protected, so the four versions keep them identical, and the document's
  directory must be the same in all four. A fragment or reference is admitted
  only when no transfer in the merge carries text between documents; a
  relative link also when every such transfer joins two documents in one
  directory. Escaped or entity-encoded destinations, other schemes, titles and
  non-ASCII labels stay protected.
- **Same-anchor ordering.** When the replayed operation lands where current
  already inserted material (between the same two base bytes; a transfer's
  destination range counts at its chosen side), the pair is kept in
  contribution-key order, the order competing plain insertions use, so both
  arrival orders give one result. The concurrent material must be exactly one
  recorded contribution of current, the replayed operation must be authored on
  the request's base, the replay must put the pair side by side, and the pair
  must pass the prose insertion policy at that offset (so plain text and
  structured formats keep review, and Markdown keeps its host checks).
  Competing moves of the same material still require review.
- **JSON and YAML** (`json-source-transfer`, `yaml-source-transfer`). A move
  or copy of one complete keyed member (a pair with only whitespace and
  separating commas beside it) within one file, located by identity in base
  and in its side's version. Each side is read as its moves (relocating a
  member's subtree), its copies (adding one) and leaf value edits; the proof
  requires that neither side's transfer endpoints are, contain or lie in the
  other's, that relocated changes are disjoint, and that the replayed document
  equals base with both sides' relocations and relocated changes, key for key.
  Moves between files, array elements, key creation or removal outside a
  transfer, duplicate keys and the ordinary YAML exclusions (anchors, aliases,
  tags, sequences, block scalars) require review.
- **TS/JS declarations** (`typescript-source-transfer`,
  `javascript-source-transfer`). A move of one complete top-level `function`
  (or generator) declaration within one file. Function declarations are
  hoisted whole, so their position among the other statements has no effect;
  every other statement keeps its order and syntax, and edits on either side
  may change only literals, in different declarations or statements. Exports,
  decorators, directives, tool-directing comments (`@ts-`, `eslint`, …),
  classes, overloads, ambient and namespace declarations, and moves between
  files require review. Swift and Python declaration moves are not modelled
  and require review.

An edit that removes a byte beside a transfer's destination anchor makes the
anchor unavailable, which the engine never guesses: that pair is reviewed in
the order where the edit arrives first.

Markdown defaults to `proseInsertions: "preserve-both"`: competing additions
of ordinary prose, paragraphs, and list or task items are kept in stable
contribution order with exact bytes, no separators, and no deduplication.
`"review"` requires review instead. Plain text defaults to review and can opt
in. Structured formats cannot opt into concatenation.

Tree-sitter grammars and the strict XML parser are pinned dependencies. Only
grammar modules are cached; parsed trees are disposed after evaluation.
Neither authored source nor parser IDs execute with host IO authority, and
collection schemas are declarative `schema.cddl` data checked by
[`collection-schema`](../collection-schema/README.md); nothing is evaluated.

### Retained state

Retained state has active material (nodes, decisions) and five history maps
(`outputs`, `effects`, `origins`, `alternatives`, `changes`) of immutable
records. The engine records a state decoded, in memory: every record, node and
decision is frozen and interned, so equal values are one object, and its nodes
and history maps are persistent maps (buckets split by key hash) that share
every bucket an edit did not touch. A plain edit adds what it wrote and the
buckets on its path; nothing is serialized or read back. A state's identity
is a digest of its content and its `editable` flag, so equal states recorded
on any path are one state, and its objects keep their keys in an order that
depends on content alone. A state is `editable` when the
evaluation that recorded it enforced every deletion in its effects map on its
nodes. Transported results and states imported beside existing history are
not editable and take one complete scan, after which their result is
editable. A result kept under `conflictProjection: "current"` is exactly as
editable as the current state it keeps: its nodes are current's, and the
effects they do not reflect are the declined candidate's. A tree's first
import has no history and is editable. A checkpoint (snapshot candidate) of an
editable state inherits editability: it adds no effects, unchanged files keep
their enforced pieces, and replaced files get fresh origins. An evaluation on
an editable state enforces only the deletions of newer effects.

Every effect records `edits`: for an `editSource` effect its piece delta per
file node (each edit's `range`, `removed` and `inserted` pieces), and nothing
for other kinds. An edited file's `before`/`after` node copies omit `pieces`.
Deletion enforcement and retention read only the delta. Records with whole
piece copies and no delta were written only into history that migration 016
squashed, and are no longer read.

A choice declines the deletions its unselected alternatives contributed. When
it is made, those effects' `removed` pieces are narrowed to spare what the
choice shows: the selected source range for a content choice, the kept file
for an existence choice, and every live piece for a root choice kept under
`conflictProjection: "current"`. Enforcing every effect therefore never cuts
kept material, whether in a complete scan, in a merge from a basis before the
choice, or after the choice is resolved. A resolution that installs another
alternative removes the kept material by its own operations.

These states live in the sidecar's memory; canopyd never stores, reads or audits them.

### Limits

Requests are bounded to 8 MiB at the CLI with at most 1024 operations.
Parser-backed analysis caps source at 256 KiB, syntax traversal at 20,000
nodes, and each parse at 100 ms. Exceeding a budget returns `limit`; an
analyzer that cannot prove independence preserves choices. No timeout can
commit accepted state inside this process.

## Objects, authority and failure

`@overstory/object-store` provides immutable, hash-sharded storage. Reads verify hashes.
Durable writes flush files and atomically link them into place; disposable staging uses
atomic publication without fsync. The sidecar reads shared storage first, then staging,
then its own memory. Corrupt shared bytes fail validation. Question JSON contains no
object-store filesystem paths.

The sidecar owns a unique `/data/merge-workers/worker-*` directory. For each job
canopyd stages the uncommitted inputs in its `objects/` staging store, in one publish.
The sidecar receives fixed paths and a minimal environment rather than inherited server
credentials. Normal and failed jobs remove staging in `finally`. A host crash can leave
an unaccepted worker directory; canopyd removes `merge-workers/` at startup, before any
job runs. `merge-cache/` is the sidecar's and outlives restarts.

Every entry, and every root and alternative it names, is reachable from its tree's head
entry, so a future object collector keeps exactly what the chains reach; sidecar caches
are disposable. The object store has no collector today. Entry hashes are never sent to
clients; the object route serves any retained object to a caller who can read some tree
and knows its hash, and entries fall under that rule.

canopyd uses one sidecar, at most 64 queued questions, a 30-second timeout with forced
termination, and an 8 MiB stdout/stderr buffer limit. A sidecar that cannot start, exits
or times out accepts nothing: canopyd answers a retryable 503 (`merge-failed`), and the
client retains its durable request for retry. A fast-forward and an exact accepted retry
need no sidecar. Governed tree configurations retain their authorization and rejection
policy.

## Running and configuring

The default invocation runs the TypeScript CLI with the current Bun runtime. The
workspace exposes `bun run arbor-merge`; its executable script has a Bun shebang. No
compilation or signing is needed. `ARBOR_MERGE_EXECUTABLE` may name an absolute
executable script or program that implements `serve`; programmatic options also accept
fixed arguments and limits. Arguments are never interpreted by a shell.
`ARBOR_MERGE_CACHE_MB` bounds the sidecar's cache and `ARBOR_OBJECT_CACHE_MB` its
object read cache.

Install workspace dependencies with `bun install`. Collection-file rows are decoded and
re-encoded through the pure `collection-schema` package under the profile's bounded
parse and validation budgets; the sidecar executes no authored schema and has no QuickJS
or Zod dependency for collections.

Ported behavior: Markdown additive merging and frontmatter/fence checks; stable-page
rename and directory reconciliation; keyed collection rows and schema/constraint
checks. Exact authored-operation execution, nested choices, and the
conservative format rules are described next.

## Verification

```sh
bun test tests/integration/canopyd-merge tests/integration/canopyd tests/unit/canopyd tests/unit/canopyd-merge
bun tests/performance/benchmark-merge-tool.ts
FILES=1000 bun tests/performance/snapshot-acceptance-cost.ts
bun run typecheck
bun run test:protocol
```

`tests/integration/canopyd-merge/tool.test.ts` and `operations.test.ts` cover the process:
shared and fresh sidecars, concurrent staging, corrupt objects, malformed output, exits,
timeouts, refusals and answer checks. After every scenario in the source and snapshot
acceptance suites, `tests/support/replay-check.ts` asks each accepted entry's recorded
question again, from one warm cache across the history and from a cold one, and
requires the entry's root and decisions. `reference-sidecar.test.ts` runs canopyd's
rule-agnostic acceptance against the cache-free reference sidecar in test support.
`tests/unit/canopyd-merge/transfer-extensions.test.ts` runs every transfer rule in
both arrival orders, requires one answer from each (and from the eager reference),
and keeps a case where each proof fails; `source-acceptance.test.ts` repeats a list
item move and a same-anchor pair through canopyd with replay checks.
`tests/unit/canopyd-merge/history-differential.test.ts` compares every incremental result
against an eager reference that re-projects every state and enforces all history.

Ordinary plain list edits, including splitting, removing, and rearranging list
items, may merge with disjoint prose changes. This allowance checks the affected
lines and leaves protected Markdown scopes (headings, links, code, HTML, tables,
and reference syntax) under their existing format checks. It does not infer
source identity from matching rendered text.
