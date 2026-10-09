import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashObject } from "@overstory/protocol";
import { Encoding, holdsObject, ObjectStore } from "@overstory/object-store";

const text = (value: string) => new TextEncoder().encode(value);
const object = (value: string) => { const bytes = text(value); return { hash: hashObject(bytes), bytes }; };
const exists = (path: string) => access(path).then(() => true, () => false);

/** Versions of one long document, each a small edit of the one before. */
function versions(count: number, key = "doc") {
  const lines = Array.from({ length: 400 }, (_, i) => `Line ${i} of ${key}, with enough words to be worth compressing.`);
  return Array.from({ length: count }, (_, v) => {
    lines[(v * 37) % lines.length] = `Edited in version ${v}.`;
    return { ...object(lines.join("\n")), key };
  });
}

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "arbor-packs-"));
  return { root, store: new ObjectStore(root) };
}

test("packed objects read identically, are present, and their loose files are gone", async () => {
  const { root, store } = fresh();
  const docs = versions(12);
  const smalls = Array.from({ length: 30 }, (_, i) => ({ ...object(`small ${i}`), key: `small-${i}` }));
  await store.store([...docs, ...smalls]);
  const result = await store.pack([...docs, ...smalls]);
  expect(result.packed).toBe(42);
  expect(result.packBytes).toBeLessThan(result.bytes / 5);
  const reader = new ObjectStore(root);
  for (const o of [...docs, ...smalls]) {
    expect(await exists(store.path(o.hash))).toBe(false);
    expect(await reader.read(o.hash)).toEqual(o.bytes);
    expect(await holdsObject(reader, o.hash)).toBe(true);
  }
  // Later versions are deltas; small objects share frames.
  expect(reader.packs.locate(docs[5]!.hash)!.encoding).toBe(Encoding.Delta);
  expect(reader.packs.locate(smalls[0]!.hash)!.encoding).toBe(Encoding.Member);
  expect(await reader.find(object("absent").hash)).toBeNull();
});

test("a later pass deltas the next version against the last packed one", async () => {
  const { store } = fresh();
  const docs = versions(6);
  await store.store(docs);
  await store.pack(docs.slice(0, 3));
  await store.pack(docs.slice(3));
  const next = store.packs.locate(docs[3]!.hash)!;
  expect(next.encoding).toBe(Encoding.Delta);
  expect(next.base).toBe(docs[2]!.hash);
  for (const o of docs) expect(await new ObjectStore(store.packs.directory.slice(0, -6)).read(o.hash)).toEqual(o.bytes);
});

test("freshening and storing again keep a packed object packed", async () => {
  const { store } = fresh();
  const docs = versions(3);
  await store.store(docs);
  await store.pack(docs);
  await store.freshen(docs.map((d) => d.hash));
  await store.store([docs[1]!]);
  expect(await exists(store.path(docs[1]!.hash))).toBe(false);
  await expect(store.freshen([object("never stored").hash])).rejects.toThrow("Stored object vanished");
});

test("a pack whose bytes do not match its index fails the read", async () => {
  const { root, store } = fresh();
  const docs = versions(3);
  await store.store(docs);
  await store.pack(docs);
  const name = readdirSync(join(root, "packs")).find((n) => n.endsWith(".pack"))!;
  const bytes = readFileSync(join(root, "packs", name));
  bytes[10] = bytes[10]! ^ 0xff;
  writeFileSync(join(root, "packs", name), bytes);
  await expect(new ObjectStore(root).read(docs[0]!.hash)).rejects.toThrow();
});

test("an interrupted pass leaves every object readable and a rerun converges", async () => {
  const { root, store } = fresh();
  const docs = versions(4);
  await store.store(docs);
  // A pack written but never indexed is an orphan; loose files are intact.
  store.packs.index(true);
  writeFileSync(join(store.packs.directory, `${"0".repeat(64)}.pack`), "partial");
  expect(await store.packs.removeOrphans()).toEqual([]); // Too new: maybe another pass's.
  expect(await store.packs.removeOrphans(0)).toEqual([`${"0".repeat(64)}.pack`]);
  for (const o of docs) expect(await store.read(o.hash)).toEqual(o.bytes);
  // Indexed and still loose (a crash before the loose files went): both read,
  // and packing again changes nothing but removes the loose files.
  await store.packs.write([{ hash: docs[0]!.hash, encoding: Encoding.Raw, body: docs[0]!.bytes, size: docs[0]!.bytes.byteLength }]);
  expect(await new ObjectStore(root).read(docs[0]!.hash)).toEqual(docs[0]!.bytes);
  await store.pack(docs);
  for (const o of docs) {
    expect(await exists(store.path(o.hash))).toBe(false);
    expect(await new ObjectStore(root).read(o.hash)).toEqual(o.bytes);
  }
});
