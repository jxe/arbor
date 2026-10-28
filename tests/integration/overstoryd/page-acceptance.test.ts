import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { decodeProtocolDirectory, decodeProtocolPage, encodeProtocolDirectory, encodeProtocolPage, executeRowOperations, hashObject, ProtocolClient,
  type CandidateUpdate, type PageProperty, type ProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { expectReplayableHistory } from "../../support/replay-check.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
let tree: string, base: string, root: string, objects: Map<string, Uint8Array>;
const token = "page-owner";
const encoder = new TextEncoder(), decoder = new TextDecoder();

function put(bytes: Uint8Array) { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; }
function directory(value: ProtocolDirectory) {
  value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(encodeProtocolDirectory(value));
}
const pageObject = (properties: PageProperty[], body: string) =>
  put(encodeProtocolPage({ type: "page", id: "p1", properties, body: encoder.encode(body) }));
const pageHash = (at: string) => decodeProtocolDirectory(objects.get(at)!).entries.find((e) => e.name === "note.md")!.page!;
const pageAt = (at: string) => decodeProtocolPage(objects.get(pageHash(at))!);
/** `root` with note.md replaced by `page`. */
function withPage(at: string, page: string) {
  const value = decodeProtocolDirectory(objects.get(at)!);
  value.entries = value.entries.map((e) => e.name === "note.md" ? { name: "note.md", page } : e);
  return directory(value);
}
async function remember(acceptedRoot: string) {
  for (const [hash, bytes] of (await client.snapshot(tree, acceptedRoot)).objects) objects.set(hash, bytes);
}
const payload = () => [...objects].map(([hash, bytes]) => ({ hash, bytes }));
async function propertyChange(basisRoot: string, field: string, before: unknown, value: unknown): Promise<CandidateUpdate> {
  const operations = [{ key: "set", kind: "set", page: { material: { kind: "basis", path: "/note.md", object: pageHash(basisRoot) } }, field, before, value }] as SourceOperation[];
  const result = await executeRowOperations(basisRoot, operations, async (hash) => objects.get(hash)!);
  for (const [hash, bytes] of result.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: basisRoot, after: result.root, operations }], resolves: [], deltas: [], objects: payload() };
}
async function submit(update: CandidateUpdate, basis = base) {
  return (await client.submitUpdates(tree, { base: basis, updates: [update] })).results[0]!.update;
}

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/story-page-accept-`);
  running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = await deviceClient(running.url, token);
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree), initial = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(initial.objects);
  const value = decodeProtocolDirectory(objects.get(initial.root)!);
  value.entries.push({ name: "note.md", page: pageObject([["title", "A"], ["status", "draft"]], "One\nTwo\n") });
  root = directory(value);
  base = (await submit({ change: crypto.randomUUID(), candidate: root, trace: null, resolves: [], deltas: [], objects: payload() }, descriptor.tree.update)).id;
});
afterEach(async () => {
  try { await expectReplayableHistory(dir, tree); }
  finally {
    running.server.stop(true); await running.overstoryd[Symbol.asyncDispose]();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a property change and a concurrent body edit both land", async () => {
  const first = await submit(await propertyChange(root, "status", "draft", "done"));
  expect(first.conflicted).toBe(false);
  // A snapshot that edits the body, authored on the same basis.
  const page = pageAt(root);
  const edited = withPage(root, put(encodeProtocolPage({ ...page, body: encoder.encode("One\nTwo\nThree\n") })));
  const second = await submit({ change: crypto.randomUUID(), candidate: edited, trace: null, resolves: [], deltas: [], objects: payload() });
  expect(second.conflicted).toBe(false);
  await remember(second.root);
  const merged = pageAt(second.root);
  expect(merged.properties).toEqual([["title", "A"], ["status", "done"]]);
  expect(decoder.decode(merged.body)).toBe("One\nTwo\nThree\n");
  await running.overstoryd.verifyIntegrity();
});

test("one property set twice is a property choice, which a property operation resolves", async () => {
  await submit(await propertyChange(root, "status", "draft", "mine"));
  const accepted = await submit(await propertyChange(root, "status", "draft", "theirs"));
  expect(accepted.conflicted).toBe(true);
  await remember(accepted.root);
  expect(pageAt(accepted.root).properties).toEqual([["title", "A"], ["status", "mine"]]);
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  expect(decision).toMatchObject({ kind: "property", property: "status" });
  expect(decision.alternatives.map((a) => a.value)).toEqual([{ value: "mine" }, { value: "theirs" }]);
  const guard = { state: accepted.id, conflict: decision.id, alternatives: decision.alternatives.map((a) => a.id) };
  const pick = await propertyChange(accepted.root, "status", "mine", "theirs");
  const resolved = await submit({ ...pick, resolves: [guard] }, accepted.id);
  expect(resolved.conflicted).toBe(false);
  await remember(resolved.root);
  expect(pageAt(resolved.root).properties).toEqual([["title", "A"], ["status", "theirs"]]);
  await running.overstoryd.verifyIntegrity();
});
