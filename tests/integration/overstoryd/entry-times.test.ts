import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolClient, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

// Protocol 002: an entry's time is when its content first appeared at its
// path (tree operations §1.1.2a), served beside a snapshot or path read's
// objects with `?times`, for any retained root.

const token = "entry-times-owner";
const text = (value: string) => new TextEncoder().encode(value);
const sorted = (entries: ProtocolDirectoryEntry[]) => entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let client: ProtocolClient;
let community: string;
/** The roots of four updates: content added; Notes edited and a file moved; Notes restored; Trips renamed. */
const roots: ObjectHash[] = [];

async function start() {
  running = await serveHost({
    dataRoot: join(sandbox, "data"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = await deviceClient(running.url, token);
}

async function stop() {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "overstoryd-entry-times-"));
  await start();
  community = (await client.account()).account.community.id;
  const head = await client.descriptor(community);
  const base = await client.snapshot(community, head.tree.root);
  const top = decodeProtocolDirectory(base.objects.get(base.root)!);
  const objects = new Map(base.objects);
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const tree = (notes: string, photo: string, trips = "Trips") => {
    const tripsDirectory = put(encodeProtocolDirectory({ type: "directory", entries: sorted([
      { name: "Paris.md", file: put(text("# Paris\n")), created: 0, modified: 0 },
      { name: photo, file: put(new Uint8Array([1, 2, 3])), created: 0, modified: 0 },
    ]) }));
    return put(encodeProtocolDirectory({ ...top, entries: sorted([...top.entries, { name: trips, directory: tripsDirectory }, { name: "Notes.md", file: put(text(notes)), created: 0, modified: 0 }]) }));
  };
  let update = head.tree.update;
  for (const root of [tree("Notes\n", "photo.bin"), tree("Notes, edited\n", "pic.bin"), tree("Notes\n", "pic.bin"), tree("Notes\n", "pic.bin", "Journeys")]) {
    await pause();
    const result = await client.submitUpdate(community, update, { root, objects });
    if (result.outcome !== "accepted") throw new Error(`update ${result.outcome}`);
    update = result.update.id;
    roots.push(root);
  }
});

afterAll(async () => {
  await stop();
  await rm(sandbox, { recursive: true, force: true });
});

describe("entry times", () => {
  test("a snapshot dates every file and page entry by when its content first appeared at its path", async () => {
    const [first, edited, restored, renamed] = await Promise.all(roots.map(async (root) => (await client.timedSnapshot(community, root)).times));
    const added = first!["/Trips/Paris.md"]!;
    expect(first!["/Notes.md"]).toBe(added);
    expect(first!["/Trips/photo.bin"]).toBe(added);
    // Unchanged content keeps its time; changed content and a move are new at their paths.
    expect(edited!["/Trips/Paris.md"]).toBe(added);
    expect(edited!["/Notes.md"]!).toBeGreaterThan(added);
    expect(edited!["/Trips/pic.bin"]).toBe(edited!["/Notes.md"]!);
    expect(edited).not.toHaveProperty("/Trips/photo.bin");
    // Content restored at its path keeps the time it first had there.
    expect(restored!["/Notes.md"]).toBe(added);
    // A renamed directory dates everything beneath it by the rename.
    expect(renamed!["/Journeys/Paris.md"]!).toBeGreaterThan(edited!["/Notes.md"]!);
    // An older root still answers the times it always had.
    expect((await client.timedSnapshot(community, roots[0]!)).times).toEqual(first!);
  });

  test("a path read carries the times of exactly the directories it walks", async () => {
    const { objects, times } = await client.timedPathRead(community, roots[1]!, "/Trips/Paris");
    expect(objects.size).toBe(3);
    const whole = (await client.timedSnapshot(community, roots[1]!)).times;
    const top = Object.keys(whole).filter((path) => path.lastIndexOf("/") === 0);
    expect(Object.keys(times).sort()).toEqual([...top, "/Trips/Paris.md", "/Trips/pic.bin"].sort());
    for (const [path, at] of Object.entries(times)) expect(whole[path]).toBe(at);
  });

  test("the timed answer is immutable with its own ETag; without times the bundle is unchanged", async () => {
    const root = roots[1]!;
    const timed = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}?times`);
    expect(timed.status).toBe(200);
    expect(timed.headers.get("etag")).toBe(`"${root};times"`);
    expect(timed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const path = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}/path/Trips/Paris?times`);
    expect(path.headers.get("etag")).toBe(`"${root}/Trips/Paris;times"`);
    const plain = await fetch(`${running.url}/.overstory/trees/${community}/snapshots/${root}`);
    expect(plain.headers.get("etag")).toBe(`"${root}"`);
    expect((await client.snapshot(community, root)).root).toBe(root);
  });

  test("a lost index is rebuilt from history on the next start, to the same times", async () => {
    const before = await Promise.all(roots.map(async (root) => (await client.timedSnapshot(community, root)).times));
    await stop();
    for (const suffix of ["", "-wal", "-shm"]) await rm(join(sandbox, "data", `entry-times.sqlite3${suffix}`), { force: true });
    await start();
    // The first read may land while the rebuild runs; it waits or is told to retry.
    let after: Array<Record<string, number>> | undefined;
    for (let attempt = 0; attempt < 50 && !after; attempt += 1) {
      try { after = await Promise.all(roots.map(async (root) => (await client.timedSnapshot(community, root)).times)); }
      catch { await pause(); }
    }
    expect(after).toEqual(before);
  });
});
