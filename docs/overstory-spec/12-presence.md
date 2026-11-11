# Presence

Presence tells the readers of a tree who else is there: which page each
person, or each person's agent, is on, and where their caret is when two of
them share a page. It is the one deliberately ephemeral exception to
"multiplayer state comes from the tree": presence is never part of a tree,
its history, a watch or a snapshot, and a host keeps none of it across
restarts. A reconnect starts over.

## 1. Model

A presence **entry** exists while its stream is open. Being subscribed is
being present: opening the stream joins and closing it leaves. There is no
heartbeat, time-to-live or resume cursor.

```ts
type PresenceID = string;   // opaque, unguessable, valid only for its stream

/** `path` is the page's canonical node path, such as `/Groceries`. */
type PresencePage = { path: LogicalPath; stableKey: string | null };

/** UTF-8 byte offsets into the text whose SHA-256 is `source`: a page's body,
 *  or a file's bytes. */
type PresenceSelection = { source: Hash; anchor: number; head: number };

type PresenceAgent = {
  label: string;           // the agent's name, at most 40 characters, one line
  status: string | null;   // at most 140 characters, one line
  run: string | null;      // the run it is doing (§6), if any
};

type PresencePeer = {
  id: PresenceID;
  profile: TreeID;         // the person's profile, or the agent's person's
  name: string | null;     // the host's display name for the profile, if it has one
  page: PresencePage | null;
  agent: PresenceAgent | null;   // null for a person
  device: "mac" | "ios" | null;  // what the client says it runs on, if it said
  runner: string | null;   // a runner's label (§6), at most 40 characters, one line
};
```

1. **One roster per tree.** A subscriber sees every listed entry of the tree
   and the page each is on.
2. **Visible by default.** A device that asks not to be shown subscribes with
   `visible=false`: it receives the roster but is not in it. A caller
   authenticated only by an access link, or not at all, may subscribe if it may
   read the tree, but is never listed.
3. **Agents.** A stream opened with `agent=<label>` is an agent's entry, listed
   under the caller's profile and always visible. Only an agent's entry has a
   status. One person on two devices, or with several agents, appears once per
   stream.
4. **The host names people; clients colour them.** `name` is the display name
   the host holds for the profile, or `null` (for example for a placement
   account whose profile is homed elsewhere). A client derives a stable colour
   from `profile`. A presence ID never reveals a device ID.
5. **Device kind.** A client may say what it runs on with `device=mac` or
   `device=ios` when it opens its stream; a host ignores any other value and
   lists the entry with `device: null`, as it does when the client doesn't say.
   The kind is a hint for showing the entry and says nothing about which
   device it is. A client should not rely on it for an agent's entry, and
   treats a missing member or a kind it doesn't know as `null`.

## 2. Cursors

A cursor is a byte range in a named source: the text the sender is showing, by
the SHA-256 of its bytes (a page's body without its properties, or a file's
bytes), which may be a local edit not yet accepted. For a file this is its
object hash; for a page it is not, since a page object also holds properties. A receiver
showing the same object places it exactly. A receiver showing another version
may approximate it within its own version, but must not present the
approximation as exact; if it cannot map it, it does not show it.

Cursors are reciprocal and page-local: a cursor event reaches only visible
subscribers on the sender's page, and a hidden subscriber receives none. A
client sends cursor updates only while the roster shows someone else on its
page. Changing page clears the entry's selection; a receiver drops a peer's
cursor when the peer's page changes.

## 3. Routes

```text
GET  /.overstory/trees/{TreeID}/presence[?visible=false][&agent=<label>][&device=<kind>][&runner=<label>]
POST /.overstory/trees/{TreeID}/presence/{PresenceID}
POST /.overstory/trees/{TreeID}/presence/{PresenceID}/messages
```

The GET is a stream with the shared framing
([tree operations §4.2](01-tree-operations.md#42-stream-framing-and-errors)),
with no `id` and no `after`. Its events, each `data` one JSON value:

| `event` | `data` | Sent |
| --- | --- | --- |
| `presence.ready` | `{ self: PresenceID \| null; peers: PresencePeer[] }` | First, once. `self` is the stream's own entry, listed or not, for a caller with an account (for updates and messages, §3 and §6), and null otherwise; `peers` excludes it. |
| `presence.peer` | `PresencePeer` | A listed entry joined, changed page, or (an agent) changed status. |
| `presence.cursor` | `{ id: PresenceID; selection: PresenceSelection \| null }` | Per §2. |
| `presence.leave` | `{ id: PresenceID }` | A listed entry's stream closed. |
| `presence.message` | `{ from: PresenceID; body: PresenceMessageBody }` | Per §6, only to the stream it names. |

A client rejects any other event. An agent stream requires an account; an
execution token may not open or change presence.

The POST body is a JSON object with any of `page`, `selection`, `status` and
`run`; an omitted member leaves its value unchanged, and an unknown member is
refused. `status` and `run` are accepted only on an agent's entry. The POST is accepted
only from the caller (account and device) that opened the stream, and only
while it is open; any other request, including one naming a page the caller
cannot read, is answered `404`, the same as a missing entry, so a presence ID
is not a credential. Success is `204`.

## 4. Access

Presence streams are admitted and kept as watches are
([access control §3.2](05-access-control.md#32-watches-and-revocation)): the
caller must be able to read the tree, the stream ends when that stops, and
an entry is never disclosed outside what a subscriber may read. Opening,
changing and leaving an entry is not an update and changes nothing in the
tree.

## 5. Bounds

- A client SHOULD send at most 4 cursor updates a second, coalescing to the
  latest.
- A host keeps only an entry's latest page, selection and status, and only
  the latest pending event about each peer for each subscriber; a subscriber
  that falls far behind MAY be closed, and starts over on reconnect.
- A host MAY refuse a POST body over 1 KiB (`413`) and MAY answer `429` to a
  stream that changes faster than it allows.
- A selection's offsets are integers from 0 to 2³²−1.
- A host MAY refuse a message body over 4 KiB (`413`).

## 6. Runners and messages

A person can have tasks run for them by an agent somewhere else: a Mac that
is awake, a cloud session, a server. Whatever runs a task is a **runner**,
and every runner receives the same request:

```ts
type RunRequest = {
  tree: string;                     // the tree's canonical URL
  page: PresencePage;
  task: { text: string; range: PresenceSelection | null };  // in the sender's source, if known
  run: string;                      // chosen by the sender: one line, no spaces, at most 64 characters
};

type PresenceMessageBody =
  | { kind: "run"; request: RunRequest }
  | { kind: "stop"; run: string }
  | { kind: "done"; run: string; result: string };
```

- **A present runner** is a person's visible stream opened with
  `runner=<label>`; the roster shows it with that label while it is open. A
  hidden stream or an agent's cannot be a runner (`400`).
- **Messages** pass between one person's own streams. The messages POST is
  made on the sender's own entry, with `{ to: PresenceID, body }`; the host
  delivers it as a `presence.message` frame to that stream only, and keeps
  nothing. A sender may be a hidden stream. A message to a stream that is not
  open, or that another profile opened, is answered `404`, as a missing entry
  is. Success is `204`. A runner that receives `run` starts an agent that
  reports the request's `run` in its entry; `stop` asks it to stop; `done` tells
  the sender the result. A client that cannot run tasks ignores `run`.
- **Other runners** receive a run request some other way, such as an HTTP
  POST; it is the same `RunRequest`.
- A host that serves this states `protocol` 2 or more in its health
  ([locators §5](03-locators.md#5-finding-trees)).
