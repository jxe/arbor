/** Rehearsal on Joe's todos tree content: traced edits of real pages, then
 * concurrent snapshot pairs (merge sidecar), then a cold restart and more
 * edits.   ARBOR=<checkout> bun rehearse.ts <dataRoot> <todos dir> <phase>
 * phase: traced | pairs | all */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const ARBOR = process.env.ARBOR!;
const { serveHost } = await import(`${ARBOR}/packages/overstoryd/src/index.ts`);
const P = await import(`${ARBOR}/packages/protocol/src/index.ts`);
const { executeExactSourceEdits } = await import(`${ARBOR}/tests/support/source-edits.ts`);
const { deviceClient, testAccount } = await import(`${ARBOR}/tests/helpers/devices.ts`);
const [dataRoot, todos, phase = "all"] = process.argv.slice(2);
const N = Number(process.env.N ?? 40);

const objects = new Map<string, Uint8Array>(), sent = new Set<string>();
const put = (bytes: Uint8Array) => { const h = P.hashObject(bytes); objects.set(h, bytes); return h; };
const pages: string[] = [];
async function build(dir: string, at: string): Promise<string> {
  const entries: any[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const name = d.name.normalize("NFC");
    if (d.isDirectory()) entries.push({ name, directory: await build(join(dir, d.name), `${at}/${name}`) });
    else { entries.push({ name, file: put(new Uint8Array(await readFile(join(dir, d.name)))) }); if (name.endsWith(".md")) pages.push(`${at}/${name}`); }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(P.encodeProtocolDirectory({ type: "directory", entries }));
}
let running = await serveHost({ dataRoot, accounts: [testAccount("owner", "reh", { communityWriter: true })], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
let client = await deviceClient(running.url, "reh");
const tree = (await client.account()).account.community.id;
const head = await client.descriptor(tree);
for (const [h, b] of (await client.snapshot(tree, head.tree.root)).objects) { objects.set(h, b); sent.add(h); }
const existing = P.decodeProtocolDirectory(objects.get(head.tree.root)!);
const todosRoot = P.decodeProtocolDirectory(objects.get(await build(todos!, ""))!);
const merged = [...existing.entries, ...todosRoot.entries.filter((t: any) => !existing.entries.some((e: any) => e.name === t.name))]
  .sort((a: any, b: any) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
let root = put(P.encodeProtocolDirectory({ type: "directory", entries: merged })), update = head.tree.update;
const fresh = () => { const out = [...objects].filter(([h]) => !sent.has(h)); for (const [h] of out) sent.add(h); return out.map(([hash, bytes]) => ({ hash, bytes })); };
const snapshotUpdate = (candidate: string) => ({ change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [], objects: fresh() });
async function submit(u: any, basis = update) {
  const accepted = (await client.submitUpdates(tree, { base: basis, updates: [u] })).results[0]!.update;
  if (!objects.has(accepted.root)) for (const [h, b] of (await client.snapshot(tree, accepted.root)).objects) { objects.set(h, b); sent.add(h); }
  return { id: accepted.id, root: accepted.root };
}
({ id: update, root } = await submit(snapshotUpdate(root)));
console.log(JSON.stringify({ files: objects.size, pages: pages.length }));
async function lookup(r: string, path: string) { let d = P.decodeProtocolDirectory(objects.get(r)!); const parts = path.slice(1).split("/"); for (const p of parts.slice(0, -1)) d = P.decodeProtocolDirectory(objects.get(d.entries.find((e: any) => e.name === p).directory)!); return d.entries.find((e: any) => e.name === parts.at(-1)).file; }
async function traced(i: number) {
  const path = pages[(i * 7) % pages.length]!;
  const operations = [{ key: "e", kind: "editSource" as const, source: { material: { kind: "basis" as const, path, object: await lookup(root, path) }, range: [0, 0] as [number, number] }, text: `r${i} ` }];
  const ex = await executeExactSourceEdits(root, operations, async (h: string) => objects.get(h)!);
  for (const [h, b] of ex.generated) { objects.set(h, b); sent.add(h); }
  ({ id: update, root } = await submit({ change: crypto.randomUUID(), candidate: ex.root, trace: [{ before: root, after: ex.root, operations }], resolves: [], deltas: [], objects: [...ex.generated].map(([hash, bytes]) => ({ hash, bytes })) }));
}
function withFile(r: string, name: string, text: string) {
  const d = P.decodeProtocolDirectory(objects.get(r)!);
  d.entries = d.entries.filter((e: any) => e.name !== name); d.entries.push({ name, file: put(new TextEncoder().encode(text)) });
  d.entries.sort((a: any, b: any) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(P.encodeProtocolDirectory(d));
}
async function pair(i: number) {
  const basis = { update, root };
  await submit(snapshotUpdate(withFile(basis.root, "peer.md", `peer ${i}\n`)), basis.update);
  ({ id: update, root } = await submit(snapshotUpdate(withFile(basis.root, `mine.md`, `mine ${i}\n`)), basis.update));
}
async function time(label: string, n: number, step: (i: number) => Promise<void>) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await step(i); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, n, median: +ms[n >> 1]!.toFixed(1), p90: +ms[Math.floor(n * 0.9)]!.toFixed(1) }));
}
for (let i = 0; i < 5; i++) await traced(1000 + i);
console.error("MARK start"); (await import("node:fs")).existsSync("/MARK_START");
if (phase !== "pairs") await time("traced", N, traced);
if (phase !== "traced") await time("pairs", Math.max(10, N >> 1), pair);
if (phase === "all") {
  running.server.stop(true); await running.overstoryd[Symbol.asyncDispose]();
  const t = performance.now();
  running = await serveHost({ dataRoot, accounts: [testAccount("owner", "reh", { communityWriter: true })], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = await deviceClient(running.url, "reh");
  await traced(5000);
  console.log(JSON.stringify({ label: "cold restart + first edit", ms: +(performance.now() - t).toFixed(1) }));
  await time("traced after restart", 10, (i) => traced(6000 + i));
}
console.error("MARK end"); (await import("node:fs")).existsSync("/MARK_END");
running.server.stop(true); await running.overstoryd[Symbol.asyncDispose]();
process.exit(0);
