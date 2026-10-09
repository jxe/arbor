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
  // A document's versions share one frame; small objects share frames too.
  const frame = reader.packs.locate(docs[0]!.hash)!;
  expect(frame.encoding).toBe(Encoding.Member);
  for (const d of docs) expect(reader.packs.locate(d.hash)!.offset).toBe(frame.offset);
  expect(reader.packs.locate(smalls[0]!.hash)!.encoding).toBe(Encoding.Member);
  expect(await reader.find(object("absent").hash)).toBeNull();
});

test("an object as large as a frame is packed alone, and frames end where documents do", async () => {
  const { root, store } = fresh();
  const large = { ...object("x".repeat(2 << 20)), key: "large" };
  const a = versions(3, "a"), b = versions(3, "b");
  await store.store([large, ...a, ...b]);
  await store.pack([large, ...a, ...b], { frameBytes: 1 << 20 });
  const reader = new ObjectStore(root);
  expect(reader.packs.locate(large.hash)!.encoding).toBe(Encoding.Zstd);
  expect(await reader.read(large.hash)).toEqual(large.bytes);
  // Each document is under half a frame, so both share one.
  expect(reader.packs.locate(a[0]!.hash)!.offset).toBe(reader.packs.locate(b[2]!.hash)!.offset);
  await store.store(versions(3, "c"));
  const c = versions(3, "c");
  await store.pack(c, { frameBytes: 40_000 });
  // A small frame: a document of about 3 × 25 KB spans frames.
  expect(new Set(c.map((v) => reader.packs.locate(v.hash)!.offset)).size).toBeGreaterThan(1);
  for (const o of [large, ...a, ...b, ...c]) expect(await new ObjectStore(root).read(o.hash)).toEqual(o.bytes);
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

test("unpacking writes every packed object back loose and removes the packs", async () => {
  const { root, store } = fresh();
  const docs = versions(5);
  await store.store(docs);
  await store.pack(docs);
  expect(await exists(store.path(docs[0]!.hash))).toBe(false);
  expect(await store.unpack()).toEqual({ objects: 5, bytes: docs.reduce((n, d) => n + d.bytes.byteLength, 0) });
  for (const o of docs) {
    expect(await exists(store.path(o.hash))).toBe(true);
    expect(await new ObjectStore(root).read(o.hash)).toEqual(o.bytes);
  }
  expect(readdirSync(join(root, "packs")).filter((n) => n.endsWith(".pack"))).toEqual([]);
});
