// Property operations, including the row operations of before USL 0.3
// (rowSet, rowCreate, …), are accepted as snapshots of their result.
/** Performance 004 step 2 differential: the shared provenance module against
 * the merge engine, over a production copy's whole chain.
 *   bun tests/performance/provenance/differential.ts <data-root> <tree> [limit]
 * For each entry, the module's index (advanced from the previous entry's
 * index over a plain trace, or rebound for a snapshot or property trace) is
 * compared with the index of the state the engine replayed. An asked entry
 * takes the engine's index, as a sidecar answer would carry it. */
import { join } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { advanceProvenance, decodeProtocolDirectory, decodeProtocolPage, importProvenance, isPropertyOperation, normalizePieces, rebindProvenance,
  stableJSONString, type ObjectHash, type ProvenanceNode } from "@ovst/protocol";
import { acceptedEntries } from "../../support/log-entries.ts";
import { sidecar } from "../../support/replay-check.ts";
import { DEFAULT_RULES, unbudgeted } from "./unbudgeted.ts";
import { viewState } from "../../../packages/overstoryd-merge/src/retained-state.ts";
import type { Node } from "../../../packages/overstoryd-merge/src/intent-model.ts";

const [root, tree, limitArg] = process.argv.slice(2);
if (!root || !tree) throw Error("usage: differential.ts <data-root> <tree> [limit]");
const entries = acceptedEntries(root, tree);
const limit = Number(limitArg ?? entries.length);
const s = unbudgeted(sidecar(root)) as unknown as {
  stateOf(hash: string, rules: unknown): Promise<{ object: string; state: string }>;
  recorded: Map<string, Parameters<typeof viewState>[0]>;
  objects: { read(hash: string): Promise<Uint8Array> };
};
const store = new ObjectStore(join(root, "objects"));
const load = async (hash: ObjectHash) => (await store.find(hash)) ?? s.objects.read(hash);

/** Where each origin's bytes are, as the engine's states place them:
 * origin -> [object, offset - start]. Fed by every state the engine replays. */
const located = new Map<string, [string, number]>();
/** The index the engine's state implies. */
function engineIndex(stateId: string): ProvenanceNode {
  const view = viewState(s.recorded.get(stateId)!);
  for (const node of Object.values(view.nodes) as Node[])
    for (const p of node.pieces ?? []) if (!located.has(p.origin)) located.set(p.origin, [p.object, p.offset - p.start]);
  const children = new Map<string, Node[]>();
  for (const node of Object.values(view.nodes) as Node[])
    if (node.active && node.parent !== null) { const l = children.get(node.parent) ?? []; l.push(node); children.set(node.parent, l); }
  const visit = (node: Node): ProvenanceNode => {
    if (node.kind === "tree") return { kind: "tree", node: node.id };
    if (node.kind === "file" || node.kind === "page")
      return { kind: node.kind, node: node.id, pieces: normalizePieces((node.pieces ?? []).map((p) => ({ origin: p.origin, start: p.start, length: p.length }))) };
    const entries: Record<string, ProvenanceNode> = {};
    for (const child of children.get(node.id) ?? []) entries[child.name] ??= visit(child);
    return { kind: "directory", node: node.id, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : 1)) };
  };
  return visit(view.nodes[view.root] as Node);
}
const canonical = (node: ProvenanceNode): string => stableJSONString(node);
/** Whether every text file of `index` that differs from `engine` holds, by
 * its pieces, exactly the bytes `root` holds there. New origins of `trace`
 * are its edit texts and added files. */
async function bytesHold(index: ProvenanceNode, engine: ProvenanceNode, root: string, change: string,
  trace: Array<{ operations: Array<Record<string, unknown>> }>): Promise<string | true> {
  const texts = new Map<string, Uint8Array>();
  for (const frame of trace) for (const op of frame.operations)
    if (op.kind === "editSource") texts.set(JSON.stringify([change, op.key]), new TextEncoder().encode(op.text as string));
  const pieceBytes = async (p: { origin: string; start: number; length: number }) => {
    const text = texts.get(p.origin);
    if (text) return text.subarray(p.start, p.start + p.length);
    const at = located.get(p.origin);
    if (!at) throw Error(`unlocated origin ${p.origin.slice(0, 80)}`);
    let bytes = await load(at[0] as ObjectHash);
    try { const page = decodeProtocolPage(bytes); if (page.body) bytes = page.body; } catch { /* a file */ }
    return bytes.subarray(p.start + at[1], p.start + at[1] + p.length);
  };
  const visit = async (a: ProvenanceNode, b: ProvenanceNode | undefined, object: string, path: string): Promise<string | true> => {
    if (b && canonical(a) === canonical(b)) return true;
    if (a.kind === "directory") {
      const entries = decodeProtocolDirectory(await load(object as ObjectHash)).entries;
      for (const entry of entries) {
        const child = a.entries[entry.name]; if (!child) return `${path}/${entry.name}: missing`;
        const r = await visit(child, b?.kind === "directory" ? b.entries[entry.name] : undefined, (entry.file ?? entry.page ?? entry.directory ?? entry.tree)!, `${path}/${entry.name}`);
        if (r !== true) return r;
      }
      return true;
    }
    if (a.kind === "tree") return true;
    let expected = await load(object as ObjectHash);
    if (a.kind === "page") expected = decodeProtocolPage(expected).body;
    const got = Buffer.concat(await Promise.all(a.pieces.map(pieceBytes)));
    return got.equals(Buffer.from(expected)) ? true : `${path}: bytes differ (${got.length} vs ${expected.length})`;
  };
  return visit(index, engine, root, "");
}
/** First differing path between two indexes. */
function firstDifference(a: ProvenanceNode, b: ProvenanceNode, path = ""): string {
  if (a.kind !== b.kind) return `${path}: kind ${a.kind} vs ${b.kind}`;
  if (a.node !== b.node) return `${path}: node ${a.node.slice(0, 80)} vs ${b.node.slice(0, 80)}`;
  if (a.kind === "directory" && b.kind === "directory") {
    for (const name of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
      const x = a.entries[name], y = b.entries[name];
      if (!x || !y) return `${path}/${name}: only in ${x ? "module" : "engine"}`;
      if (canonical(x) !== canonical(y)) return firstDifference(x, y, `${path}/${name}`);
    }
  }
  if ("pieces" in a && "pieces" in b) return `${path}: pieces ${JSON.stringify(a.pieces).slice(0, 300)} vs ${JSON.stringify(b.pieces).slice(0, 300)}`;
  return `${path}: ?`;
}

const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const examples: string[] = [];
let index: ProvenanceNode | undefined;
let previousRoot: ObjectHash | undefined;
const started = performance.now();
for (const [i, { id, hash, entry }] of entries.slice(0, limit).entries()) {
  const cached = await s.stateOf(hash, DEFAULT_RULES);
  const engine = engineIndex(cached.state);
  let kind: string, mine: ProvenanceNode | undefined;
  try {
    if (!entry.previous) { kind = "genesis"; mine = await importProvenance(entry.root as ObjectHash, "directory", `basis:${tree}:${entry.root}`, load); }
    else if (entry.asked) kind = "asked";
    else if (entry.trace === null || entry.trace.every((f) => f.operations.every((op) => isPropertyOperation(op as { kind: string }) || /^row/.test((op as { kind: string }).kind)))) {
      kind = entry.trace === null ? "snapshot" : "property";
      mine = await rebindProvenance(index!, previousRoot!, entry.root as ObjectHash, entry.change, load);
    } else {
      kind = "plain";
      mine = index!;
      for (const frame of entry.trace) mine = await advanceProvenance(mine, frame.operations as never, entry.change, load);
    }
  } catch (error) {
    kind ??= "?"; bump(`${kind}:refused`);
    if (examples.length < 30) examples.push(`${i} (${id}) ${kind} refused: ${error instanceof Error ? error.message : error}`);
    mine = undefined;
  }
  if (mine) {
    if (canonical(mine) === canonical(engine)) bump(`${kind}:same`);
    else {
      bump(`${kind}:differs`);
      const held = kind === "plain" ? await bytesHold(mine, engine, entry.root, entry.change, entry.trace as never).catch((e) => String(e)) : "not checked";
      bump(`${kind}:differs:bytes ${held === true ? "right" : "wrong"}`);
      if (examples.length < 30) examples.push(`${i} (${id}) ${kind}: module bytes ${held === true ? "right" : held}; ${firstDifference(mine, engine).slice(0, 300)}`);
    }
  } else if (kind! === "asked") bump("asked");
  // Continue from the engine's index, as overstoryd would from an answer
  // (and so one difference does not cascade).
  index = engine; previousRoot = entry.root as ObjectHash;
  if (i % 1000 === 0) console.error(`${i}/${limit} ${Math.round((performance.now() - started) / 1000)}s ${JSON.stringify(counts)}`);
}
console.log(JSON.stringify(counts, null, 1));
for (const e of examples) console.log(e);
