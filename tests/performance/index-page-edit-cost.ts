/** Diagnostic: per-phase server time of small traced edits to a tree's root
 * `_index.md` as a large page, through a disposable in-process host. The profile
 * parse only runs on that one file, so plain-file rehearsals miss it.
 *
 *   PAGE_KB=64 FILES=100 bun tests/performance/index-page-edit-cost.ts
 *   INDEX_BODY=path/to/body.md bun tests/performance/index-page-edit-cost.ts
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { decodeProtocolDirectory, encodeProtocolDirectory, encodeProtocolPage, hashObject, protocolContentBytes,
  type ObjectHash, type ProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { executeExactSourceEdits } from "../support/source-edits.ts";
import { deviceClient, testAccount } from "../helpers/devices.ts";
import { hostTree } from "../helpers/tree-config.ts";
const TEST_AT = Date.UTC(2026, 10, 11);
const TEST_TIME = new Date(TEST_AT).toISOString();

const kb = Number(process.env.PAGE_KB ?? 64), files = Number(process.env.FILES ?? 100), edits = Number(process.env.EDITS ?? 60);
const line = "- [A linked task](A-linked-task.md) with some words after it, as an outline has\n";
const body = process.env.INDEX_BODY ? await readFile(process.env.INDEX_BODY, "utf8")
  : `# Console\n\n${line.repeat(Math.ceil(kb * 1024 / line.length))}`;
const dir = await mkdtemp(`${tmpdir()}/story-index-page-`);
const lines: Array<Record<string, any>> = [];
const log = console.log;
for (const sink of ["log", "info"] as const) console[sink] = (...args: unknown[]) => {
  try { const value = JSON.parse(String(args[0])); if (value.event === "update") { lines.push(value); return; } } catch {}
  if (sink === "log") log(...args);
};
const running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", "cost", { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, pages: true });
const client = await deviceClient(running.url, "cost");
const objects = new Map<ObjectHash, Uint8Array>();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const page = encodeProtocolPage({ type: "page", id: "cost", properties: [], body: new TextEncoder().encode(body) });
const entries: ProtocolDirectory["entries"] = [{ name: "_index.md", file: put(protocolContentBytes("page", page)), created: 0, modified: 0 }];
for (let index = 0; index < files; index++) entries.push({ name: `page-${index}.md`, file: put(new TextEncoder().encode(`# Page ${index}\n`)), created: 0, modified: 0 });
const directory = (entries: ProtocolDirectory["entries"]) => put(encodeProtocolDirectory({ type: "directory",
  entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
let root = directory(entries);
const tree = await hostTree(client, { root, objects: new Map(objects) });
let update = (await client.descriptor(tree)).tree.update;
// Convert it: a page may only replace the file it reads as.
root = directory(entries.map((entry) => entry.name === "_index.md" ? { name: "_index.md", page: put(page), created: 0, modified: 0 } : entry));
update = (await client.submitUpdates(tree, { base: update, updates: [{ at: TEST_TIME, change: crypto.randomUUID(), candidate: root, trace: null, resolves: [], deltas: [],
  objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) }] })).results[0]!.update.id;
lines.length = 0;
for (let index = 0; index < edits; index++) {
  const object = decodeProtocolDirectory(objects.get(root)!).entries.find((entry) => entry.name === "_index.md")!.page!;
  const operations: SourceOperation[] = [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/_index.md", object }, range: [20, 21] }, text: String.fromCharCode(97 + index % 26) }];
  const executed = await executeExactSourceEdits(root, operations, async (hash) => objects.get(hash)!, TEST_AT);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  update = (await client.submitUpdates(tree, { base: update, updates: [{ at: TEST_TIME, change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: root, after: executed.root, operations }],
    resolves: [], deltas: [], objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })) }] })).results[0]!.update.id;
  root = executed.root;
}
const median = (name: string) => { const sorted = lines.slice(5).map((line) => Number(line[name] ?? 0)).sort((a, b) => a - b); return sorted[sorted.length >> 1]!; };
const phases = Object.keys(lines.at(-1)!).filter((name) => typeof lines.at(-1)![name] === "number" && !["status", "updates", "body-bytes", "read-bytes"].includes(name));
log(JSON.stringify({ bytes: body.length, files, edits, ...Object.fromEntries(phases.map((name) => [name, median(name)])) }));
running.server.stop(true);
await running.overstoryd[Symbol.asyncDispose]();
await rm(dir, { recursive: true, force: true });
process.exit(0);
