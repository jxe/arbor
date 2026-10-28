# Writing the execution sidecar

The execution sidecar runs authored queries and mutations for overstoryd, the way the
[merge sidecar](writing-a-sidecar.md) decides merges: overstoryd asks it one kind of
question at a time, and everything else it touches is something that already exists.
That means the collection materializations overstoryd keeps, and the ordinary Overstory
API. This page is the whole boundary, decided with Joe on 2026-10-28 and built in
[Apps 005](../../../plans/soon/apps-005-source-resolution-and-sidecar.md) step 4. The
types are in [`@ovst/exec-protocol`](../../../packages/exec-protocol/src/index.ts); the
sidecar is [`@ovst/overstoryd-exec`](../../../packages/overstoryd-exec/src/sidecar.ts). It
is not deployed: the deployed host passes no `collections`. Portable contracts are in
[executable documents](../../overstory-spec/07-executable-documents.md#8-host-and-server-boundaries)
and [execution tokens](../../overstory-spec/05-access-control.md#21-execution-tokens).

## Who owns what

**overstoryd** owns identity, activations and execution authority, and issues execution
tokens. It keeps the collection materializations: it builds each one, catches it up
after every accepted update and evicts idle ones. It holds the client's query stream and
decides when to re-ask. It never loads an evaluator, compiler, query engine or authored
JavaScript, and `@ovst/apps-runtime` is outside its dependency closure.

**The sidecar** owns the code: query planning and evaluation, dependency tracking, input
validation and mutation handlers. It commits a mutation itself, as an ordinary guarded
update through the standard API, and keeps the mutation receipts.

Nothing else is shared. There is no HTTP forwarding, no sidecar-only endpoint on
overstoryd and no shared credential. For a mutation, the sidecar is a client of the
standard API with an execution token that lasts for one question. A query reads
the profiles it reaches the same way, with a token that lasts as long as its stream.

## What the sidecar touches

- `--materialized`: overstoryd's materialization directory, one
  `<tree>/<path>/_store.sqlite3` per collection in its schema's database layout. Each
  file's `__arbor_materialized` table names the accepted update it reflects. Queries
  open it read-only. A mutation runs in a transaction on it that always rolls back.
- `--state`: the sidecar's own durable directory (`<dataRoot>/exec`), holding the
  receipts. It is backed up with the host's data.
- The standard Overstory API at `--host` (the host's loopback address), with the
  question's execution token: `POST /updates` to submit a mutation's update, the tree
  descriptor and objects to check where a moved head left the collection, and profile
  trees' descriptors and objects for the people a query reaches.

Before Apps 005 step 2, the code is the operator's: the sidecar starts with
`--handles <module>`, a module exporting `queries` and `mutations` as
`{ ref, handle, collection, authoredRoot }`, named in
`serveHost({ collections: { handles } })`. After step 2, a question names the code by
tree, path, export, version and pinned root, and the sidecar loads it from objects.

## The questions

The sidecar's first line is its handshake: the protocol version and each query and
mutation it can run, with the collection path it reads and the `node()` path its code
names that collection by. After that, one JSON object per line on stdin, with answers
on stdout. Each question has an `id`, and answers may come back out of order, matched
by `id`. overstoryd caps how many questions are in flight and sends `{"cancel": id}`
when a client goes away.

```ts
interface ExecCollection {
  authored: string;   // the node() path the code names, such as "./data"
  tree: string;
  path: string;       // the collection's path in its tree
  file: string;       // its materialization, relative to --materialized
  update: string;     // the accepted update the file must reflect
  directory: string;  // the collection directory object at that update
}

interface ExecQueryQuestion {
  id: string; kind: "query";
  query: { module: string; export: string; version: string };
  input?: unknown;
  viewer: { profile: string } | null;
  collections: ExecCollection[];
  token: string;      // reads profiles; lasts while the stream that asked is open
  knownOutputHash?: Hash;
}
type ExecQueryAnswer =
  | { id; outputHash: Hash; value: unknown; reads: ExecReads }
  | { id; unchanged: true; reads: ExecReads }
  | { id; stale: true }
  | { id; refusal: { code; message; retryable } }
  | { id; error: { message; code?: "limit" | "unavailable" } };

interface ExecMutationQuestion {
  id: string; kind: "mutation";
  tree: string;
  mutation: { module: string; export: string; version: string };
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
- **People.** A query that reaches a person reads their profile tree through the
  standard API with the question's token: the descriptor names the root, and the root's
  `_index.md` declares the card (`readRootProfile` in `@ovst/protocol`). A tree the token
  cannot read, or one that declares no profile type, is no person. Objects are kept by hash,
  so a re-asked question reads only the descriptor again.
- **Live queries.** `reads` names the collections and profiles the result depended on.
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

## What execution tokens may read and submit

A token's update is one guarded update, a snapshot or row operations only, with no
resolutions. Either way its effects are the paths that differ between the head and the
accepted root, each checked against the token's grants. Until Apps 005 step 1, a
mutation's token carries the caller's own authority for the tree, as the routes check
today.

A query stream's token has one grant, over any tree (`ANY_TREE` in
`execution-authority.ts`): it reads whatever the caller could read, checked at each read
at the tree it reads, because a query can't know whose profiles it will reach until it
runs. Such a grant reads only, covers whole trees, and is never lent. overstoryd issues
it when the stream first asks, issues another only when it has lapsed (ten minutes), and
revokes it when the stream ends.

## Keeping the files overstoryd's

After each mutation overstoryd reads `pragma data_version` on its own connection to the
file. If another connection committed to it, overstoryd logs the fault and rebuilds the
file from accepted state. The trial opens its store in a trial-only mode
(`SQLiteStoreBroker`'s `trialOnly`), so even its bookkeeping tables are temporary.

## Failure independence

The sidecar can only fail the query and mutate routes. Reads, watches, updates and
merges never touch it. Killing it mid-mutation either loses the computation or leaves a
submitted change whose retry the host recognizes. The next question starts a new
sidecar, and open streams pick it up when they next ask
(`tests/integration/host-collections.test.ts`).

## Provider bindings

A handle's `node()` sources bind to collections in its tree, as overstoryd names them in
`collections`. Never to a caller-supplied filename, DSN or the current directory, and no
paths or private schemas escape in answers. Code version, binding version and data
observation are independent: a schema or binding change invalidates a compiled plan, and
a row change only reruns it. External providers (Postgres, an operator's own SQLite) are
not part of this boundary yet. Adding one gives the sidecar I/O of its own and needs its
own decision.

## Not here

Serving documents, assets and actions (Apps 001 and 003), external providers, and running
the sidecar on another machine are later additions, each decided separately.
