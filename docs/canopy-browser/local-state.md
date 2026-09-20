# Canopy local state

What the Canopy app keeps on disk on macOS and iOS: working trees, the editor
recovery store, the admission journals, and diagnostic streams. The daemon's
data home is in [the Arbor data home](../arborsync/data-home.md).

## Native working trees

iOS keeps each placed tree as a durable working tree beneath the app's private
support directory, keyed by the percent-encoded `TreeID`:

```text
<Application Support>/Arbor/
  WorkingTrees/<key>/
    wire-format               # format marker the tree was placed under
    materialized/tree.json    # WorkingTreeState, schema 2
    control/heads.json        # materialized, accepted, and pending roots
    journals/pages/<key>/     # crash journal for in-flight page transactions
    indexes/search.json       # search and page-identity index, rebuildable
    objects/<hash>            # the overlay: this tree's own unaccepted objects
  Sync/<key>/
    sync/update-control.json  # UpdateControl, schema 2: attempt, durable head, hold, conflict
    sync/objects/<hash>       # head objects too large to carry inline
```

Schema 2 node records hold a content reference, inline bytes or a hash with
its size and media type, instead of raw bytes. Markdown source stays inline;
every other file is a hash resolved on demand through the layered object store
(`objects/` first, then canopyd), so whole-tree hashing touches only directories
and Markdown and the tree neither fetches nor retains every object. The state
files are not decoded leniently: an older layout is re-placed from canopyd
rather than migrated in place. The format marker is `4` (content references,
the `WorkingTrees/` layout, `update-control.json`); a phone placed under an
older marker re-places from canopyd on its next launch, which discards edits
canopyd has not accepted yet, so the phone is synchronized before the build
that carries the new marker is installed.

The Mac keeps no content store. The app opens a tree the daemon has placed as
an in-memory working tree seeded from `GET /v1/bootstrap` (the folder's
directories and Markdown, every other file by hash) with an in-memory overlay,
and its platform object store is the control-mode daemon's `/v1/objects` route
over the placed folder. Only the coordinator's durable update control is
written beneath the app's support directory:

```text
<Application Support>/Arbor/
  Native Placement.json       # the placed trees the app has opened; the selected one is restored at launch
  Visits.json                 # app-side visit history: origin, tree descriptor, locator, time
  WorkingTrees/<key>/
    sync/update-control.json  # UpdateControl: attempt (adopted or own), durable head, hold, conflict
    sync/objects/<hash>       # head objects too large to carry inline
```

The daemon's per-tree state, the folder itself, and the configuration checkout
stay under the data home; the app edits `~/.arbor/accounts/<cfg>/trees.yaml`
and `devices.yaml` on disk exactly as the CLI does and asks the daemon to
synchronize. The control-mode daemon is the only launchd process: the app
attaches to it or launches it, never a per-folder daemon. Visits are the app's
own: a remote tree opened by locator is a read-only in-memory working tree
following that tree's Overstory watch, anonymous unless an account at the same
origin holds a credential, with file bytes served by `/v1/objects?origin=`
when the daemon is running and by canopyd's object route otherwise.

## Editor recovery store

Before a committed editor generation enters the admission debounce, the Mac
app saves its exact source and exact accepted base in a device-local recovery
store at `<Application Support>/Arbor/EditorRecovery` (reached through the
`~/.arbor` support-directory symlink). Sources are SHA-256 addressed and
verified on read. Each document gets an identity-hashed directory: stable keys
follow moves within a tree, and identical keys in different trees stay
separate. `*.json` records reference exact UTF-8 `sources/*.md` objects. A
`*.saved` marker records local provider acknowledgment, not host acceptance.
Neither markers nor later versions delete older sources; the app's Local
History lists these copies and restores one as a new ordinary edit.

Recovery checkpoints begin at the editor commit callback, so a crash before
that callback and before lifecycle flush can still lose the last uncommitted
input. Disk failure can prevent both primary persistence and recovery and stays
visible. This store is device-local history, not the host's accepted history,
and Arbor Sync's filesystem journal is not a backup of unsubmitted editor text.
There is no automatic pruning; the store grows with every edited source version.

## Source admission journals

Each working tree keeps its admission journal at `sync/source-admissions.json`,
separate from update control and from editor recovery. The complete journal is
written to a private temporary file, fsynced, renamed, and its directory
fsynced before a write returns; Swift locks concurrent writers and TypeScript
serializes within the owning process. One process must own a state directory;
cross-process ownership is not enforced. Opening a corrupt journal fails
without rewriting it.

Journal schemas: 2 stores roots, ordered object hashes, and authored metadata;
3 stores the protocol element verbatim with a capture summary; 4 stores one
frame per record, reading a schema-3 flat operation list once as a single
frame and rewriting it. A fully settled journal of any schema retires without
decoding. The TypeScript publisher records settlements in
`sync/source-settlements.json`, written atomically only after the host has
durably installed the request. The Mac's conflict review keeps
`sync/conflict-review.json` (schema 2, also reading 1) with exact drafts,
pinned decision and alternative evidence, and an immutable prepared request.

Local update-control schema 3 is source mode; schema 2 is the legacy snapshot
mode. A source-disabled coordinator refuses to open schema 3, and a source-mode
journal cannot downgrade to snapshot mode.

Local Trash is absent from protocol snapshots. Structural records retain
private Trash nodes and their file objects so deletion survives another action
or a restart, and empty-Trash state is retained after a restore so older
records cannot resurrect it. Trashing emits one `removeEntry` per physical
entry; restore is an ordinary snapshot. The iOS replica store retains every
accepted object, so an older captured basis stays resolvable; no lifecycle
policy bounds that store yet.

## Diagnostic streams

Each document's `events.jsonl` records admission phase changes, generation,
draft ID, and time. Each working tree's `sync/events.jsonl` records persisted
sync state, head, generation, request digest, candidate and accepted roots,
and conflict and hold flags. The app's network log,
`<Application Support>/Arbor/Logs/network-YYYY-MM-DD.jsonl`, records one JSON
line per update POST, watch connect, disconnect and frame, and tree read; it
is also shown under Sync Status. Correlate it with the host's per-request log
line through the accepted update id. Object reads that go through the local
daemon do not appear in it. None of these streams contains authored source or
credentials, and successful saves do not erase them.
