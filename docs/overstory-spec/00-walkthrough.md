# Walkthrough
*Part of the [Overstory spec](README.md): a non-normative tour of one account's first day. Nothing here adds a requirement; every step links to the section that defines it.*

Joe runs a host for `garden.example` and wants to publish a folder of notes,
let Alice follow it from her own laptop, add a small database to it, and put a
page in front of that database. Each step below is one specification concept
meeting the previous one.

## 1. Create a profile identity and claim an account

Joe runs `story me create`. Overstory creates a local profile folder whose root
document says `type: person`, generates an Ed25519 identity key in operating-
system credential storage, and derives the profile `TreeID` from the public
key. The identity exists before any host account or canonical URL. Because
Joe founded Garden, its bootstrap configuration records his public profile
TreeID and `handle: joe` together. For a community he did not found, Joe would
send the same public TreeID to its administrator, who would add that exact pair
to the structured members list.

The laptop asks for an account challenge, which binds the account, his profile
`TreeID` and the configuration `TreeID` derived from it, and signs it with the
profile private key. It generates a `DeviceID` and a device key pair whose
private key never leaves the machine. It sends `PUT /.overstory/accounts` with
the signed challenge, the profile's public key and signature, the device and
its public key, and the first snapshot of the profile's tree configuration: `access.yaml` granting his profile `admin` and everyone
`read`, empty `mounts.yaml` and `apps.yaml`, and `devices.yaml` marking the
laptop, with its key, as the first administrator device. The server derives the reserved
Profile TreeID from the supplied public key, verifies the target-bound
signature locally, and in one transaction creates the account and the
configuration and declares the profile tree. It receives no profile bytes yet
([accounts and devices §1.1–1.2](3.1-accounts-and-devices.md#11-beginning-a-person-identity), [profiles and accounts](3.1-accounts-and-devices.md#1-profiles-and-host-accounts),
[configuration graph](3.1-accounts-and-devices.md#2-tree-configuration-graph)).

## 2. Declare a tree

Joe activates his profile tree with the ordinary `base: null` update described
below. Garden mounts each claimed member's profile at `/~handle`, so the local
identity now has the canonical URL `https://garden.example/~joe`.

Joe also has an ordinary folder, `~/projects/atlas`. The laptop generates a fresh
`tr_…` identifier and declares it: it submits the new tree's configuration
(`access.yaml` granting Joe's profile `admin` and everyone `read`) with
`base: null` to `/.overstory/trees/tr_…;overstory-config/updates`. It then adds
`atlas: tr_…` to his profile's `mounts.yaml`, and records the local folder
as a placement on his laptop, which never reaches the host. The server validates each candidate
under the `tree-config-v1` policy and reserves the tree; nothing is readable
yet ([configuration YAML](3.1-accounts-and-devices.md#3-configuration-yaml),
[accounts and devices §6](3.1-accounts-and-devices.md#6-governed-configuration-trees),
[accounts and devices §5](3.1-accounts-and-devices.md#5-declaring-activating-and-mounting-a-tree)).

## 3. Activate it

The laptop encodes the folder as Overstory objects: one file object per file, one
directory object per directory, each addressed by the SHA-256 of its canonical
CBOR. It sends `POST /.overstory/trees/tr_…/updates` with `base: null` and a
one-element `updates` string carrying the root hash as `candidate` and every
object. The server verifies the graph, records
the first accepted update, applies the declared ACL and canonical boundary,
and makes the tree's descriptor and accepted snapshot readable in the same
commit.
`https://garden.example/~joe/atlas` and `overstory://tr_…/` now resolve to the
same tree ([snapshot](1.2-reading-and-watching.md#112-reading-an-accepted-snapshot),
[locator forms](1.6-locators.md#1-forms), [canonical lookup](1.6-locators.md#5-finding-trees)).

## 4. Edit a file

Joe edits `notes.md`. Because `notes.md` supplies the body of the node `/notes`
and a sibling `notes/` would supply its children, the edit touches one node
([mapping](1.1-data-model.md#8-mapping-files-and-directories-to-nodes)).
The laptop builds the new candidate root: a new file object, and new directory
objects from `notes.md` up to the root. It sends the file as an `ObjectDelta`
against the previous file object and the small directory objects in full,
with `base` set to the accepted update id it last observed, a fresh `change`
and `at`, and no trace (a snapshot). The server finds current equal to base and answers
`201 accepted` with the new update's id and the request digest ([sparse transfer](1.3-updates-and-merging.md#13-sparse-transfer-with-object-deltas),
[submit](1.3-updates-and-merging.md#1-the-update-request)). The root that changed is a bytes hash; the model hash of every node Joe did
not touch is unchanged
([equality](1.1-data-model.md#4-representation-and-model-equality)).

## 5. Follow from a second device

Alice reads `GET /.overstory/trees/tr_…`, which returns the current descriptor with
its accepted `update`, then opens `GET .../watch?after=<update>`. Every
later accepted update arrives as a `tree.update` frame carrying the transition
from the previous root to the new one, as objects and deltas. She applies a
batch in memory and materializes only its final state
([read](1.2-reading-and-watching.md#1-reading-trees), [watch](1.2-reading-and-watching.md#113-watching)).
If Alice has write access and edits a different file from the same base, her
independent contribution merges onto Joe's.
If both edit `notes.md`, applicable format-aware rules combine the edits when
justified; otherwise the server retains representable alternatives in accepted
state. That unresolved acceptance continues syncing. Invalid contributions,
failed guards or exceeded bounds can instead produce an explicit rejection
([authority decision](1.3-updates-and-merging.md#32-the-acceptance-procedure)).

## 6. Add a collection

Joe creates `practices/schema.usl` declaring a `Practice` model, and
`practices/_store.csv` with a header row. The
folder is now a collection: each CSV row is a child node of
`/practices`, its fields are the child's properties, and its stable key is
the canonical key JSON of its `id` ([collections](1.4-collections.md),
[row identity](1.4-collections.md#3-row-identity-and-order)). The CSV is only
how Joe's Mac projects the rows: the tree holds the rows themselves, in
canonical form, beside the exact bytes of `schema.usl`, and his iPhone keeps
the same rows in SQLite. Story Sync turns each edit to the CSV into row
operations, and the authority replays them and recomputes the model
fingerprint and the collection's logical hash
([what the tree holds](1.4-collections.md#1-what-the-tree-holds)).
Each row has an ordinary public address such as
`/~joe/atlas/practices/walking;overstory-key=…` ([reading at the canonical URL](1.6-locators.md#6-reading-at-the-canonical-url)).

## 7. Show it on a page

Joe writes a view in `views/practices.view`, which is the node `views/practices`
the way a `.md` file is a page:

```
use "../practices/schema.usl"

view():
  <Column>
    <Link to="practices/{p.id}" for={p in Practice} where={p.published}>{p.title}</Link>
  </Column>
```

and draws it in his page with a view block ([view blocks](4.1-apps-and-views.md#157-view-blocks-in-pages)):

````md
```view
use "views/practices.view" as Practices
<Practices />
```
````

The server has enabled hosting for the tree, so it checks the file and binds
`Practice` to `(tr_…, /practices, model fingerprint)` ([files and handles](4.1-apps-and-views.md#3-files-and-named-handles)).
The plan comes from the source alone: the `Link` expands once per published
practice ([expansion](4.1-apps-and-views.md#43-expansion), [the language](4.1-apps-and-views.md#15-the-language)).
A visitor's browser receives the page with the view drawn as HTML. Story opens
`QUERY /.overstory/trees/tr_…/views` naming the view's handle and code version,
receives the plan's rows as `result`, then `ready`, and draws the view natively.
When Joe edits the CSV, the tree advances, the host sees which rows the plan
read changed, and a new `result` with a new `outputHash` follows
([apps and views §12.1](4.1-apps-and-views.md#121-evaluate-and-stream-views)).

## 8. Run a mutation

The same file declares a mutation:

```
mutation addPractice(title: Text):
  require me != null else user-required
  require title != "" else invalid-input "A practice needs a title"
  insert Practice { title: title, published: false }
```

A form on the page names it as its action, `<Form action={addPractice}>`.
The browser sends `POST /.overstory/trees/tr_…/mutate` with the handle, the input, and a
caller-chosen `mutationID`. The runtime checks the guards, then submits the
insert as one guarded update of row operations. The receipt's `affected` names
that accepted update, and Alice's watch sees an ordinary `tree.update` frame;
Joe's Mac rewrites the CSV. A retry with the same `mutationID` returns the
original receipt and does nothing twice ([mutations](4.1-apps-and-views.md#5-mutations),
[apps and views §12.2](4.1-apps-and-views.md#122-execute-named-mutations), [actions](4.1-apps-and-views.md#154-actions-forms-and-events)).

## 9. Rename the canonical URL

Joe renames the mount `atlas` to `atlas-2026` in his profile's `mounts.yaml`,
moving the canonical URL to `https://garden.example/~joe/atlas-2026`. The
`TreeID`, every stable key, every object, and the accepted history are
unchanged; only the secondary lookup moved. `overstory://tr_…/practices/walking;overstory-key=…`
still resolves, and Alice's placement keeps following the same tree
([canonical lookup](1.6-locators.md#5-finding-trees), [equality](1.1-data-model.md#4-representation-and-model-equality)).
