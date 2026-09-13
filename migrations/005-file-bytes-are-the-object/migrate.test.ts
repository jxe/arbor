import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWireDirectory, hashObject } from "@arbor/wire";
import { createCanopySchema } from "../../packages/canopy/src/schema.ts";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { encodeLegacyObject } from "./legacy.ts";
import { migrateCanopy } from "./run.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arbor-migration-005-"));
  const store = new ObjectStore(join(root, "objects"));
  const bytes = Uint8Array.from([0, 255, 13, 10, 194, 169]);
  const file = encodeLegacyObject({ type: "file", bytes });
  const directory = encodeLegacyObject({ type: "directory", entries: [{ name: "binary", hash: hashObject(file) }, { name: "nested", tree: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb" }] });
  await store.store([file, directory].map(bytes => ({ hash: hashObject(bytes), bytes })));
  const db = new Database(join(root, "canopy.sqlite3"), { create: true });
  createCanopySchema(db);
  db.run("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
  db.run("INSERT INTO trees (id, ref, updated_at) VALUES (?, ?, ?)", ["tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", hashObject(directory), 1]);
  new AcceptedUpdateStore(db).insert({ tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", root: hashObject(directory), previousRoot: null, kind: "initial", acceptedAt: 1 });
  db.close();
  return { root, store, file, bytes, directory };
}

test("migration preserves exact bytes and boundaries, resets history once, and verifies a retry", async () => {
  const f = await fixture();
  try {
    const report = await migrateCanopy(f.root);
    expect(report.fromSchema).toBe("6");
    expect(report.trees).toHaveLength(1);
    const root = report.trees[0]!.root;
    expect(root).not.toBe(hashObject(f.directory));
    const entries = decodeWireDirectory(await f.store.read(root)).entries;
    expect(entries).toEqual([{ name: "binary", file: hashObject(f.bytes) }, { name: "nested", tree: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
    expect(await f.store.read(entries[0]!.file!)).toEqual(f.bytes);
    const db = new Database(join(f.root, "canopy.sqlite3"), { readonly: true });
    const accepted = db.query("SELECT id, kind, previous_root, transition_json FROM accepted_updates").all();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ kind: "restored", previous_root: null, transition_json: null });
    db.close();
    expect((await migrateCanopy(f.root)).alreadyMigrated).toBe(true);
    const again = new Database(join(f.root, "canopy.sqlite3"), { readonly: true });
    expect(again.query("SELECT id, kind, previous_root, transition_json FROM accepted_updates").all()).toEqual(accepted);
    again.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("corrupt legacy payload refuses cutover without advancing roots or schema", async () => {
  const f = await fixture();
  try {
    await writeFile(f.store.path(hashObject(f.file)), "corrupt");
    await expect(migrateCanopy(f.root)).rejects.toThrow("hash mismatch");
    const db = new Database(join(f.root, "canopy.sqlite3"), { readonly: true });
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "6" });
    expect(db.query("SELECT ref FROM trees").get()).toEqual({ ref: hashObject(f.directory) });
    db.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
