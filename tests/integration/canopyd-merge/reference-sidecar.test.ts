import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type CandidateUpdate } from "@overstory/protocol";

/** canopyd's rule-agnostic acceptance behavior against the reference sidecar
 * in test support, which reads only the object store and the question. */
const sidecar = new URL("../../support/reference-sidecar.ts", import.meta.url).pathname;
let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient, tree: string, questions = 0;
const objects = new Map<string, Uint8Array>();

async function start() {
  running = await serveHost({ dataRoot: dir, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    accounts: [{ handle: "owner", token: "owner-token", communityWriter: true }],
    mergeTool: { command: [process.execPath, sidecar], onTiming: (phase) => { if (phase === "worker-process") questions++; } } });
  client = new ProtocolClient(running.url, "owner-token");
}
async function stop() { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/arbor-reference-sidecar-`);
  await start();
  tree = (await client.account()).account.community.id;
  const head = (await client.descriptor(tree)).tree;
  for (const [hash, bytes] of (await client.snapshot(tree, head.root)).objects) objects.set(hash, bytes);
});
afterEach(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });

/** A snapshot of `root` with `files` written. */
function snapshot(root: string, files: Record<string, string>): CandidateUpdate {
  const directory = decodeProtocolDirectory(objects.get(root)!);
  for (const [name, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text), file = hashObject(bytes);
    objects.set(file, bytes);
    directory.entries = [...directory.entries.filter((e) => e.name !== name), { name, file }].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  }
  const bytes = encodeProtocolDirectory(directory), candidate = hashObject(bytes);
  objects.set(candidate, bytes);
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [], objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}
const submit = async (base: string, update: CandidateUpdate) => (await client.submitUpdates(tree, { base, updates: [update] })).results[0]!.update;

test("disjoint concurrent files merge; the same file becomes an entry choice that a guarded snapshot resolves", async () => {
  const head = (await client.descriptor(tree)).tree;
  const base = await submit(head.update, snapshot(head.root, { "a.md": "A\n", "b.md": "B\n" }));
  const left = await submit(base.id, snapshot(base.root, { "a.md": "A left\n" }));
  const merged = await submit(base.id, snapshot(base.root, { "b.md": "B right\n" }));
  expect(merged.conflicted).toBe(false);
  expect(merged.root).toBe(snapshot(left.root, { "b.md": "B right\n" }).candidate);
  const rival = snapshot(base.root, { "a.md": "A rival\n" });
  const conflicted = await submit(base.id, rival);
  expect(conflicted.conflicted).toBe(true);
  expect(conflicted.root).toBe(merged.root);
  const page = await client.conflicts(tree, conflicted.id, conflicted.root);
  expect(page.decisions).toHaveLength(1);
  const decision = page.decisions[0]!;
  expect(decision.kind).toBe("entry");
  expect(decision.alternatives.map((a) => a.value)).toEqual([
    { file: hashObject(new TextEncoder().encode("A left\n")) }, { file: hashObject(new TextEncoder().encode("A rival\n")) },
  ]);
  // Restart: the sidecar keeps nothing, and the choice is still the entry's.
  await stop(); await start();
  expect(await client.conflicts(tree, conflicted.id, conflicted.root)).toEqual(page);
  const resolution = { ...snapshot(conflicted.root, { "a.md": "A rival\n" }),
    resolves: [{ state: conflicted.id, conflict: decision.id, alternatives: decision.alternatives.map((a) => a.id) }] };
  const resolved = await submit(conflicted.id, resolution);
  expect(resolved.conflicted).toBe(false);
  await running.canopy.verifyIntegrity();
});

test("a plain edit on the head never asks the sidecar; a concurrent one does", async () => {
  const head = (await client.descriptor(tree)).tree;
  const base = await submit(head.update, snapshot(head.root, { "note.md": "hello\n" }));
  const file = hashObject(new TextEncoder().encode("hello\n"));
  const traced = (root: string, text: string): CandidateUpdate => {
    const update = snapshot(root, { "note.md": text });
    return { ...update, trace: [{ before: root, after: update.candidate, operations: [{ key: "edit", kind: "editSource",
      source: { material: { kind: "basis", path: "/note.md", object: file }, range: [0, 5] }, text: text.slice(0, -1) }] }] };
  };
  questions = 0;
  const forward = await submit(base.id, traced(base.root, "HELLO\n"));
  expect(questions).toBe(0);
  const concurrent = await submit(base.id, traced(base.root, "howdy\n"));
  expect(questions).toBeGreaterThan(0);
  expect(concurrent.conflicted).toBe(true);
  expect(concurrent.root).toBe(forward.root);
  await running.canopy.verifyIntegrity();
});
