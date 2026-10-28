# Writing the execution sidecar

The execution sidecar runs authored queries and mutations for overstoryd, the way the
[merge sidecar](writing-a-sidecar.md) decides merges: overstoryd asks it one kind of
question at a time, and everything else it touches is something that already exists.
That means the collection materializations overstoryd keeps, and the ordinary Overstory
API. This page is the target boundary, decided with Joe on 2026-10-28;
[Apps 005](../../../plans/soon/apps-005-source-resolution-and-sidecar.md) builds it. It
is not deployed. Portable contracts are in
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
overstoryd and no shared credential. The sidecar is a client of the standard API with a
token that lasts for one question.

## What the sidecar touches

- `--materialized`: overstoryd's materialization directory, one
  `<tree>/<path>/_store.sqlite3` per collection in its schema's database layout. Each
  file's `__arbor_materialized` table names the accepted update it reflects. Queries
  open it read-only. A mutation runs in a transaction on it that always rolls back.
- `--state`: the sidecar's own durable directory, holding the receipts. It is backed up
  with the host's data.
- `--cache`: anything the sidecar likes, such as compiled plans. overstoryd never reads
  it and may delete it, and nothing there may change an answer.
- The standard Overstory API, with the question's execution token. It's used for
  profiles, Markdown folders, other trees, and submitting a mutation's update.

overstoryd checks that the sidecar keeps its side of the file contract. After each
mutation it reads `pragma data_version` on its own connection. If another connection
committed to the file, overstoryd rebuilds it from accepted state and logs the fault.

Before Apps 005 step 2, the code is the operator's: the sidecar starts with
`--handles <module>`, in place of today's `serveHost({ collections })`. After step 2, a
question names the code by tree, path, export, version and pinned root, and the sidecar
loads it from objects.

## The questions

One JSON object per line on stdin, with answers on stdout. Each question has an `id`,
and answers may come back out of order, matched by `id`. overstoryd caps how many
questions are in flight and sends `{"cancel": id}` when a client goes away.

```ts
interface Collection {
  authored: string;   // the node() path the code names, such as "./data"
  tree: string;
  path: string;       // the collection's path in its tree
  file: string;       // its materialization, relative to --materialized
  update: string;     // the accepted update the file must reflect
}

interface QueryQuestion {
  id: string;
  query: { module: string; export: string; version: string };
  input: unknown;
  viewer: { profile: string } | null;
  collections: Collection[];
  token: string;
  knownOutputHash?: Hash;
}
type QueryAnswer =
  | { id: string; outputHash: Hash; value: unknown; reads: Dependency[] }
  | { id: string; unchanged: true; reads: Dependency[] }
  | { id: string; stale: true }
  | { id: string; refusal: PublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };

interface MutationQuestion {
  id: string;
  mutation: { module: string; export: string; version: string };
  mutationID: string;
  input: unknown;
  viewer: { profile: string } | null;
  collections: Collection[];
  token: string;
  now: string;        // the logical time when the sidecar has no receipt yet
}
type MutationAnswer =
  | { id: string; receipt: MutationResultReceipt }
  | { id: string; stale: true }
  | { id: string; refusal: PublicError }
  | { id: string; error: { message: string; code?: "limit" | "unavailable" } };
```

- **Reading the right state.** The sidecar opens a transaction and compares the file's
  recorded update with `update`. If the file has moved on, it answers `stale`, and
  overstoryd asks again with the newer update.
- **Live queries.** `reads` names the collections, paths and profiles the result
  depended on. After an accepted update that touches one of them, overstoryd re-asks
  with `knownOutputHash` and pushes a whole replacement value, or nothing. There is one
  question in flight per stream, and the latest state wins. When access changes,
  overstoryd ends the stream itself.
- **Mutations.** The sidecar first looks up its receipt by tree, subject and
  `mutationID`, and answers an exact retry from it. Otherwise it validates the input,
  runs the handler in the rolled-back transaction, and turns the captured row changes
  into row operations (spec 10 §4.1). It submits them to `POST /updates` with the token
  as a derived candidate. The change identity comes from the request digest, and the
  update is guarded on the collection as of `update`. It writes the receipt once the
  host accepts. A lost response is recovered the ordinary way, by resubmitting the same
  change, which the host recognizes. If the guard fails because the collection moved,
  the sidecar answers `stale`. The logical time is fixed in a pending receipt before
  the first submission, so an exact retry sees the same time and the same generated
  IDs.
- **Refusals and errors** follow the merge sidecar: a refusal is the caller's answer.
  An error with code `limit` or `unavailable` becomes a retryable 503. overstoryd
  restarts a sidecar that exits, overruns its deadline or writes a line that isn't a
  well-formed answer, and answers every question in flight with a retryable 503.

## Failure independence

The sidecar can only fail the query and mutate routes. Reads, watches, updates and
merges never touch it. Killing it mid-mutation either loses the computation or leaves a
submitted change whose retry the host recognizes.

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
