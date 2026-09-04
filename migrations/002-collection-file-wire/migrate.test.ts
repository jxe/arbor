import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon } from "@arbor/canopy";
import { canonicalCBORHash, encodeCanonicalCBOR, type Hash } from "@arbor/core";
import { decodeWireObject, encodeWireObject, hashObject } from "@arbor/wire";
import { migrate } from "./run.ts";

const roots: string[] = [];
const bootstrap = {
  handle: "community",
  name: "Community",
  accounts: [{ handle: "owner", token: "test-token", communityWriter: true }],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function objectPath(dataRoot: string, hash: string): string {
  return join(dataRoot, "objects", hash.slice(7, 9), hash.slice(9));
}

function write(dataRoot: string, bytes: Uint8Array): Hash {
  const hash = hashObject(bytes) as Hash;
  mkdirSync(join(dataRoot, "objects", hash.slice(7, 9)), { recursive: true });
  writeFileSync(objectPath(dataRoot, hash), bytes);
  return hash;
}

async function schema3Fixture(ambiguousSchema = false): Promise<{ dataRoot: string; tree: string; oldRoot: Hash; sources: Map<string, Hash> }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "arbor-migration-002-"));
  roots.push(dataRoot);
  const canopy = await CanopyDaemon.open(dataRoot, bootstrap);
  await canopy.ensureAccountConfigTrees("https://canopy.test");
  const community = canopy.community();
  await canopy[Symbol.asyncDispose]();
  const currentRoot = decodeWireObject(new Uint8Array(readFileSync(objectPath(dataRoot, community.ref))));
  if (currentRoot.type !== "directory") throw new Error("community root is not a directory");

  const schemaSource = write(dataRoot, encodeWireObject({ type: "file", bytes: new TextEncoder().encode("export const schema = {}\n") }));
  const otherSchema = write(dataRoot, encodeWireObject({ type: "file", bytes: new TextEncoder().encode("export const schema = { other: true }\n") }));
  const sources = new Map<string, Hash>();
  const collectionHashes: Array<{ name: string; hash: Hash }> = [];
  for (const format of ["csv", "json", "jsonl"] as const) {
    const sourceBytes = format === "csv" ? "id,title\none,One\n" : format === "json" ? '[{"id":"one","title":"One"}]\n' : '{"id":"one","title":"One"}\n';
    const source = write(dataRoot, encodeWireObject({ type: "file", bytes: new TextEncoder().encode(sourceBytes) }));
    sources.set(format, source);
    const childSetHash = canonicalCBORHash([{ key: '[["id","one"]]', name: "one", properties: { id: "one", title: "One" } }]);
    const entries = [
      { name: `_store.${format}`, rollup: { version: 1, codec: format, source, schemaSource, schema: `sha256:${"3".repeat(64)}`, scope: "children", modelHash: childSetHash } },
      { name: "schema.ts", hash: ambiguousSchema && format === "json" ? otherSchema : schemaSource },
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    collectionHashes.push({ name: format, hash: write(dataRoot, encodeCanonicalCBOR({ type: "directory", entries })) });
  }
  const rootEntries = [
    ...currentRoot.entries.map((entry) => ({ ...entry })),
    ...collectionHashes,
  ].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const oldRoot = write(dataRoot, encodeCanonicalCBOR({ type: "directory", entries: rootEntries }));
  const db = new Database(join(dataRoot, "canopy.sqlite3"));
  db.run("UPDATE trees SET ref = ? WHERE id = ?", [oldRoot, community.id]);
  db.run("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  db.close();
  return { dataRoot, tree: community.id, oldRoot, sources };
}

describe("migration 002: collection-file Wire descriptor", () => {
  test("rewrites all formats and ancestors, preserves source hashes, and stamps schema 4", async () => {
    const fixture = await schema3Fixture();
    const report = await migrate(fixture.dataRoot);
    expect(report.fromSchema).toBe("3");
    expect(report.toSchema).toBe(CANOPY_SCHEMA_VERSION);
    const migrated = report.trees.find((tree) => tree.id === fixture.tree)!;
    expect(migrated.previousRoot).toBe(fixture.oldRoot);
    expect(migrated.rewritten).toBe(true);
    const newRoot = decodeWireObject(new Uint8Array(readFileSync(objectPath(fixture.dataRoot, migrated.root))));
    if (newRoot.type !== "directory") throw new Error("migrated root is not a directory");
    for (const format of ["csv", "json", "jsonl"] as const) {
      const hash = newRoot.entries.find((entry) => entry.name === format)?.hash;
      expect(hash).toBeDefined();
      const child = decodeWireObject(new Uint8Array(readFileSync(objectPath(fixture.dataRoot, hash!))));
      if (child.type !== "directory") throw new Error("migrated collection is not a directory");
      expect(child.childrenSource).toMatchObject({
        type: "collection-file",
        format,
        source: `_store.${format}`,
        schemaSource: "schema.ts",
      });
      expect(child.entries.find((entry) => entry.name === `_store.${format}`)?.hash).toBe(fixture.sources.get(format));
      expect(child.entries.filter((entry) => entry.name === "schema.ts")).toHaveLength(1);
    }
    const db = new Database(join(fixture.dataRoot, "canopy.sqlite3"), { readonly: true });
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "4" });
    expect(db.query("SELECT kind, root FROM accepted_updates WHERE tree_id = ?").all(fixture.tree)).toEqual([{ kind: "restored", root: migrated.root }]);
    db.close();
    await expect(migrate(fixture.dataRoot)).rejects.toThrow("already at schema version 4");
    const server = await CanopyDaemon.open(fixture.dataRoot);
    expect(server.community().ref).toBe(migrated.root);
    await server[Symbol.asyncDispose]();
  });

  test("refuses an ambiguous existing schema entry without changing the stamp or ref", async () => {
    const fixture = await schema3Fixture(true);
    await expect(migrate(fixture.dataRoot)).rejects.toThrow("Conflicting schema.ts entry");
    const db = new Database(join(fixture.dataRoot, "canopy.sqlite3"), { readonly: true });
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "3" });
    expect(db.query("SELECT ref FROM trees WHERE id = ?").get(fixture.tree)).toEqual({ ref: fixture.oldRoot });
    db.close();
  });
});
