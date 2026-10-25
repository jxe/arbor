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
  const tie = (id: string, values: Record<string, unknown>, key: string) => ({ key, kind: "rowCreate", collection: collection("people"),
    model: "Tie", row: JSON.stringify([["id", id]]), values: { id, ...values }, at } as SourceOperation);
  const operations: SourceOperation[] = [
    tie("Group-tr_ada-tr_club", { person: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", group: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb", kind: "Group", name: "Ada", handle: "ada", host: "arb.example" }, "op-0"),
    { key: "op-1", kind: "rowCreate", collection: collection("people"), model: "Contact", row: JSON.stringify([["id", "c1"]]),
      values: { id: "c1", name: "Grace", reach: "grace@example.com" }, at } as SourceOperation,
    tie("Invited-contact:c1", { person: "contact:c1", kind: "Invited" }, "op-2"),
    { key: "op-3", kind: "rowCreate", collection: collection("trees"), model: "Tree", row: JSON.stringify([["id", tree]]),
      values: { id: tree, canopy: "tr_cccccccccccccccccccccccccc", title: "Directory", host: "arb.example" }, at } as SourceOperation,
    { key: "op-4", kind: "rowCreate", collection: collection("trees"), model: "Visit", row: JSON.stringify([["id", "v1"]]),
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
  expect(await rows("people")).toEqual({ Contact: ["c1"], Tie: ["Group-tr_ada-tr_club", "Invited-contact:c1"] });
  expect(await rows("trees")).toEqual({ Tree: [tree], Visit: ["v1"] });
});

test("two devices adding the same tie on one base make one row and no decision", async () => {
  const seed = directorySeed();
  const profile = (await owner.account()).account.profileTree!;
  const tree = await hostTree(owner, { root: seed.root, objects: seed.objects }, { parent: { tree: profile, name: "directory-twice", kind: "person" } });
  const base = (await owner.descriptor(tree)).tree.update;
  const people = decodeProtocolDirectory(seed.objects.get(seed.root)!).entries.find((e) => e.name === "people")!.directory!;
  const add = (at: string) => owner.submitUpdates(tree, { base, updates: [{ change: crypto.randomUUID(), candidate: null, resolves: [], deltas: [], objects: [],
    trace: [{ operations: [{ key: "op-0", kind: "rowCreate", collection: { material: { kind: "basis", path: "/people", object: people } }, model: "Tie",
      row: JSON.stringify([["id", "Community-tr_ada-tr_canopy"]]), at,
      values: { id: "Community-tr_ada-tr_canopy", person: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", group: "tr_cccccccccccccccccccccccccc", kind: "Community", name: "Ada" } } as SourceOperation] }] }] });
  const first = (await add("2026-10-25T10:00:00.000Z")).results[0]!;
  const second = (await add("2026-10-25T10:00:01.000Z")).results[0]!;
  expect(first.update.conflicted).toBe(false);
  expect(second.update.conflicted).toBe(false);
});
