import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, pathReadObjects, type ObjectHash, type ProtocolClient, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

// Clients 003: a path read answers one page and the directories above it in
// one round trip, and a payload-free watch sends frames without objects.

const token = "path-read-owner";
const text = (value: string) => new TextEncoder().encode(value);

let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let client: ProtocolClient;
let community: string;
let root: ObjectHash;
let update: string;
let observedThrough: string;
const hashes: Record<string, ObjectHash> = {};

function sorted(entries: ProtocolDirectoryEntry[]): ProtocolDirectoryEntry[] {
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "overstoryd-path-read-"));
  running = await serveHost({
    dataRoot: join(sandbox, "data"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = await deviceClient(running.url, token);
  community = (await client.account()).account.community.id;
  const head = await client.descriptor(community);
  const snapshot = await client.snapshot(community, head.tree.root);
  const top = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const objects = new Map(snapshot.objects);
  const add = (name: string, bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); hashes[name] = hash; return hash; };
  // /Trips/Paris.md, /Trips/_index.md, /Trips/Rome/_index.md, /Trips/photo.bin, /Notes.md
  const paris = add("paris", text("# Paris\n"));
  const tripsIndex = add("tripsIndex", text("# Trips\n"));
  const romeIndex = add("romeIndex", text("# Rome\n"));
  const photo = add("photo", new Uint8Array([1, 2, 3]));
  const notes = add("notes", text("Notes\n"));
  const rome = add("rome", encodeProtocolDirectory({ type: "directory", entries: [{ name: "_index.md", file: romeIndex, created: 0, modified: 0 }] }));
  const trips = add("trips", encodeProtocolDirectory({ type: "directory", entries: sorted([
    { name: "Paris.md", file: paris, created: 0, modified: 0 },
    { name: "Rome", directory: rome },
    { name: "_index.md", file: tripsIndex, created: 0, modified: 0 },
    { name: "photo.bin", file: photo, created: 0, modified: 0 },
  ]) }));
  const directory = encodeProtocolDirectory({
    ...top,
    entries: sorted([...top.entries, { name: "Trips", directory: trips }, { name: "Notes.md", file: notes, created: 0, modified: 0 }]),
  });
  root = add("root", directory);
  await client.submitUpdate(community, head.tree.update, { root, objects });
  const current = await client.descriptor(community);
  expect(current.tree.root as string).toBe(root);
  update = current.tree.update;
  observedThrough = current.tree.update;
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("path reads", () => {
  test("a page under a directory brings the directories above it and nothing else", async () => {
    const objects = await client.pathRead(community, root, "/Trips/Paris");
    expect(new Set(objects.keys())).toEqual(new Set([root, hashes.trips!, hashes.paris!]));
  });

  test("any spelling of a node reads the same objects", async () => {
    for (const spelling of ["/Trips/Paris.md", "/Trips/Paris"]) {
      expect(new Set((await client.pathRead(community, root, spelling)).keys())).toEqual(new Set([root, hashes.trips!, hashes.paris!]));
    }
    for (const spelling of ["/Trips", "/Trips/", "/Trips/_index.md"]) {
      expect(new Set((await client.pathRead(community, root, spelling)).keys())).toEqual(new Set([root, hashes.trips!, hashes.tripsIndex!]));
    }
  });

  test("a directory node brings its index page, and the root its own", async () => {
    const rome = await client.pathRead(community, root, "/Trips/Rome");
    expect(new Set(rome.keys())).toEqual(new Set([root, hashes.trips!, hashes.rome!, hashes.romeIndex!]));
    const top = await client.pathRead(community, root, "/");
    const index = decodeProtocolDirectory(top.get(root)!).entries.find((entry) => entry.name === "_index.md");
    expect(new Set(top.keys())).toEqual(new Set([root, ...(index?.file ? [index.file] : index?.page ? [index.page] : [])]));
  });

  test("a file is read by its own name", async () => {
    const objects = await client.pathRead(community, root, "/Trips/photo.bin");
    expect(objects.get(hashes.photo!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a missing entry answers the directories that exist, so the reader sees it is absent", async () => {
    expect(new Set((await client.pathRead(community, root, "/Trips/Nowhere")).keys())).toEqual(new Set([root, hashes.trips!]));
    expect(new Set((await client.pathRead(community, root, "/Gone/Deeper/Still")).keys())).toEqual(new Set([root]));
  });

  test("the answer is immutable, and an unknown root is the snapshot's 404", async () => {
    const response = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}/path/Trips/Paris`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/cbor");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${root}/Trips/Paris"`);
    // A header holds only ASCII: the path is percent-encoded as in the URL.
    const accented = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}/path/Trips/Caf%C3%A9`);
    expect(accented.status).toBe(200);
    expect(accented.headers.get("etag")).toBe(`"${root}/Trips/Caf%C3%A9"`);
    const unknown = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/sha256:${"0".repeat(64)}/path/Trips`);
    expect(unknown.status).toBe(404);
    const escape = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}/path/Trips%2FParis`);
    expect(escape.status).toBe(400);
  });

  test("the bundle is exactly the walk: a producer cannot add or leave out objects", async () => {
    const { decodePathReadBundle, encodePathReadBundle } = await import("@ovst/protocol");
    const objects = await pathReadObjects(root, "/Trips/Paris", (hash) => client.object(community, hash));
    const extra = new Map(objects);
    extra.set(hashes.notes!, (await client.object(community, hashes.notes!)));
    await expect(decodePathReadBundle(root, "/Trips/Paris", encodePathReadBundle(extra))).rejects.toThrow(/off the path/);
    const short = new Map(objects);
    short.delete(hashes.trips!);
    await expect(decodePathReadBundle(root, "/Trips/Paris", encodePathReadBundle(short))).rejects.toThrow(/missing/);
  });
});

describe("a Browse session", () => {
  test("opens a page with one path read and resolves it from what that brought", async () => {
    const { TreeSession, browseSettings } = await import("@ovst/working-tree");
    let objectReads = 0;
    const counting = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "object") return (...args: Parameters<ProtocolClient["object"]>) => { objectReads += 1; return target.object(...args); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = await TreeSession.open(community, counting, browseSettings(), { tree: { ...(await client.descriptor(community)).tree, root: root as never } });
    const objects = await session.openPage("/Trips/Paris");
    expect(new Set(objects.keys())).toEqual(new Set([root, hashes.trips!, hashes.paris!]));
    expect((await session.index.entry("/Trips/Paris.md"))?.file).toBe(hashes.paris!);
    expect(new TextDecoder().decode((await session.objects.object(hashes.paris!))!)).toBe("# Paris\n");
    expect(objectReads).toBe(0);
    expect(session.index.heldDirectories).toBe(2);
  });
});

describe("payload-free watch", () => {
  test("sends each accepted update without its objects", async () => {
    const abort = new AbortController();
    const frames = client.watch(community, observedThrough, { signal: abort.signal, objects: "none" });
    const next = frames.next();
    const changed = text("Notes, again\n");
    const top = decodeProtocolDirectory(await client.object(community, root));
    const directory = encodeProtocolDirectory({
      ...top,
      entries: top.entries.map((entry) => entry.name === "Notes.md" ? { name: "Notes.md", file: hashObject(changed), created: 0, modified: 0 } : entry),
    });
    await client.submitUpdate(community, update, {
      root: hashObject(directory),
      objects: new Map([[hashObject(changed), changed], [hashObject(directory), directory]]),
    });
    const event = (await next).value;
    abort.abort();
    expect(event?.kind).toBe("tree.update");
    if (event?.kind !== "tree.update") return;
    expect(event.transition.update.root).toBe(hashObject(directory));
    expect(event.transition.objects).toEqual([]);
    expect(event.transition.deltas).toEqual([]);
  });

  test("refuses any other objects value", async () => {
    const response = await fetch(`${running.url}/.overstory/trees/${community}/watch?objects=some`);
    expect(response.status).toBe(400);
  });
});
