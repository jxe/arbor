import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ObjectStore } from "@arbor/object-store";
import { hashObject } from "@arbor/wire";
import { workerObjects } from "../../packages/merge/src/worker-objects.ts";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "worker-objects-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const object = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { hash: hashObject(bytes), bytes };
};
test("worker reads shared storage first and only falls back on absence", async () => {
  const shared = new ObjectStore(join(directory, "shared")),
    staging = new ObjectStore(join(directory, "staging"));
  const a = object("retained"),
    b = object("staged");
  await shared.store([a]);
  await staging.stage([b]);
  const readStaged = spyOn(staging, "read");
  const objects = workerObjects(shared, staging);
  expect(await objects.read(a.hash)).toEqual(a.bytes);
  expect(readStaged).not.toHaveBeenCalled();
  expect(await objects.read(b.hash)).toEqual(b.bytes);
  expect(readStaged).toHaveBeenCalledTimes(1);
  await staging.stage([a]);
  await writeFile(shared.path(a.hash), "corrupt");
  await expect(objects.read(a.hash)).rejects.toThrow(
    "Stored object hash mismatch",
  );
  expect(readStaged).toHaveBeenCalledTimes(1);
});
test("scratch output is not published into accepted storage", async () => {
  const shared = new ObjectStore(join(directory, "shared")),
    staging = new ObjectStore(join(directory, "staging"));
  const a = object("retained"),
    b = object("generated");
  await shared.store([a]);
  await workerObjects(shared, staging).store([a, b]);
  expect(await staging.find(a.hash)).toBeNull();
  expect(await staging.read(b.hash)).toEqual(b.bytes);
  expect(await shared.find(b.hash)).toBeNull();
  // Acceptance explicitly publishes complete scratch bytes durably.
  await shared.store([{ hash: b.hash, bytes: await staging.read(b.hash) }]);
  await rm(join(directory, "staging"), { recursive: true, force: true });
  expect(await shared.read(b.hash)).toEqual(b.bytes);
});
test("scratch publication is immutable, hash checked, and leaves no temporary files", async () => {
  const store = new ObjectStore(join(directory, "objects")),
    a = object("same bytes");
  await Promise.all(Array.from({ length: 5 }, () => store.stage([a])));
  expect(await store.read(a.hash)).toEqual(a.bytes);
  expect(await readdir(dirname(store.path(a.hash)))).toEqual([a.hash.slice(9)]);
  await expect(
    store.stage([{ ...a, bytes: object("wrong").bytes }]),
  ).rejects.toThrow("Object hash mismatch");
  await writeFile(store.path(a.hash), "corrupt");
  await expect(store.stage([a])).rejects.toThrow("Stored object hash mismatch");
  const b = object("also corrupt");
  await mkdir(dirname(store.path(b.hash)), { recursive: true });
  await writeFile(store.path(b.hash), "wrong");
  await expect(store.store([b])).rejects.toThrow("Stored object hash mismatch");
});
