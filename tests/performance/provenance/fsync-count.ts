/** Diagnostic: fsyncs and objects written per accepted fast-forward, with and
 * without the provenance index.   bun tests/performance/provenance/fsync-count.ts */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type CandidateUpdate, type ObjectHash } from "@ovst/protocol";
import { executeExactSourceEdits } from "../../support/source-edits.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

const dir = await mkdtemp(`${tmpdir()}/story-fsync-count-`);
const running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", "t", { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, provenanceFill: process.env.FILL !== "0" });
const client = await deviceClient(running.url, "t");
const tree = (await client.account()).account.community.id;
const descriptor = await client.descriptor(tree);
const snapshot = await client.snapshot(tree, descriptor.tree.root);
const objects = new Map(snapshot.objects);
const directory = decodeProtocolDirectory(objects.get(snapshot.root)!);
for (let i = 0; i < 50; i++) {
  const bytes = new TextEncoder().encode(`page ${i}\n`.repeat(40)), file = hashObject(bytes);
  objects.set(file, bytes); directory.entries.push({ name: `p${String(i).padStart(2, "0")}.md`, file });
}
directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
const encoded = encodeProtocolDirectory(directory); let root = hashObject(encoded); objects.set(root, encoded);
let base = (await client.submitUpdate(tree, descriptor.tree.update, { root, objects })).update.id;
await new Promise((r) => setTimeout(r, 2000));
const o = running.overstoryd as unknown as { objectCounters(): Record<string, number> };
const rows: number[][] = [];
for (let i = 0; i < 20; i++) {
  const name = `p${String(i % 50).padStart(2, "0")}.md`;
  const file = decodeProtocolDirectory(objects.get(root)!).entries.find((e) => e.name === name)!.file!;
  const operations = [{ key: "e", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: `/${name}`, object: file }, range: [0, 4] as [number, number] }, text: `edit ${i}` }];
  const executed = await executeExactSourceEdits(root, operations, async (h) => objects.get(h)!);
  for (const [h, b] of executed.generated) objects.set(h, b);
  const update: CandidateUpdate = { change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: root, after: executed.root, operations }], resolves: [],
    objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
  const before = o.objectCounters();
  const t = performance.now();
  const result = (await client.submitUpdates(tree, { base, updates: [update] })).results[0]!.update;
  const ms = performance.now() - t;
  const after = o.objectCounters();
  rows.push([after.written! - before.written!, after.fsyncs! - before.fsyncs!, ms]);
  base = result.id; root = result.root as ObjectHash;
}
const avg = (k: number) => (rows.slice(5).reduce((s, r) => s + r[k]!, 0) / (rows.length - 5)).toFixed(1);
console.log(JSON.stringify({ written: avg(0), fsyncs: avg(1), ms: avg(2), first: rows[0], last: rows.at(-1) }));
console.log("pointers", (await Array.fromAsync(new Bun.Glob("provenance/**/*").scan({ cwd: dir }))).length);
running.server.stop(true); await running.overstoryd[Symbol.asyncDispose](); await rm(dir, { recursive: true, force: true });
