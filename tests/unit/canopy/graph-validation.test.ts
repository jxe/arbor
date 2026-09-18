import { test, expect } from "bun:test";
import { encodeWireDirectory, hashObject } from "@arbor/wire";
import { validateGraphChange } from "../../../packages/canopy/src/updates/graph-validation.ts";
function fixture() {
  const objects = new Map<string, Uint8Array>(),
    reads: string[] = [];
  const put = (bytes: Uint8Array) => {
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const file = (text: string) => put(new TextEncoder().encode(text));
  const dir = (entries: any[]) =>
    put(
      encodeWireDirectory({
        type: "directory",
        entries: [...entries].sort((a, b) =>
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
        ),
      }),
    );
  const load = async (hash: string) => {
    reads.push(hash);
    const bytes = objects.get(hash);
    if (!bytes) throw Error("missing");
    return bytes;
  };
  return { objects, reads, put, file, dir, load };
}
const noCollection = async () => {};
test("graph changes read only changed paths regardless of unrelated tree size", async () => {
  for (const count of [10, 1000]) {
    const f = fixture();
    const entries = Array.from({ length: count }, (_, i) => ({
      name: `n-${i}`,
      directory: f.dir([{ name: "file", file: f.file(`text-${i}`) }]),
    }));
    const before = f.dir(entries),
      basis = await validateGraphChange(
        before,
        f.load,
        new Map(),
        noCollection,
      );
    const changed = f.file("edited");
    entries[0] = {
      name: "n-0",
      directory: f.dir([{ name: "file", file: changed }]),
    };
    const after = f.dir(entries);
    f.reads.length = 0;
    const result = await validateGraphChange(
      after,
      f.load,
      new Map(),
      noCollection,
      basis,
    );
    expect(f.reads).toHaveLength(3);
    expect(result).toEqual(
      await validateGraphChange(after, f.load, new Map(), noCollection),
    );
    // A moved subtree is structurally unchanged too.
    entries[0] = { ...entries[0]!, name: "moved" };
    const moved = f.dir(entries);
    f.reads.length = 0;
    await validateGraphChange(moved, f.load, new Map(), noCollection, result);
    expect(f.reads.length).toBeLessThanOrEqual(1);
  }
});
test("incremental graph validation preserves shared-object and kind checks", async () => {
  const f = fixture(),
    file = f.file("hello"),
    sub = f.dir([{ name: "a", file }]);
  const root = f.dir([
    { name: "a", directory: sub },
    { name: "b", directory: sub },
  ]);
  const basis = await validateGraphChange(
    root,
    f.load,
    new Map(),
    noCollection,
  );
  expect(basis.objects.size).toBe(3);
  const conflict = f.dir([
    { name: "a", directory: sub },
    { name: "b", file: sub },
  ]);
  await expect(
    validateGraphChange(conflict, f.load, new Map(), noCollection, basis),
  ).rejects.toThrow("kind conflict");
  // Different roles across versions are legal when the new graph is consistent.
  const retyped = f.dir([{ name: "a", file: sub }]);
  const newProof = await validateGraphChange(
    retyped,
    f.load,
    new Map(),
    noCollection,
    basis,
  );
  expect(newProof.objects.get(sub)?.kind).toBe("file");
});
test("new missing objects and corrupt overlays are rejected despite an accepted basis", async () => {
  const f = fixture(),
    file = f.file("hello"),
    root = f.dir([{ name: "a", file }]);
  const basis = await validateGraphChange(
    root,
    f.load,
    new Map(),
    noCollection,
  );
  await expect(
    validateGraphChange(
      root,
      f.load,
      new Map([[file, new Uint8Array([1])]]),
      noCollection,
      basis,
    ),
  ).rejects.toThrow("hash mismatch");
  const missing = f.file("new");
  f.objects.delete(missing);
  await expect(
    validateGraphChange(
      f.dir([{ name: "a", file: missing }]),
      f.load,
      new Map(),
      noCollection,
      basis,
    ),
  ).rejects.toThrow("missing");
});
test("changed collections are revalidated while unchanged siblings inherit their checks", async () => {
  const f = fixture();
  const make = (text: string) =>
    f.put(
      encodeWireDirectory({
        type: "directory",
        entries: [
          { name: "_store.json", file: f.file(text) },
          { name: "schema.ts", file: f.file("schema") },
        ],
        childrenSource: {
          version: 1,
          type: "collection-file",
          format: "json",
          source: "_store.json",
          schemaSource: "schema.ts",
          schemaFingerprint: f.file("schema") as `sha256:${string}`,
          childSetHash: f.file("set") as `sha256:${string}`,
        },
      }),
    );
  let checks = 0;
  const check = async (
    directory: any,
    load: (hash: string) => Promise<Uint8Array>,
  ) => {
    checks++;
    await load(directory.entries[0].file);
  };
  const old = make("old"),
    basis = await validateGraphChange(old, f.load, new Map(), check);
  await validateGraphChange(old, f.load, new Map(), check, basis);
  expect(checks).toBe(1);
  await validateGraphChange(make("new"), f.load, new Map(), check, basis);
  expect(checks).toBe(2);
});
