/** The provenance index's piece semantics (Performance 004 step 2): hand-checked
 * cases, the conformance vectors other implementations check themselves
 * against, and agreement with the merge engine on every case. Regenerate the
 * vectors with UPDATE_VECTORS=1. */
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  advanceProvenance, decodeProvenanceRecord, encodeProtocolDirectory, encodeProvenance, readProvenance, encodeProtocolPage, hashObject, importProvenance, normalizePieces,
  rebindProvenance, stableJSONString, type ObjectHash, type ProtocolDirectoryEntry, type ProvenanceNode, type SourceOperation,
} from "@ovst/protocol";
import { encodeLogEntry, LOG_ENTRY_FORMAT } from "@ovst/merge-protocol";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import { viewState } from "../../../packages/overstoryd-merge/src/retained-state.ts";
import type { Node } from "../../../packages/overstoryd-merge/src/intent-model.ts";

const VECTORS = join(import.meta.dir, "../../../docs/overstory-spec/conformance/provenance.json");
const TREE = "tr_vectors";

// ---- A small tree language: a file is a string, a page { page: body }, a folder an object.
type Spec = string | { page: string } | { [name: string]: Spec };
const isPage = (s: Spec): s is { page: string } => typeof s === "object" && "page" in s && typeof s.page === "string";
class Objects {
  map = new Map<string, Uint8Array>();
  put(bytes: Uint8Array) { const h = hashObject(bytes); this.map.set(h, bytes); return h; }
  build(spec: Spec): string {
    if (typeof spec === "string") return this.put(new TextEncoder().encode(spec));
    if (isPage(spec)) return this.put(encodeProtocolPage({ type: "page", properties: [], body: new TextEncoder().encode(spec.page) }));
    const entries: ProtocolDirectoryEntry[] = Object.entries(spec).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, child]) =>
      typeof child === "string" ? { name, file: this.build(child), created: 0, modified: 0 } : isPage(child) ? { name, page: this.build(child), created: 0, modified: 0 } : { name, directory: this.build(child) });
    return this.put(encodeProtocolDirectory({ type: "directory", entries }));
  }
  load = async (hash: string) => this.map.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
}
/** The object at `path` (`/a/b.md`) in a spec built by `objects`. */
const objectAt = (objects: Objects, spec: Spec, path: string): string => {
  let node = spec;
  for (const part of path.split("/").filter(Boolean)) node = (node as Record<string, Spec>)[part]!;
  return objects.build(node);
};

interface Case {
  name: string;
  before: Spec;
  /** Each frame: operations written with paths; objects are filled in from the frame's tree. */
  frames?: Array<{ after: Spec; operations: Array<Record<string, unknown>> }>;
  /** A snapshot accepted onto `before`. */
  snapshot?: Spec;
  /** Expected pieces of some files, hand-checked: [origin, start, length]. */
  expect?: Record<string, Array<[string, number, number]>>;
}
const op = (o: string) => JSON.stringify(["c", o]);
const imp = (path: string) => `basis:${TREE}:ROOT${path}`;
const cases: Case[] = [
  { name: "import", before: { "a.md": "hello", "e.md": "", p: { "q.md": { page: "body" } } },
    expect: { "/a.md": [[imp("/a.md"), 0, 5]], "/e.md": [], "/p/q.md": [[imp("/p/q.md"), 0, 4]] } },
  { name: "replace in the middle", before: { "a.md": "hello world" },
    frames: [{ after: { "a.md": "hello there" }, operations: [{ key: "e", kind: "editSource", source: { path: "/a.md", range: [6, 11] }, text: "there" }] }],
    expect: { "/a.md": [[imp("/a.md"), 0, 6], [op("e"), 0, 5]] } },
  { name: "insert at start, middle and end", before: { "a.md": "abc" },
    frames: [{ after: { "a.md": "XaYbcZ" }, operations: [
      { key: "s", kind: "editSource", source: { path: "/a.md", range: [0, 0] }, text: "X" },
      { key: "m", kind: "editSource", source: { path: "/a.md", range: [1, 1] }, text: "Y" },
      { key: "e", kind: "editSource", source: { path: "/a.md", range: [3, 3] }, text: "Z" }] }],
    expect: { "/a.md": [[op("s"), 0, 1], [imp("/a.md"), 0, 1], [op("m"), 0, 1], [imp("/a.md"), 1, 2], [op("e"), 0, 1]] } },
  { name: "delete", before: { "a.md": "abcdef" },
    frames: [{ after: { "a.md": "af" }, operations: [{ key: "d", kind: "editSource", source: { path: "/a.md", range: [1, 5] }, text: "" }] }],
    expect: { "/a.md": [[imp("/a.md"), 0, 1], [imp("/a.md"), 5, 1]] } },
  { name: "replacement preserving part of its selection", before: { "a.md": "one two three" },
    frames: [{ after: { "a.md": "ONE two THREE" }, operations: [{ key: "r", kind: "editSource", source: { path: "/a.md", range: [0, 13] }, text: "ONE two THREE",
      lineage: [{ source: { path: "/a.md", range: [4, 7] }, range: [4, 7] }] }] }],
    expect: { "/a.md": [[op("r"), 0, 4], [imp("/a.md"), 4, 3], [op("r"), 7, 6]] } },
  { name: "move forward within a file", before: { "a.md": "A\nB\nC\n" },
    frames: [{ after: { "a.md": "B\nC\nA\n" }, operations: [{ key: "m", kind: "moveSource", source: { path: "/a.md", range: [0, 2] }, at: { path: "/a.md", range: [4, 6] }, side: "after" }] }],
    expect: { "/a.md": [[imp("/a.md"), 2, 4], [imp("/a.md"), 0, 2]] } },
  { name: "move backward within a file, then edit the moved text", before: { "a.md": "A\nB\nC\n" },
    frames: [{ after: { "a.md": "c\nA\nB\n" }, operations: [
      { key: "m", kind: "moveSource", source: { path: "/a.md", range: [4, 6] }, at: { path: "/a.md", range: [0, 2] }, side: "before" },
      { key: "e", kind: "editSource", source: { path: "/a.md", range: [4, 5] }, text: "c" }] }],
    expect: { "/a.md": [[op("e"), 0, 1], [imp("/a.md"), 5, 1], [imp("/a.md"), 0, 4]] } },
  { name: "move between files", before: { "a.md": "keep\nmove\n", "b.md": "end\n" },
    frames: [{ after: { "a.md": "keep\n", "b.md": "end\nmove\n" }, operations: [{ key: "m", kind: "moveSource", source: { path: "/a.md", range: [5, 10] }, at: { path: "/b.md", range: [4, 4] }, side: "before" }] }],
    expect: { "/a.md": [[imp("/a.md"), 0, 5]], "/b.md": [[imp("/b.md"), 0, 4], [imp("/a.md"), 5, 5]] } },
  { name: "add a file and a folder", before: { d: { "x.md": "x" } },
    frames: [{ after: { d: { "x.md": "x", "y.md": "new", n: { "z.md": "zz" } } }, operations: [
      { key: "f", kind: "addEntry", destination: { parent: { path: "/d" }, name: "y.md" }, value: { file: "new" } },
      { key: "n", kind: "addEntry", destination: { parent: { path: "/d" }, name: "n" }, value: { directory: { "z.md": "zz" } } }] }],
    expect: { "/d/y.md": [[op("f"), 0, 3]], "/d/n/z.md": [[`${op("n")}/z.md`, 0, 2]] } },
  { name: "edit a page's body", before: { "p.md": { page: "body text" } },
    frames: [{ after: { "p.md": { page: "body TEXT" } }, operations: [{ key: "e", kind: "editSource", source: { path: "/p.md", range: [5, 9] }, text: "TEXT" }] }],
    expect: { "/p.md": [[imp("/p.md"), 0, 5], [op("e"), 0, 4]] } },
  { name: "two frames", before: { "a.md": "ab" },
    frames: [
      { after: { "a.md": "aXb" }, operations: [{ key: "1", kind: "editSource", source: { path: "/a.md", range: [1, 1] }, text: "X" }] },
      { after: { "a.md": "aXYb" }, operations: [{ key: "2", kind: "editSource", source: { path: "/a.md", range: [2, 2] }, text: "Y" }] }],
    expect: { "/a.md": [[imp("/a.md"), 0, 1], [op("1"), 0, 1], [op("2"), 0, 1], [imp("/a.md"), 1, 1]] } },
  { name: "snapshot", before: { "same.md": "same", "changed.md": "old", "p.md": { page: "body" }, gone: { "g.md": "g" } },
    snapshot: { "same.md": "same", "changed.md": "new!", "p.md": { page: "body" }, "added.md": "add" },
    expect: { "/same.md": [[imp("/same.md"), 0, 4]], "/changed.md": [["snapshot:c:/changed.md", 0, 4]], "/p.md": [[imp("/p.md"), 0, 4]], "/added.md": [["snapshot:c:/added.md", 0, 3]] } },
];

/** A case's objects, roots and operations, made concrete. */
function materialize(c: Case) {
  const objects = new Objects();
  const before = objects.build(c.before);
  const resolve = (ref: { path: string; range?: [number, number] }, spec: Spec, root: string) =>
    ({ material: { kind: "basis", path: ref.path, object: ref.path === "/" ? root : objectAt(objects, spec, ref.path) }, ...(ref.range ? { range: ref.range } : {}) });
  let spec = c.before, root = before;
  const frames = (c.frames ?? []).map((frame) => {
    const after = objects.build(frame.after);
    const operations = frame.operations.map((o) => {
      const out: Record<string, unknown> = { ...o };
      for (const field of ["source", "at"]) if (o[field]) out[field] = resolve(o[field] as never, spec, root);
      if (o.lineage) out.lineage = (o.lineage as Array<{ source: never; range: [number, number] }>).map((l) => ({ source: resolve(l.source, spec, root), range: l.range }));
      if (o.destination) { const d = o.destination as { parent: { path: string }; name: string }; out.destination = { parent: resolve(d.parent, spec, root), name: d.name }; }
      if (o.value) { const v = o.value as Record<string, Spec>; const [k, s] = Object.entries(v)[0]!; out.value = { [k]: objects.build(s) }; }
      return out as SourceOperation;
    });
    const result = { before: root, after, operations };
    spec = frame.after; root = after;
    return result;
  });
  const snapshot = c.snapshot === undefined ? undefined : objects.build(c.snapshot);
  return { objects, before, frames, snapshot };
}

async function moduleIndex(c: Case) {
  const m = materialize(c);
  let index = await importProvenance(m.before as ObjectHash, "directory", `basis:${TREE}:${m.before}`, m.objects.load);
  for (const frame of m.frames) index = await advanceProvenance(index, frame.operations, "c", m.objects.load);
  if (m.snapshot) index = await rebindProvenance(index, m.before as ObjectHash, m.snapshot as ObjectHash, "c", m.objects.load);
  return { m, index };
}

/** The index of the state the merge engine reaches for the same history. */
async function engineIndex(c: Case, m: ReturnType<typeof materialize>): Promise<ProvenanceNode> {
  const put = (entry: Parameters<typeof encodeLogEntry>[0]) => m.objects.put(encodeLogEntry(entry));
  const genesis = put({ format: LOG_ENTRY_FORMAT, tree: TREE, previous: null, root: m.before, at: 0, change: "genesis", trace: null, resolves: [], decisions: [] });
  const last = m.frames.length || m.snapshot ? put({ format: LOG_ENTRY_FORMAT, tree: TREE, previous: genesis,
    root: m.snapshot ?? m.frames.at(-1)!.after, at: 0, change: "c", trace: m.snapshot ? null : m.frames, resolves: [], decisions: [] }) : genesis;
  const sidecar = new Sidecar({ shared: { find: async (h) => m.objects.map.get(h) ?? null, has: async (h) => m.objects.map.has(h) },
    staging: { find: async () => null, stage: async () => {} } }) as unknown as {
      stateOf(h: string, r: unknown): Promise<{ state: string }>; recorded: Map<string, Parameters<typeof viewState>[0]> };
  const { state } = await sidecar.stateOf(last, { id: "tree-default", revision: 1 });
  const view = viewState(sidecar.recorded.get(state)!);
  const children = new Map<string, Node[]>();
  for (const node of Object.values(view.nodes) as Node[])
    if (node.active && node.parent !== null) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  const visit = (node: Node): ProvenanceNode => node.kind === "tree" ? { kind: "tree", node: node.id }
    : node.kind === "directory" ? { kind: "directory", node: node.id, entries: Object.fromEntries((children.get(node.id) ?? []).map((ch) => [ch.name, visit(ch)])) }
    : { kind: node.kind, node: node.id, pieces: normalizePieces((node.pieces ?? []).map(({ origin, start, length }) => ({ origin, start, length }))) };
  return visit(view.nodes[view.root] as Node);
}

const sortEntries = (n: ProvenanceNode): ProvenanceNode => n.kind === "directory"
  ? { ...n, entries: Object.fromEntries(Object.entries(n.entries).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortEntries(v)])) } : n;
const piecesAt = (index: ProvenanceNode, path: string) => {
  let node: ProvenanceNode | undefined = index;
  for (const part of path.split("/").filter(Boolean)) node = node?.kind === "directory" ? node.entries[part] : undefined;
  return node && "pieces" in node ? node.pieces.map((p) => [p.origin, p.start, p.length]) : undefined;
};

for (const c of cases)
  test(`provenance: ${c.name}`, async () => {
    const { m, index } = await moduleIndex(c);
    for (const [path, expected] of Object.entries(c.expect ?? {}))
      expect(piecesAt(index, path)).toEqual(expected.map(([o, s, l]) => [o.replace("ROOT", m.before), s, l]));
    expect(stableJSONString(sortEntries(index))).toBe(stableJSONString(sortEntries(await engineIndex(c, m))));
  });

test("provenance conformance vectors are current", async () => {
  const vectors = [];
  for (const c of cases) {
    const { m, index } = await moduleIndex(c);
    vectors.push({
      name: c.name, change: "c", tree: TREE, root: m.before,
      importedAs: `basis:${TREE}:${m.before}`,
      frames: m.frames, ...(m.snapshot ? { snapshot: m.snapshot } : {}),
      objects: Object.fromEntries([...m.objects.map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([h, b]) => [h, Buffer.from(b).toString("base64")])),
      index: sortEntries(index),
    });
  }
  const text = JSON.stringify({ format: "overstory-provenance-vectors", version: 1, vectors }, null, 1) + "\n";
  if (process.env.UPDATE_VECTORS) writeFileSync(VECTORS, text);
  expect(readFileSync(VECTORS, "utf8")).toBe(text);
});

test("provenance records round-trip, share unchanged records, and chunk long piece lists", async () => {
  const store = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const h = hashObject(bytes); store.set(h, bytes); return h as ObjectHash; };
  const load = async (h: string) => store.get(h)!;
  const many = Array.from({ length: 400 }, (_, i) => ({ origin: `o${i}`, start: i, length: 1 + (i % 3) }));
  const index: ProvenanceNode = { kind: "directory", node: "r", entries: {
    "a.md": { kind: "file", node: "a", pieces: many },
    sub: { kind: "directory", node: "s", entries: { "p.md": { kind: "page", node: "p", pieces: [] }, mount: { kind: "tree", node: "t" } } },
  } };
  const written = new WeakMap<object, ObjectHash>();
  const root = encodeProvenance(index, put, written);
  expect(stableJSONString(await readProvenance(root, load))).toBe(stableJSONString(index));
  // About one chunk per 32 pieces.
  const file = decodeProvenanceRecord(store.get((decodeProvenanceRecord(store.get(root)!) as { entries: [string, string][] }).entries[0]![1])!);
  expect((file as { chunks: string[] }).chunks.length).toBeGreaterThan(4);
  // An edit to one piece rewrites that chunk, its file and the root.
  const before = store.size;
  const edited: ProvenanceNode = { ...index, entries: { ...(index as { entries: Record<string, ProvenanceNode> }).entries,
    "a.md": { kind: "file", node: "a", pieces: many.map((p, i) => (i === 200 ? { ...p, origin: "edited" } : p)) } } };
  encodeProvenance(edited, put, written);
  expect(store.size - before).toBeLessThanOrEqual(4);
  expect(() => decodeProvenanceRecord(new TextEncoder().encode('{"kind":"tree","node":"t","format":"overstory-provenance-v1"}'))).toThrow("canonical");
});

test("a changed file reuses its unchanged chunks and writes exactly what a full encode writes", async () => {
  // Deterministic pseudo-random edits: inserts, deletes, replacements, at the
  // start, middle and end, and over an index read back from its records.
  let seed = 7;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const store = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => { const h = hashObject(bytes); store.set(h, bytes); return h as ObjectHash; };
  const fresh = (bytes: Uint8Array) => hashObject(bytes) as ObjectHash;
  const file = (pieces: Array<{ origin: string; start: number; length: number }>): ProvenanceNode => ({ kind: "directory", node: "r", entries: { "a.md": { kind: "page", node: "a", pieces } } });
  let pieces = Array.from({ length: 600 }, (_, i) => ({ origin: `o${i % 37}`, start: i * 3, length: 2 }));
  let previous = file(pieces), written = new WeakMap<object, ObjectHash>();
  encodeProvenance(previous, put, written);
  for (let step = 0; step < 300; step++) {
    if (step % 50 === 25) { previous = await readProvenance(encodeProvenance(previous, put, new WeakMap()), async (h) => store.get(h)!); written = new WeakMap(); }
    const at = [0, pieces.length, random(pieces.length + 1)][step % 3]!, remove = Math.min(random(4), pieces.length - at);
    const insert = Array.from({ length: random(4) }, (_, k) => ({ origin: `n${step}`, start: k * 5, length: 1 + k }));
    pieces = [...pieces.slice(0, at), ...insert, ...pieces.slice(at + remove)];
    const next = file(pieces);
    const before = store.size, written2 = new Set<string>();
    const incremental = encodeProvenance(next, (bytes) => { written2.add(fresh(bytes)); return put(bytes); }, written, previous);
    const full = new Set<string>();
    expect(encodeProvenance(file(pieces), (bytes) => { const h = fresh(bytes); full.add(h); return h; })).toBe(incremental);
    // Everything the incremental encode references is stored.
    for (const h of full) expect(store.has(h)).toBe(true);
    expect(written2.size).toBeLessThanOrEqual(full.size);
    if (pieces.length > 300 && remove + insert.length > 0) expect(store.size - before).toBeLessThan(8);
    previous = next;
  }
});
