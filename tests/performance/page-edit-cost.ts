/** Diagnostic: traced edits and block moves on one large page (like a
 * 64 KB `_index.md` Console page) in a pages tree, through a disposable
 * in-process host. Phase timings come from the host's `event=update` lines.
 *
 *   BODY_KB=64 bun tests/performance/page-edit-cost.ts 2>&1 | grep event=update
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { decodeProtocolDirectory, encodeProtocolDirectory, encodeProtocolPage, hashObject, executeExactSourceEdits, parsePage,
  type ObjectHash, type ProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { deviceClient, testAccount } from "../helpers/devices.ts";

const bodyKB = Number(process.env.BODY_KB ?? 64), siblings = Number(process.env.SIBLINGS ?? 60), n = Number(process.env.N ?? 40);
const dir = await mkdtemp(`${tmpdir()}/story-page-cost-`);
const running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", "cost", { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, pages: true });
const client = await deviceClient(running.url, "cost");
const objects = new Map<ObjectHash, Uint8Array>();
const encoder = new TextEncoder();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const tree = (await client.account()).account.community.id;
const head = await client.descriptor(tree);
for (const [hash, bytes] of (await client.snapshot(tree, head.tree.root)).objects) objects.set(hash, bytes);
let root = head.tree.root as ObjectHash, update = head.tree.update;

const lines: string[] = [];
for (let index = 0; lines.join("\n").length < bodyKB * 1024; index++)
  lines.push(index % 12 === 0 ? `\n## Section ${index}\n` : `- [ ] Item ${index}: ${"some words about the task ".repeat(1 + (index % 4))}`);
const body = lines.join("\n") + "\n";
const value: ProtocolDirectory = decodeProtocolDirectory(objects.get(root)!);
// Markdown files first, then the conversion to the pages they read as (spec 02 §3).
value.entries.push({ name: "console.md", file: put(encoder.encode(`---\ntitle: Console\n---\n${body}`)) });
for (let index = 0; index < siblings; index++) value.entries.push({ name: `page-${index}.md`, file: put(encoder.encode(`Body ${index}\n`)) });
value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
({ id: update, root } = await submit(put(encodeProtocolDirectory(value)), null, [...objects].map(([hash, bytes]) => ({ hash, bytes }))));
value.entries = value.entries.map((e) => e.file && (e.name === "console.md" || e.name.startsWith("page-")) ? { name: e.name, page: put(encodeProtocolPage(parsePage(objects.get(e.file)!)!)) } : e);
({ id: update, root } = await submit(put(encodeProtocolDirectory(value)), null, [...objects].map(([hash, bytes]) => ({ hash, bytes }))));

async function submit(candidate: ObjectHash, trace: { before: ObjectHash; after: ObjectHash; operations: SourceOperation[] }[] | null, payload: { hash: ObjectHash; bytes: Uint8Array }[]) {
  const accepted = (await client.submitUpdates(tree, { base: update, updates: [{ change: crypto.randomUUID(), candidate, trace, resolves: [], deltas: [], objects: payload }] })).results[0]!.update;
  return { id: accepted.id, root: accepted.root as ObjectHash };
}
const page = () => decodeProtocolDirectory(objects.get(root)!).entries.find((e) => e.name === "console.md")!.page!;
const material = () => ({ kind: "basis" as const, path: "/console.md", object: page() });
async function traced(operations: SourceOperation[]) {
  const executed = await executeExactSourceEdits(root, operations, async (hash) => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  ({ id: update, root } = await submit(executed.root, [{ before: root, after: executed.root, operations }], [...executed.generated].map(([hash, bytes]) => ({ hash, bytes }))));
}
async function time(label: string, step: (index: number) => Promise<void>) {
  const ms: number[] = [];
  for (let index = 0; index < n; index++) { const started = performance.now(); await step(index); ms.push(performance.now() - started); }
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, bodyKB, n, median: Math.round(ms[n >> 1]!), p90: Math.round(ms[Math.floor(n * 0.9)]!) }));
}
const lineStart = (k: number) => { let offset = 0; for (let i = 0; i < k; i++) offset += encoder.encode(lines[i]!).length + 1; return offset; };
// A page with history: each earlier edit split its piece list (provenance).
const history = Number(process.env.HISTORY ?? 0);
for (let i = 0; i < history; i++) {
  const at = lineStart(Math.floor((i * 7919) % (lines.length - 1))) + 2;
  await traced([{ key: "edit", kind: "editSource", source: { material: material(), range: [at, at] }, text: "y" } as SourceOperation]);
  const line = lines.findIndex((_, k) => lineStart(k + 1) > at); lines[line] = lines[line]!.slice(0, 2) + "y" + lines[line]!.slice(2);
}
console.log("MARK warm");
for (let i = 0; i < 5; i++) await traced([{ key: "edit", kind: "editSource", source: { material: material(), range: [0, 0] }, text: "" + i } as SourceOperation]);
console.log("MARK typing");
await time("type one character", async (index) => {
  const at = lineStart(100 + (index % 50)) + 3;
  await traced([{ key: "edit", kind: "editSource", source: { material: material(), range: [at, at] }, text: "x" } as SourceOperation]);
});
console.log("MARK moves");
await time("move one block line", async (index) => {
  const line = 200 + (index % 20) * 2, start = lineStart(line), end = lineStart(line + 1), anchorEnd = lineStart(line + 2);
  await traced([{ key: "move", kind: "moveSource", source: { material: material(), range: [start, end] }, at: { material: material(), range: [end, anchorEnd] }, side: "after" } as SourceOperation]);
  [lines[line], lines[line + 1]] = [lines[line + 1]!, lines[line]!];
});
running.server.stop(true);
await running.overstoryd[Symbol.asyncDispose]();
await rm(dir, { recursive: true, force: true });
process.exit(0);
