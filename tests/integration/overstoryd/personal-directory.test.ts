import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { loadDirectoryCollection } from "@ovst/collection-schema";
import { decodeProtocolDirectory, type ProtocolClient, type SourceOperation } from "@ovst/protocol";
import { directorySeed, directorySeedSwift, directorySeedSwiftPath } from "../../../tools/directory-seed.ts";
import { hostTree } from "../../helpers/tree-config.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

// People 001 phase 1: the directory tree Story creates and keeps from code.
const token = "directory-owner";
let sandbox: string, running: Awaited<ReturnType<typeof serveHost>>, owner: ProtocolClient;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-personal-directory-"));
  running = await serveHost({ dataRoot: join(sandbox, "overstoryd"), accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  owner = await deviceClient(running.url, token);
});
afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

test("the Swift seed is the one tools/directory-seed.ts makes", async () => {
  expect(await readFile(directorySeedSwiftPath, "utf8")).toBe(directorySeedSwift());
});

test("the seed activates a private directory under the profile, and Story's derived row changes fill it", async () => {
  const seed = directorySeed();
  const profile = (await owner.account()).account.profileTree!;
  const tree = await hostTree(owner, { root: seed.root, objects: seed.objects }, { parent: { tree: profile, name: "directory", kind: "person" } });
  const resolved = await owner.resolve("/~owner/directory");
  expect(resolved.ref.tree).toBe(tree);
  const descriptor = (await owner.descriptor(tree)).tree;
  expect(descriptor.root as string).toBe(seed.root);

  const folder = (objects: Map<string, Uint8Array>, root: string, name: string) =>
    decodeProtocolDirectory(objects.get(root)!).entries.find((e) => e.name === name)!.directory!;
  const at = "2026-10-25T10:00:00.000Z";
  const collection = (name: string) => ({ material: { kind: "basis" as const, path: `/${name}`, object: folder(seed.objects, seed.root, name) } });
  const operations: SourceOperation[] = [
    { key: "op-0", kind: "rowCreate", collection: collection("people"), model: "Sighting", row: JSON.stringify([["id", "s1"]]),
      values: { id: "s1", person: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "Opened", name: "Ada", handle: "ada", host: "arb.example", device: "Mac", at }, at } as SourceOperation,
    { key: "op-1", kind: "rowCreate", collection: collection("people"), model: "Contact", row: JSON.stringify([["id", "c1"]]),
      values: { id: "c1", name: "Grace", reach: "grace@example.com" }, at } as SourceOperation,
    { key: "op-2", kind: "rowCreate", collection: collection("people"), model: "Sighting", row: JSON.stringify([["id", "s2"]]),
      values: { id: "s2", person: "contact:c1", kind: "Invited", at }, at } as SourceOperation,
    { key: "op-3", kind: "rowCreate", collection: collection("trees"), model: "Visit", row: JSON.stringify([["id", "v1"]]),
      values: { id: "v1", tree, path: "/", title: "Directory", how: "Opened", device: "Mac", at }, at } as SourceOperation,
  ];
  const result = (await owner.submitUpdates(tree, { base: descriptor.update, updates: [
    { change: crypto.randomUUID(), candidate: null, trace: [{ operations }], resolves: [], deltas: [], objects: [] },
  ] })).results[0]!;
  expect(result.outcome).toBe("accepted");

  const snapshot = await owner.snapshot(tree, result.update.root);
  const objects = new Map(snapshot.objects);
  const rows = async (name: string) => {
    const loaded = await loadDirectoryCollection(decodeProtocolDirectory(objects.get(folder(objects, snapshot.root, name))!), async (hash) => objects.get(hash)!);
    return Object.fromEntries(Object.entries(loaded!.tables).map(([model, list]) => [model, list.map((row) => Object.fromEntries(row.key)["id"])]));
  };
  expect(await rows("people")).toEqual({ Contact: ["c1"], Sighting: ["s1", "s2"] });
  expect(await rows("trees")).toEqual({ Visit: ["v1"] });
});
