# The provenance index

For each accepted entry, overstoryd keeps a **provenance index** beside it: which
node each path is, and which operation inserted each run of each text file's bytes.
A merge sidecar reads it instead of replaying history; line provenance reads it for
blame. This page is the whole format, version 1. It is a cache: derived from
accepted entries, never part of their hashes, deletable and recomputable at any
time. The semantics are implemented once, in
[`@ovst/protocol`'s provenance module](../../../packages/protocol/src/updates/provenance.ts),
and pinned by [conformance vectors](../../overstory-spec/conformance/provenance.json).

## What it says

- **Nodes.** Every entry of the root has a node identity that survives renames and
  moves. An entry imported with a root is named by the importing root's node id
  (`basis:<tree>:<root>` for a chain's first entry), then `/` and the URI-encoded
  name of each entry down to it. An entry an operation added is
  `["<change>","<operation key>"]` (JSON), its descendants continuing it as imported
  ones do. An entry a snapshot added is `snapshot:<change>:/<path>`.
- **Pieces.** A text file (a page: its body) is a list of pieces
  `[origin, start, length]`: `length` bytes that `origin` inserted, starting at
  `start` within everything `origin` inserted. The bytes are the file's at this root,
  in piece order. Adjacent pieces never continue one origin (`start + length` of one
  equal to `start` of the next); empty pieces never appear. An origin is the node
  id that imported the bytes, the operation that inserted them, or
  `snapshot:<change>:/<path>` for bytes a snapshot replaced.

## How it changes

From the previous entry's index:

- **A plain frame** (`editSource`, `moveSource`, `addEntry` over the frame's basis)
  applies its operations in order. Each states its material over the frame's basis;
  it is found in the current text by piece identity, never by equal bytes. An edit
  replaces its selection with `[op, 0, n]` for its `n` new bytes, keeping the
  basis pieces its lineage names. A move carries its pieces, origins unchanged.
- **A snapshot or property trace** keeps each node where the same path holds the
  same kind, keeps a text file's pieces where its bytes (a page: its body) are
  unchanged, and names anything else as a snapshot.
- **A sidecar's answer** carries the index of the root it answers with: the
  answer's `provenance` names its root record, and its records are among the
  answer's objects.

## How it is stored

Records are objects in the object store, canonical JSON, so an entry writes only
the records its edit changed and shares the rest, as roots do.

```ts
type Record =
  | { format: "overstory-provenance-v1"; node: string; kind: "directory"; entries: Array<[name: string, record: ObjectHash]> }
  | { format: "overstory-provenance-v1"; node: string; kind: "file" | "page"; chunks: ObjectHash[] }
  | { format: "overstory-provenance-v1"; node: string; kind: "tree" }
  | { format: "overstory-provenance-v1"; kind: "pieces"; pieces: Array<[origin: string, start: number, length: number]> };
```

Directory entries are in UTF-8 name order. A file's pieces are split into chunks
after each piece whose `sha256(origin + "\0" + start)` begins with five zero bits,
so an edit rewrites only the chunks it touches.

An entry's index is found by its hash: the file
`provenance/v1/<hex 0..2>/<hex 2..64>` beside `objects/` holds the hash of its root
record. overstoryd writes it, with the records, in the same batch as the entry.
Absent means not computed (an entry from before the index): a reader computes it
from the nearest earlier entry that has one, over the entries between. overstoryd
does this in the background from startup (`OVERSTORYD_PROVENANCE_FILL=0` turns it
off), rebinding an answered entry as a snapshot (asking the sidecar again would
hold the merge worker that live updates need). The object collector keeps the
records of every retained entry's index.
