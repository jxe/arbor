# Writing the execution sidecar

The execution sidecar runs authored views and mutations for overstoryd, the way the
[merge sidecar](writing-a-sidecar.md) decides merges: overstoryd asks it one kind of
question at a time, and everything else it touches is something that already exists.
That means the collection materializations overstoryd keeps, and the ordinary Overstory
API. This page is the whole boundary, decided with Joe on 2026-10-28 and built in
Apps 005 (its sidecar step, now removed from that plan). The
types are in [`@ovst/exec-protocol`](../../../packages/exec-protocol/src/index.ts); the
sidecar is [`@ovst/overstoryd-exec`](../../../packages/overstoryd-exec/src/sidecar.ts). A
host runs it only when `OVERSTORYD_ACTIVATIONS` names modules to run; otherwise the views
and mutate routes answer `unsupported-operation`. Portable contracts are in
[apps](../../overstory-spec/4.1-apps.md#24-data-disclosure)
and [access control](../../overstory-spec/3.2-access-control.md#11-execution-authority); execution tokens are overstoryd's own ([below](#execution-tokens)).

## Who owns what

**overstoryd** owns identity, activations and execution authority, and issues execution
tokens. It keeps the collection materializations: it builds each one, catches it up
after every accepted update and evicts idle ones. It reads activated modules' files from
retained objects (it only scans their imports). It holds the client's view stream and
decides when to re-ask. It never loads an evaluator, compiler, query engine or authored
JavaScript, and `@ovst/apps-runtime` is outside its dependency closure.

**The sidecar** owns the code: compiling it with Sucrase, view planning and evaluation,
dependency tracking, input validation and mutation handlers. It commits a mutation itself, as an ordinary guarded
update through the standard API, and keeps the mutation receipts.

Nothing else is shared. There is no HTTP forwarding, no sidecar-only endpoint on
overstoryd and no shared credential. For a mutation, the sidecar is a client of the
standard API with an execution token that lasts for one question. A view reads
the profiles it reaches the same way, with a token that lasts as long as its stream.

## What the sidecar touches

- `--materialized`: overstoryd's materialization directory, one
  `<tree>/<path>/_store.sqlite3` per collection in its schema's database layout. Each
  file's `__arbor_materialized` table names the accepted update it reflects. Views
  open it read-only. A mutation runs in a transaction on it that always rolls back.
- `--state`: the sidecar's own durable directory (`<dataRoot>/exec`), holding the
  receipts. It is backed up with the host's data. Compiled code goes under
  `compiled/`, which is a cache.
- `--activations`: the file overstoryd writes before the sidecar starts
  (`<dataRoot>/exec/activations.json`), naming each activated module's files under
  `<dataRoot>/exec/code/`.
- The standard Overstory API at `--host` (the host's loopback address), with the
  question's execution token: `POST /updates` to submit a mutation's update, the tree
  descriptor and objects to check where a moved head left the collection, and profile
  trees' descriptors and objects for the people a view reaches.

## Code from trees

An **activation** names a module the host runs: `{tree, path, root}`, where `root` is
the root object its code is read at. Until Apps 010 it is host configuration
(`OVERSTORYD_ACTIVATIONS`, a JSON file of them, or `serveHost({ collections: {
activations } })`), and the code runs with each caller's own authority.

- **overstoryd reads the files.** When the sidecar first starts, overstoryd reads each
  module and every file it imports, relative imports only, from objects at the pinned
  root. A relative import that leaves the tree, or a package other than `overstory/data`,
  `overstory/ui/jsx-runtime` and `zod`, refuses the activation. Page modules may also
  import `react` and `overstory/react`: on the host those load as inert stand-ins, so a
  module's views and mutations run there while its page components can't.
- **The code version** is SHA-256 over the graph's files, each named by logical path
  (`codeVersion` in `@ovst/exec-protocol`). Any copy of the tree with the same code has
  the same version, so a client can compute it. Handles are named by
  `{tree, path, name, version}`, the spec's `HandleRef`; another version of the same
  name is not active, and there is no fallback.
- **The sidecar compiles** each file with Sucrase (TypeScript and JSX, the automatic
  runtime from `overstory/ui`) and links its imports to the other files and to its own
  copies of the packages. Each module gets its own `overstory/data`, whose `node()`
  resolves a path from that module's logical path, so a helper imported from
  `scripts/views.ts` names `../data/List` from `scripts/`. A path that leaves the tree
  throws, and the module doesn't load.
- **Every export** that is a view or a mutation is a handle. The handshake lists each one
  with the logical paths its graph's `node()` calls named. overstoryd maps those to the
  one collection they name at the tree's head, either a directory with a schema or one of
  its tables, and passes that collection with each question.

**Declared views** need no activation: the built-in list view is the sidecar's own code
(`declaredView` in `@ovst/apps-runtime`). A handle whose path is a collection's
`schema.usl` names one of that schema's `~views` labels, and its version is the schema
file's object hash. overstoryd checks the version against the schema at the tree's head;
the sidecar checks it against the schema the materialization was built from, and answers
`not-found` for a label the schema doesn't declare. Its value is `presentView`'s lines and
groups, read through plans over the tables the entry reaches.

## The questions

The sidecar's first line is its handshake: the protocol version (2) and each view and
mutation it can run, with the logical paths its `node()` calls named. After that, one JSON object per line on stdin, with answers
on stdout. Each question has an `id`, and answers may come back out of order, matched
by `id`. overstoryd caps how many questions are in flight and sends `{"cancel": id}`
when a client goes away.

```ts
interface ExecHandleRef { tree: string; path: string; name: string; version: string }

interface ExecCollection {
  tree: string;
  path: string;       // the collection's path in its tree
  file: string;       // its materialization, relative to --materialized
  update: string;     // the accepted update the file must reflect
  directory: string;  // the collection directory object at that update
}

interface ExecViewQuestion {
  id: string; kind: "view";
  view: ExecHandleRef;
  input?: unknown;
  form?: "value" | "rows" | "tree";  // 07 §4.1
  missed?: ReadPath[];               // reads a client's run of a rows answer missed
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  token: string;      // reads profiles; lasts while the stream that asked is open
  knownOutputHash?: Hash;
}
type ExecViewAnswer =
  | { id; outputHash: Hash; value: unknown; shape?: ResultShape; reads: ExecReads }
  | { id; unchanged: true; reads: ExecReads }
  | { id; stale: true }
  | { id; refusal: { code; message; retryable } }
  | { id; error: { message; code?: "limit" | "unavailable" } };

interface ExecMutationQuestion {
  id: string; kind: "mutation";
  mutation: ExecHandleRef;
  mutationID: string;
  input?: unknown;
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  token: string;      // an execution token for this question only
  now: string;        // the logical time when the sidecar has no receipt yet
}
type ExecMutationAnswer =
  | { id; receipt: MutationResultReceipt }
  | { id; stale: true }
  | { id; refusal: { code; message; retryable } }
  | { id; error: { message; code?: "limit" | "unavailable" } };
```

- **Reading the right state.** The sidecar compares the file's recorded update with
  `update` before and after it reads. If the file has moved on, it answers `stale`, and
  overstoryd asks again with the newer update.
- **Answers.** A data view answers its value and shape. A JSX view answers the rows its
  plans read, for the client to run it (`rows`, its default), or its view tree run on the
  host (`tree`). A `rows` answer holds every row the plans read, including any a view's
  own check then leaves out; until row-level read rules exist
  ([Security 013](../../../plans/features/security-013-row-read-rules.md)), it is bounded only by
  what the caller can read in the tree.
- **People.** A view that reaches a person reads their profile tree through the
  standard API with the question's token: the descriptor names the root, and the root's
  `_index.md` declares the card (`readRootProfile` in `@ovst/protocol`). A tree the token
  cannot read, or one that declares no profile type, is no person. Objects are kept by hash,
  so a re-asked question reads only the descriptor again.
- **Live views.** `reads` names the collections and profiles the result depended on.
  When a catch-up changes one of those collections, or a profile tree it read changes,
  overstoryd re-asks with `knownOutputHash` and pushes a whole replacement value, or
  nothing. There is one question in flight per stream, and the latest state wins. A
  rebuilt file ends its streams with `reload`.
- **Mutations.** The sidecar looks up its receipt by tree, subject and `mutationID` and
  answers an exact retry from it. Otherwise it validates the input, runs the handler in
  the rolled-back transaction, and turns the captured row changes into row operations
  (spec 10 §4.1). It submits them to `POST /updates` with the token as a derived
  candidate. The change identity comes from the request digest, and the update is
  guarded by `ifCurrent` on `update`. If the head moved without changing the collection
  directory, the same operations go again on the new head; otherwise it answers
  `stale`. It writes the request as pending before submitting and the receipt once the
  host accepts. After a stop between the two, the retry resubmits the pending request,
  which the host answers from its own receipt without accepting it twice.
- **Refusals and errors** follow the merge sidecar: a refusal is the caller's answer
  (HTTP 400 with its code). An error, a dead sidecar or a missed deadline is a retryable
  503. overstoryd restarts a sidecar that exits, overruns its deadline or writes a line
  that isn't a well-formed answer, and fails every question in flight.

## Execution tokens

A host issues an opaque execution token to its trusted runtime through an
authenticated channel after checking activation and requirement coverage. The
token binds the actual caller/replay principal, executing source TreeID (matched
against `app`), pinned code and requirements, resolved resource bindings, and
each granted capability with its lender. It can refer
to authenticated claims or host-private records; its encoding and issuance transport
are implementation details, not authored data or a durable query-session protocol.

A grant names one tree, except a read grant over any tree, which a host may issue
when code cannot know in advance which trees it will read (the profiles a query
reaches, for example). Each read under it is checked at the tree read, as the
caller's own access with no lender. It never writes, never covers part of a tree,
and is never lent.

The runtime authenticates host calls with:

```http
POST /.overstory/trees/tr_notebook/updates
Authorization: Bearer <execution-token>
Content-Type: application/json
```

The body is an ordinary `UpdateRequest`, including its normal exact-state guard
when required. No lender, caller, `app`, or grant field in that body supplies
authority. Ordinary clients continue using device sessions. Execution tokens
also authenticate authorized resolution, object/read, receipt and watch requests;
a runtime cannot substitute a source-binding ID for a token.

The host verifies the token's issuer, validity and intended host, then checks current
policy and underlying authority within its bound requirements. Matching `who` /
`app` rules and lent grants authorize effects; a valid state guard checks concurrency independently.
Recheck at atomic acceptance and stored-receipt disclosure. Token possession does
not freeze ACLs, device/session validity or grants. Watches and direct-provider
execution use the revocation rules below; expiration or refresh cannot silently
broaden the pinned execution. Untrusted clients cannot mint execution context, and
authored code receives no raw token or general author/user credentials.

## What execution tokens may read and submit

A token's update is one guarded update, a snapshot or row operations only, with no
resolutions. Either way its effects are the paths that differ between the head and the
accepted root, each checked against the token's grants. Until Apps 005 step 1, a
mutation's token carries the caller's own authority for the tree, as the routes check
today.

A view stream's token has one grant, over any tree (`ANY_TREE` in
`execution-authority.ts`): it reads whatever the caller could read, checked at each read
at the tree it reads, because a view can't know whose profiles it will reach until it
runs. Such a grant reads only, covers whole trees, and is never lent. overstoryd issues
it when the stream first asks, issues another only when it has lapsed (ten minutes), and
revokes it when the stream ends.

## Keeping the files overstoryd's

After each mutation overstoryd reads `pragma data_version` on its own connection to the
file. If another connection committed to it, overstoryd logs the fault and rebuilds the
file from accepted state. The trial opens its store in a trial-only mode
(`SQLiteStoreBroker`'s `trialOnly`), so even its bookkeeping tables are temporary.

## Failure independence

The sidecar can only fail the views and mutate routes. Reads, watches, updates and
merges never touch it. Killing it mid-mutation either loses the computation or leaves a
submitted change whose retry the host recognizes. The next question starts a new
sidecar, and open streams pick it up when they next ask
(`tests/integration/host-collections.test.ts`).

## Provider bindings

A handle's `node()` sources bind to collections in its own tree, as overstoryd names them
in `collections`, by logical path. Never to a caller-supplied filename, DSN or the current directory, and no
paths or private schemas escape in answers. Code version, binding version and data
observation are independent: a schema or binding change invalidates a compiled plan, and
a row change only reruns it. External providers (Postgres, an operator's own SQLite) are
not part of this boundary yet. Adding one gives the sidecar I/O of its own and needs its
own decision.

## Not here

Serving documents, assets and actions (Apps 001 and 003), external providers, and running
the sidecar on another machine are later additions, each decided separately.
