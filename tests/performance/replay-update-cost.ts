/** Diagnostic: replay synthetic edits through the merge tool on a copy of real
 * Canopy data and print per-phase timings. Never point it at live data; it
 * writes generated objects into the data root it is given.
 *
 *   bun tools/replay-update-cost.ts <copied-data-root> [tree-id]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { decodeWireDirectory, encodeWireDirectory, hashObject, type WireDirectoryEntry } from "@overstory/protocol";
import { ObjectStore } from "../../packages/object-store/src/index.ts";
import { MergeTool } from "../../packages/canopyd/src/merge-tool.ts";
import type { IntentRequestInput, IntentResponse } from "../../packages/canopyd-merge/src/intent-model.ts";

const [dataRoot, treeArg] = process.argv.slice(2);
if (!dataRoot) throw new Error("usage: replay-update-cost.ts <copied-data-root> [tree-id]");
const db = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
const tree = treeArg ?? (db.query(`select u.tree_id as t from accepted_updates u join accepted_merge_states m on m.accepted_id = u.id group by u.tree_id order by count(*) desc limit 1`).get() as { t: string }).t;
const heads = db.query(`select u.root as object, json_extract(m.record_json, '$.state') as state from accepted_updates u join accepted_merge_states m on m.accepted_id = u.id where u.tree_id = ? order by u.accepted_at desc, u.rowid desc limit 12`).all(tree) as Array<{ object: string; state: string }>;
const head = heads[0]!;

const objects = new ObjectStore(join(dataRoot, "objects"));
let timings: Record<string, number> = {}, counts: Record<string, number> = {};
const tool = new MergeTool(dataRoot, {
  persistent: true,
  objects,
  onTiming: (phase, ms) => { timings[phase] = (timings[phase] ?? 0) + ms; },
  onCount: (name, value) => { counts[name] = value; },
});
const read = async (hash: string) => objects.read(hash);
const encoder = new TextEncoder();

/** The first Markdown file under a root, with the directory chain above it. */
async function findFile(root: string, path: string[] = []): Promise<{ path: string[]; file: string } | undefined> {
  const directory = decodeWireDirectory(await read(root));
  for (const entry of directory.entries)
    if (entry.file && entry.name.endsWith(".md")) return { path: [...path, entry.name], file: entry.file };
  for (const entry of directory.entries)
    if (entry.directory) {
      const found = await findFile(entry.directory, [...path, entry.name]);
      if (found) return found;
    }
}
/** Replace one file's bytes; returns the new root and every new object. */
async function withFile(root: string, path: string[], bytes: Uint8Array, out: Map<string, Uint8Array>): Promise<string> {
  const put = (value: Uint8Array) => { const hash = hashObject(value); out.set(hash, value); return hash; };
  const directory = decodeWireDirectory(await read(root));
  const [name, ...rest] = path;
  const entries = await Promise.all(directory.entries.map(async (entry): Promise<WireDirectoryEntry> =>
    entry.name !== name ? entry
      : rest.length ? { ...entry, directory: await withFile(entry.directory!, rest, bytes, out) } as WireDirectoryEntry
      : { ...entry, file: put(bytes) } as WireDirectoryEntry));
  return put(encodeWireDirectory({ ...directory, entries }));
}
/** An edit replacing [start, end) of the found file with `inserted`. */
async function edit(basis: { object: string; state: string }, current: { object: string; state: string }, change: string, range: "end" | "start", inserted: string) {
  const found = (await findFile(basis.object))!;
  // Ranges are UTF-8 byte offsets. "start" replaces the first byte, which must
  // be ASCII so the edit stays on a character boundary.
  const before = await read(found.file);
  if (range === "start" && !(before[0]! < 0x80)) throw new Error("First byte is not ASCII");
  const at: [number, number] = range === "end" ? [before.length, before.length] : [0, Math.min(1, before.length)];
  const after = new Uint8Array([...before.subarray(0, at[0]), ...encoder.encode(inserted), ...before.subarray(at[1])]);
  const inputs = new Map<string, Uint8Array>();
  const candidate = await withFile(basis.object, found.path, after, inputs);
  const request: IntentRequestInput = {
    kind: "tree", tree, base: basis, current,
    incoming: { change, object: candidate, trace: [{ before: basis.object, after: candidate, operations: [
      { kind: "editSource", key: "edit", source: { material: { kind: "basis", path: "/" + found.path.join("/"), object: found.file }, range: at }, text: inserted },
    ] }] },
    rules: { id: "tree-default", revision: 1, config: { contentChoices: tool.contentChoices, conflictProjection: "current" } },
  };
  return { request, inputs };
}
async function run(label: string, job: { request: IntentRequestInput; inputs: Map<string, Uint8Array> }) {
  timings = {}; counts = {};
  const readsBefore = objects.readCounters.reads;
  const started = performance.now();
  const { response, objects: produced } = (await tool.evaluate(job.request as never, job.inputs)) as unknown as { response: IntentResponse; objects: Map<string, Uint8Array> };
  const total = performance.now() - started;
  await objects.store([...job.inputs, ...produced].map(([hash, bytes]) => ({ hash, bytes })));
  if (response.outcome !== "evaluated") throw new Error(`${label}: ${JSON.stringify(response)}`);
  const evaluated = response;
  const round = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]));
  counts["store-reads"] = objects.readCounters.reads - readsBefore;
  console.log(JSON.stringify({ label, total: Math.round(total), decisions: evaluated.decisions.length, ...round(timings), counts: round(counts) }));
  return evaluated.result as { object: string; state: string };
}

const warm = await tool.warm(tree, head);
console.log(JSON.stringify({ tree, head: head.state.slice(7, 19), warm }));
let n = 0;
const id = (name: string) => `replay-${name}-${Date.now()}-${n++}`;
for (const round of [1, 2]) {
  // Exact basis: the fast path.
  const fast = await run(`fast-${round}`, await edit(head, head, id("fast"), "end", ` fast${round}`));
  // Divergent from a state written by this build: its base is editable, as every
  // base will be once the history predating Phase 4 has been superseded.
  const ahead = await run(`ahead-${round}`, await edit(fast, fast, id("ahead"), "end", ` ahead${round}`));
  await run(`divergent-new-${round}`, await edit(fast, ahead, id("divergent-new"), "start", `N${round}`));
  // Based several updates back, merged into head: the full evaluator.
  const old = heads[Math.min(5, heads.length - 1)]!;
  await run(`divergent-${round}`, await edit(old, head, id("divergent"), "start", `D${round}`));
  // A live decision, then an unrelated edit on top of it.
  const a = await run(`conflict-a-${round}`, await edit(head, head, id("a"), "start", "A"));
  const b = await run(`conflict-b-${round}`, await edit(head, a, id("b"), "start", "B"));
  await run(`on-decision-${round}`, await edit(b, b, id("later"), "end", ` later${round}`));
}
await tool[Symbol.asyncDispose]?.();
process.exit(0);
