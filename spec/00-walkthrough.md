# Walkthrough
*Part of the [Arbor spec](../spec.md): a non-normative tour of one account's first day. Nothing here adds a requirement; every step links to the section that defines it.*

Joe runs a Canopy for `garden.example` and wants to publish a folder of notes,
let Alice follow it from her own laptop, add a small database to it, and put a
page in front of that database. Each step below is one specification concept
meeting the previous one.

## 1. Claim a profile

The Canopy reserves the handle `joe`. Joe's laptop generates a profile `TreeID`,
an account-configuration `TreeID`, a `DeviceID`, and a raw device credential
that never leaves the machine. It sends `PUT /.arbor/claims/joe` with the
credential's digest, an initial profile snapshot whose root document says
`type: person`, and a complete initial configuration snapshot: `account.yaml`,
`trees.yaml`, and `devices/<DeviceID>.yaml`. The server creates all of it in
one transaction and makes the laptop the first administrator
([accounts §1.1](05-accounts-and-devices.md#11-profile-claim), [profiles](05-accounts-and-devices.md#1-accounts-and-profiles),
[configuration graph](05-accounts-and-devices.md#2-configuration-graph)).

## 2. Declare a tree

Joe has an ordinary folder, `~/projects/atlas`. The laptop generates a fresh
`tr_…` identifier, adds it to `trees.yaml` with `canonicalPath: "/~joe/atlas"`
and an `everyone: read` rule, and adds a placement pointing at the folder to
its own device file. It submits the changed configuration tree as a candidate
against the last accepted configuration update. The server validates the
candidate under the `account-config-v1` policy and reserves the tree; nothing
is readable yet ([configuration YAML](05-accounts-and-devices.md#3-configuration-yaml),
[accounts §6](05-accounts-and-devices.md#6-governed-account-tree),
[accounts §5](05-accounts-and-devices.md#5-declaring-and-activating-a-tree)).

## 3. Activate it

The laptop encodes the folder as Wire objects: one file object per file, one
directory object per directory, each addressed by the SHA-256 of its canonical
CBOR. It sends `POST /.arbor/trees/tr_…/updates` with `base: null`, the root
hash as `candidate`, and every object. The server verifies the graph, records
the first accepted update, applies the declared ACL and canonical boundary,
marks the tree active, and emits `tree.activation` on the configuration tree.
`https://garden.example/~joe/atlas` and `arbor://tr_…/` now resolve to the
same tree ([object graph §1.4](01-tree-operations.md#14-interpreting-the-object-graph),
[locator forms](04-locators.md#1-forms), [canonical lookup](04-locators.md#5-finding-trees)).

## 4. Edit a file

Joe edits `notes.md`. Because `notes.md` supplies the body of the node `/notes`
and a sibling `notes/` would supply its children, the edit touches one node
([mapping](03-directory-format.md#2-mapping-files-and-directories-to-nodes)).
The laptop builds the new candidate root: a new file object, and new directory
objects from `notes.md` up to the root. It sends the file as an `ObjectDelta`
against the previous file object and the small directory objects in full,
with `base` set to the accepted update id it last observed and
`ifMatch: "modelHash"`. The server finds current equal to base and answers
`201 accepted` with the new update's id and the request digest ([sparse transfer](01-tree-operations.md#26-sparse-transfer-with-object-deltas),
[submit](01-tree-operations.md#21-the-update-request)). The root that changed is a bytes hash; the model hash of every node Joe did
not touch is unchanged
([revisions](01-tree-operations.md#15-equality-after-a-read)).

## 5. Follow from a second device

Alice reads `GET /.arbor/trees/tr_…`, which returns the current descriptor and an
`observedThrough` cursor, then opens `GET .../watch?after=<cursor>`. Every
later accepted update arrives as a `tree.update` frame carrying the transition
from the previous root to the new one, as objects and deltas. She applies a
batch in memory and materializes only its final state
([read](01-tree-operations.md#11-reading-the-current-tree), [watch](01-tree-operations.md#31-the-watch-endpoint-and-event-values)).
If Alice has write access and edits a different file from the same base, her
submission's model hashes still match and the server merges it onto Joe's.
If both edit `notes.md`, that node conflicts; under the default
`onConflict: "merge"` the `markdown-additive-v1` merge rule combines the two
edits when it can, and otherwise the server answers `409 conflict` with the
current update and a complete draft the client keeps
([authority decision](01-tree-operations.md#23-the-authority-decision)).

## 6. Add a collection

Joe creates `practices/schema.ts` exporting a Zod object schema and
`primaryKey = ["id"]`, and `practices/_store.csv` with a header row. The
folder is now a file-backed collection: each CSV row is a child node of
`/practices`, its columns are the child's properties, and its stable key is
the canonical key JSON of its `id` ([file-backed collections](07-child-backings.md#2-file-backed-collections),
[row identity](07-child-backings.md#12-member-identity-order-and-pagination)). In the Wire encoding,
the exact CSV and `schema.ts` remain ordinary physical entries while the
directory's collection-file descriptor identifies them as the source of its
logical children. The authority recomputes both the schema fingerprint and the
child-set hash
([object graph §1.4](01-tree-operations.md#14-interpreting-the-object-graph)).
Each row has an ordinary public address such as
`/~joe/atlas/practices/walking;arbor-key=…` ([public projection](04-locators.md#6-public-http-projection)).

## 7. Query it from a page

Joe writes `Practices.mdx` importing a handle from `handles.ts`:

```ts
import { arbor, query } from "arbor/data"

const practices = arbor("./practices").children

export const publishedPractices = query.many(practices, practice => ({
  where: practice.published.eq(true),
  select: practice.pick("id", "title"),
}))
```

The server has enabled hosting for the tree, so compilation produces a
manifest that binds the handle to `(tr_…, /practices, schema fingerprint)` and
records its read prefix ([handles](08-executable-documents.md#3-modules-and-named-handles),
[queries](08-executable-documents.md#4-queries), [compilation](08-executable-documents.md#7-compilation-and-hosting)).
A visitor's browser receives the server-rendered page with the query's result
embedded, then opens `QUERY /.arbor/trees/tr_…/queries` naming the document
version and the handle. The stream sends `result` and `ready`. When Joe edits
the CSV, the tree advances, the provider reports which rows changed, the host
re-evaluates, and a new `result` with a new `outputHash` follows
([executable documents §12.1](08-executable-documents.md#121-evaluate-and-stream-named-queries), [authoring API](09-authoring-api.md)).

## 8. Run a mutation

`handles.ts` also exports `addPractice = mutation(arbor("."), inputSchema, async ({ tx, user }, input) => …)`.
A form on the page calls it as an action. The browser sends
`POST /.arbor/trees/tr_…/mutate` with the handle reference, validated input,
and a caller-chosen `mutationID`. The runner opens the CSV's whole-file
transaction, validates keys and constraints, writes a complete replacement,
and records the receipt with the same durability as the data. Because the
mutation changed an Arbor-canonical tree, the receipt's `affected` names the
new accepted update, and Alice's watch sees an ordinary `tree.update` frame. A
retry with the same `mutationID` returns the original receipt and does nothing
twice ([mutations](08-executable-documents.md#5-mutations),
[executable documents §12.2](08-executable-documents.md#122-execute-named-mutations), [actions](09-authoring-api.md#4-actions-and-forms)).

## 9. Rename the canonical path

Joe changes `canonicalPath` to `/~joe/atlas-2026` in `trees.yaml`. The
`TreeID`, every stable key, every object, and the accepted history are
unchanged; only the secondary lookup moved. `arbor://tr_…/practices/walking;arbor-key=…`
still resolves, and Alice's placement keeps following the same tree
([canonical lookup](04-locators.md#5-finding-trees), [revisions](01-tree-operations.md#15-equality-after-a-read)).
