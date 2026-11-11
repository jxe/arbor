import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { encodeProtocolDirectory, hashObject, type ObjectHash } from "@ovst/protocol";

let dir: string, store: ObjectStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "story-retained-")); store = new ObjectStore(join(dir, "objects")); });
afterEach(async () => { store.packs.close(); await rm(dir, { recursive: true, force: true }); });

const put = (objects: Map<ObjectHash, Uint8Array>, bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
function tree(files: Record<string, string>) {
  const objects = new Map<ObjectHash, Uint8Array>();
  const entries = Object.keys(files).sort().map((name) => ({ name, file: put(objects, new TextEncoder().encode(files[name]!)), created: 0, modified: 0 }));
  const sub = put(objects, encodeProtocolDirectory({ type: "directory", entries }));
  const root = put(objects, encodeProtocolDirectory({ type: "directory", entries: [{ name: "notes", directory: sub }] }));
  return { root, objects };
}

test("what an answer shares with a retained root is neither read nor freshened", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++) files[`page-${String(i).padStart(2, "0")}.md`] = `page ${i}\n`;
  const head = tree(files);
  await store.store([...head.objects].map(([hash, bytes]) => ({ hash, bytes })));
  const answer = tree({ ...files, "page-07.md": "changed\n" });
  const fresh = new Map([...answer.objects].filter(([hash]) => !head.objects.has(hash)));
  expect(fresh.size).toBe(3);

  const before = store.readCounters.reads;
  await store.verifyReachable([answer.root], fresh, { freshen: true, retained: [head.root] });
  // The retained root's two directories, and nothing of the answer's 49 shared files.
  expect(store.readCounters.reads - before).toBe(2);

  const whole = store.readCounters.reads;
  await store.verifyReachable([answer.root], fresh, { freshen: true });
  expect(store.readCounters.reads - whole).toBe(49);
});

test("a missing object is still found when a retained root is named", async () => {
  const head = tree({ "a.md": "a\n" });
  await store.store([...head.objects].map(([hash, bytes]) => ({ hash, bytes })));
  const answer = tree({ "a.md": "a\n", "b.md": "b\n" });
  const withoutB = new Map([...answer.objects].filter(([hash]) => !head.objects.has(hash) && hash !== hashObject(new TextEncoder().encode("b\n"))));
  await expect(store.verifyReachable([answer.root], withoutB, { freshen: true, retained: [head.root] })).rejects.toThrow("missing");
});
