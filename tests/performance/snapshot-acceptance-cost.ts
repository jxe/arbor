/** Diagnostic: snapshot (and traced) acceptance latency through a disposable
 * in-process host, measured by the client. Every snapshot records a merge
 * state, so this is the cost of a checkpoint per accepted update.
 *
 *   FILES=200 bun tests/performance/snapshot-acceptance-cost.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject,
  type CandidateUpdate, type ObjectHash, type WireDirectory, type WireDirectoryEntry } from "@overstory/protocol";
import { executeExactSourceEdits } from "../support/source-edits.ts";

process.env.ARBOR_CANOPY_NO_WARMUP = "1";
const count = Number(process.env.FILES ?? 200);
const dir = await mkdtemp(`${tmpdir()}/arbor-snapshot-cost-`);
const running = await serveCanopy({ dataRoot: dir, accounts: [{ handle: "owner", token: "cost", communityWriter: true }],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
const client = new WireClient(running.url, "cost");
const objects = new Map<ObjectHash, Uint8Array>();
const sent = new Set<ObjectHash>();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const file = (text: string) => put(new TextEncoder().encode(text));
function change(basis: ObjectHash, entries: Record<string, Omit<WireDirectoryEntry, "name"> | null>): ObjectHash {
  const value: WireDirectory = decodeWireDirectory(objects.get(basis)!);
  for (const [name, entry] of Object.entries(entries)) {
    value.entries = value.entries.filter((e) => e.name !== name);
    if (entry) value.entries.push({ name, ...entry } as WireDirectoryEntry);
  }
  value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(encodeWireDirectory(value));
}
function snapshot(candidate: ObjectHash): CandidateUpdate {
  const fresh = [...objects].filter(([hash]) => !sent.has(hash));
  for (const [hash] of fresh) sent.add(hash);
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [], objects: fresh.map(([hash, bytes]) => ({ hash, bytes })) };
}
const tree = (await client.account()).account.community.id;
const head = await client.descriptor(tree);
for (const [hash, bytes] of (await client.snapshot(tree, head.tree.root)).objects) objects.set(hash, bytes);
let root = head.tree.root as ObjectHash, update = head.tree.update;
async function submit(candidate: CandidateUpdate, basis = update) {
  const accepted = (await client.submitUpdates(tree, { base: basis, updates: [candidate] })).results[0]!.update;
  if (!objects.has(accepted.root))
    for (const [hash, bytes] of (await client.snapshot(tree, accepted.root)).objects) { objects.set(hash, bytes); sent.add(hash); }
  return { id: accepted.id, root: accepted.root as ObjectHash };
}
async function time(label: string, n: number, step: (index: number) => Promise<void>) {
  const ms: number[] = [];
  for (let index = 0; index < n; index++) { const started = performance.now(); await step(index); ms.push(performance.now() - started); }
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, files: count, n, median: Math.round(ms[n >> 1]!), p90: Math.round(ms[Math.floor(n * 0.9)]!) }));
}
const pages: Record<string, { file: ObjectHash }> = {};
for (let index = 0; index < count; index++) pages[`page-${index}.md`] = { file: file(`# Page ${index}\n\nBody ${index}\n`) };
({ id: update, root } = await submit(snapshot(change(root, pages))));
for (let index = 0; index < 5; index++) ({ id: update, root } = await submit(snapshot(change(root, { "warm.md": { file: file(`warm ${index}\n`) } }))));
await time("snapshot fast-forward", 40, async (index) => {
  ({ id: update, root } = await submit(snapshot(change(root, { [`page-${index % count}.md`]: { file: file(`# Page ${index}\n\nEdited\n`) } }))));
});
await time("snapshot concurrent pair", 20, async (index) => {
  const basis = { update, root };
  await submit(snapshot(change(basis.root, { "peer.md": { file: file(`peer ${index}\n`) } })), basis.update);
  ({ id: update, root } = await submit(snapshot(change(basis.root, { [`page-${index % count}.md`]: { file: file(`mine ${index}\n`) } })), basis.update));
});
await time("traced fast-forward", 20, async (index) => {
  const path = `/page-${(index + 7) % count}.md`;
  const source = decodeWireDirectory(objects.get(root)!).entries.find((e) => e.name === path.slice(1))!.file!;
  const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path, object: source }, range: [0, 1] as [number, number] }, text: "#" }];
  const executed = await executeExactSourceEdits(root, operations, async (hash) => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) { objects.set(hash, bytes); sent.add(hash); }
  ({ id: update, root } = await submit({ change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: root, after: executed.root, operations }],
    resolves: [], deltas: [], objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })) }));
});
{
  const basis = { update, root };
  await submit(snapshot(change(basis.root, { "choice.bin": { file: file("left\0") } })), basis.update);
  ({ id: update, root } = await submit(snapshot(change(basis.root, { "choice.bin": { file: file("right\0") } })), basis.update));
}
await time("snapshot fast-forward beside an open choice", 20, async (index) => {
  ({ id: update, root } = await submit(snapshot(change(root, { [`page-${index % count}.md`]: { file: file(`# Page ${index}\n\nAgain\n`) } }))));
});
running.server.stop(true);
await running.canopy[Symbol.asyncDispose]();
await rm(dir, { recursive: true, force: true });
process.exit(0);
