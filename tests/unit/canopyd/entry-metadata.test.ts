import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry } from "@overstory/protocol";
import { documentKey, entryChanges } from "../../../packages/canopyd/src/updates/entry-metadata.ts";

const objects = new Map<ObjectHash, Uint8Array>();
const file = (text: string) => { const bytes = new TextEncoder().encode(text), hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const dir = (entries: Record<string, ObjectHash | { directory: ObjectHash }>) => {
  const list: ProtocolDirectoryEntry[] = Object.entries(entries).map(([name, value]) =>
    typeof value === "string" ? { name, file: value } : { name, directory: value.directory });
  list.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeProtocolDirectory({ type: "directory", entries: list }), hash = hashObject(bytes);
  objects.set(hash, bytes); return hash;
};
const load = async (hash: ObjectHash) => objects.get(hash)!;

test("the document key is the one frontmatter id, else the entry path", () => {
  expect(documentKey("/a.md", "---\nid: pg_1\n---\nBody")).toBe("id:pg_1");
  expect(documentKey("/a.md", "---\r\nid: \"pg_2\"\r\n---\r\n")).toBe("id:pg_2");
  expect(documentKey("/a.md", "---\nid: one\nid: two\n---\n")).toBe("path:/a.md");
  expect(documentKey("/a.md", "id: not frontmatter\n")).toBe("path:/a.md");
});

test("changes report written files, expand directories and ignore unchanged ones", async () => {
  const keep = file("keep"), note = file("---\nid: pg_note\n---\nnote");
  const before = dir({ "keep.txt": keep, "note.md": note, old: { directory: dir({ "a.md": file("a"), "b.bin": file("b") }) } });
  const after = dir({ "keep.txt": keep, "moved.md": note, fresh: { directory: dir({ "c.md": file("c") }) } });
  const changes = await entryChanges(before, after, load);
  expect(changes.set.map((c) => [c.path, c.document?.key]).sort()).toEqual([
    ["/fresh/c.md", "path:/fresh/c.md"], ["/moved.md", "id:pg_note"],
  ]);
  expect(changes.removed.sort()).toEqual(["/note.md", "/old/a.md", "/old/b.bin"]);
  const initial = await entryChanges(null, after, load);
  expect(initial.set.map((c) => c.path).sort()).toEqual(["/fresh/c.md", "/keep.txt", "/moved.md"]);
  expect(initial.removed).toEqual([]);
});

test("a file replaced in place is only set", async () => {
  const changes = await entryChanges(dir({ "a.md": file("one") }), dir({ "a.md": file("two") }), load);
  expect(changes.set.map((c) => c.path)).toEqual(["/a.md"]);
  expect(changes.removed).toEqual([]);
});

let data: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
const token = "entry-metadata-owner";
beforeEach(async () => {
  data = await mkdtemp(`${tmpdir()}/arbor-entry-metadata-`);
  running = await serveHost({ dataRoot: data, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = new ProtocolClient(running.url, token);
});
afterEach(async () => { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); await rm(data, { recursive: true, force: true }); });

test("accepted updates keep entry times and document versions, served by the metadata route", async () => {
  const tree = (await client.account()).account.community.id;
  let head = (await client.descriptor(tree)).tree;
  const initial = await client.snapshot(tree, head.root);
  for (const [hash, bytes] of initial.objects) objects.set(hash, bytes);
  const existing = decodeProtocolDirectory(objects.get(initial.root)!).entries;
  // The community tree's own entries stay; the test adds its files beside them.
  const tree_ = (entries: Record<string, ObjectHash>) => {
    const list: ProtocolDirectoryEntry[] = [...existing, ...Object.entries(entries).map(([name, hash]) => ({ name, file: hash }))];
    list.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const bytes = encodeProtocolDirectory({ type: "directory", entries: list }), hash = hashObject(bytes);
    objects.set(hash, bytes); return hash;
  };
  const submit = async (root: ObjectHash) => {
    const result = await client.submitUpdate(tree, head.update, { root, objects });
    head = { ...head, update: result.update.id as typeof head.update, root: result.update.root as typeof head.root };
    return result.update;
  };
  const route = async () => {
    const response = await fetch(`${running.url}/.arbor/trees/${encodeURIComponent(tree)}/entry-metadata`, { headers: { authorization: `Bearer ${token}` } });
    return await response.json() as { update: string; entries: Record<string, { modifiedAt: number }> };
  };
  const page = "---\nid: pg_trip\n---\nTrip";
  const first = await submit(tree_({ "trip.md": file(page), "photo.png": file("png") }));
  const second = await submit(tree_({ "trip.md": file(page + "!"), "photo.png": file("png") }));
  const third = await submit(tree_({ "renamed.md": file(page + "!"), "photo.png": file("png") }));
  const metadata = await route();
  expect(metadata.update).toBe(third.id);
  expect(Object.keys(metadata.entries)).toContain("/photo.png");
  expect(Object.keys(metadata.entries)).toContain("/renamed.md");
  expect(Object.keys(metadata.entries)).not.toContain("/trip.md");
  expect(metadata.entries["/photo.png"]!.modifiedAt).toBe(first.acceptedAt);
  expect(metadata.entries["/renamed.md"]!.modifiedAt).toBe(third.acceptedAt);
  const db = new Database(`${data}/canopy.sqlite3`, { readonly: true });
  try {
    const versions = db.query("SELECT update_id, entry_path FROM document_versions WHERE tree_id = ? AND stable_key = ? ORDER BY rowid")
      .all(tree, "id:pg_trip") as Array<{ update_id: string; entry_path: string }>;
    // The rename carried no content change, so it is not a version.
    expect(versions).toEqual([{ update_id: first.id, entry_path: "/trip.md" }, { update_id: second.id, entry_path: "/trip.md" }]);
  } finally { db.close(); }
  // Read access follows the snapshot route exactly; an unknown tree is not found.
  const anonymous = await fetch(`${running.url}/.arbor/trees/${encodeURIComponent(tree)}/entry-metadata`);
  const snapshot = await fetch(`${running.url}/.arbor/trees/${encodeURIComponent(tree)}/snapshots/${head.root}`);
  expect(anonymous.status).toBe(snapshot.status);
  expect((await fetch(`${running.url}/.arbor/trees/tr_missing/entry-metadata`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
});
