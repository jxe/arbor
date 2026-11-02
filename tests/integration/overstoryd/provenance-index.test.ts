import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectObjects, serveHost } from "@ovst/overstoryd";
import { ObjectStore } from "@ovst/object-store";
import {
  ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, operationIdentity, readProvenance,
  stableJSONString, type CandidateUpdate, type ObjectHash, type ProvenanceNode,
} from "@ovst/protocol";
import { ProvenanceStore } from "../../../packages/overstoryd/src/updates/provenance-store.ts";
import { executeExactSourceEdits } from "../../support/source-edits.ts";
import { acceptedEntries } from "../../support/log-entries.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
let tree: string, base: string, root: ObjectHash, objects: Map<ObjectHash, Uint8Array>, store: ObjectStore;
const token = "provenance-owner";

async function start(provenanceFill = false) {
  running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, provenanceFill });
  client = await deviceClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.overstoryd[Symbol.asyncDispose](); }

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/story-provenance-`); await start();
  store = new ObjectStore(join(dir, "objects"));
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree);
  const snapshot = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(snapshot.objects);
  const bytes = new TextEncoder().encode("abc\r\n"), file = hashObject(bytes);
  const directory = decodeProtocolDirectory(objects.get(snapshot.root)!);
  directory.entries.push({ name: "note.md", file });
  directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const encoded = encodeProtocolDirectory(directory); root = hashObject(encoded);
  objects.set(file, bytes); objects.set(root, encoded);
  base = (await client.submitUpdate(tree, descriptor.tree.update, { root, objects })).update.id;
});
afterEach(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });

async function edit(text: string, basis: ObjectHash, range: [number, number]): Promise<CandidateUpdate> {
  const file = decodeProtocolDirectory(objects.get(basis)!).entries.find((e) => e.name === "note.md")!.file!;
  const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md", object: file }, range }, text }];
  const executed = await executeExactSourceEdits(basis, operations, async (hash) => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: basis, after: executed.root, operations }], resolves: [],
    objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
}

/** Every accepted entry's index, by entry hash; null where none is stored. */
async function indexes(): Promise<Map<string, ProvenanceNode | null>> {
  const provenance = new ProvenanceStore(dir, store, () => { throw new Error("unused"); });
  const result = new Map<string, ProvenanceNode | null>();
  for (const { hash } of acceptedEntries(dir, tree)) {
    const pointer = await provenance.pointer(hash as ObjectHash);
    result.set(hash, pointer ? await readProvenance(pointer, (h) => store.read(h)) : null);
  }
  return result;
}
const note = (index: ProvenanceNode | null | undefined) =>
  index?.kind === "directory" && index.entries["note.md"]?.kind === "file" ? index.entries["note.md"].pieces.map((p) => [p.origin, p.start, p.length]) : undefined;

/** A fast-forward, then an answered concurrent edit, then a snapshot. */
async function history() {
  const first = await edit("ABC", root, [0, 3]);
  const accepted = (await client.submitUpdates(tree, { base, updates: [first] })).results[0]!.update;
  const concurrent = await edit("!\n", root, [3, 5]);
  const merged = (await client.submitUpdates(tree, { base, updates: [concurrent] })).results[0]!.update;
  expect(merged.root).not.toBe(concurrent.candidate);
  const after = await client.snapshot(tree, merged.root);
  for (const [hash, bytes] of after.objects) objects.set(hash, bytes);
  return { first, accepted, concurrent, merged };
}

/** Every entry's index, once the backfill has written them all. */
async function filled() {
  const deadline = Date.now() + 20_000;
  let found = await indexes();
  while ([...found.values()].some((index) => index === null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    found = await indexes();
  }
  return found;
}

test("each accepted entry gets its index beside it, and collection keeps its records", async () => {
  await stop(); await start(true);
  const { first, concurrent } = await history();
  const entries = acceptedEntries(dir, tree), found = await filled();
  expect([...found.values()].every((index) => index !== null)).toBe(true);
  // The tree's first entry, a boundary rewrite, the snapshot adding the note,
  // the fast-forward, the answered edit.
  expect(entries).toHaveLength(5);
  const [imported, plain, answered] = entries.slice(2).map(({ hash }) => found.get(hash));
  const basis = (imported as Extract<ProvenanceNode, { kind: "directory" }>).entries["note.md"]!;
  const original = note(imported)![0]![0] as string;
  expect(original).toStartWith("snapshot:");
  // The fast-forward replaced the first three bytes with its own.
  expect(note(plain)).toEqual([[operationIdentity(first.change, "edit"), 0, 3], [original, 3, 2]]);
  // An answered entry takes the index its answer carries: the engine's own
  // lineage, both edits' bytes.
  expect(note(answered)).toEqual([[operationIdentity(first.change, "edit"), 0, 3], [operationIdentity(concurrent.change, "edit"), 0, 2]]);
  expect((answered as Extract<ProvenanceNode, { kind: "directory" }>).entries["note.md"]!.node).toBe(basis.node);

  // Every stored record survives a collection of everything old.
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const shard of await readdir(join(dir, "objects")))
    for (const name of await readdir(join(dir, "objects", shard)).catch(() => [])) await utimes(join(dir, "objects", shard, name), past, past);
  await stop();
  await collectObjects(dir, { delete: true, graceMs: 24 * 60 * 60 * 1000 });
  store = new ObjectStore(join(dir, "objects"));
  expect(stableJSONString([...(await indexes())])).toBe(stableJSONString([...found]));
  await start();
});

test("a backfill computes missing indexes again the same way, and rebinds an answered entry", async () => {
  await stop(); await start(true);
  const { concurrent } = await history();
  const live = await filled();
  await stop();
  await rm(join(dir, "provenance"), { recursive: true, force: true });
  expect([...(await indexes()).values()].every((index) => index === null)).toBe(true);
  await start(true);
  const again = await filled(), answered = acceptedEntries(dir, tree).at(-1)!.hash;
  // Without its answer, an answered entry is rebound as a snapshot of its root.
  expect(note(again.get(answered))).toEqual([[`snapshot:${concurrent.change}:/note.md`, 0, 5]]);
  again.delete(answered); live.delete(answered);
  expect(stableJSONString([...again])).toBe(stableJSONString([...live]));
});
