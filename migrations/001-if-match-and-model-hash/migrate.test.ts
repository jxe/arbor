import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon } from "@arbor/canopy";
import { encodeCanonicalCBOR, canonicalCBORHash, type Hash } from "@arbor/core";
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

describe("migration 001: modelDigest becomes modelHash", () => {
  test("re-encodes rollup entries, re-roots the tree, resets history, and stamps schema 3", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "arbor-migration-001-"));
    roots.push(dataRoot);
    const canopy = await CanopyDaemon.open(dataRoot, bootstrap);
    await canopy.ensureAccountConfigTrees("https://canopy.test");
    const community = canopy.community();
    const before = canopy.list().map((tree) => ({ id: tree.id, ref: tree.ref }));
    await canopy[Symbol.asyncDispose]();

    // De-migrate: give the community root an old-style rollup entry and stamp version 2.
    const root = decodeWireObject(new Uint8Array(readFileSync(objectPath(dataRoot, community.ref))));
    if (root.type !== "directory") throw new Error("community root is not a directory");
    const source = write(dataRoot, encodeWireObject({ type: "file", bytes: new TextEncoder().encode("id,title\nx,X\n") }));
    const schemaSource = write(dataRoot, encodeWireObject({ type: "file", bytes: new TextEncoder().encode("export const schema = {}\n") }));
    const modelDigest = canonicalCBORHash([{ key: '[["id","x"]]', path: "x", properties: { id: "x", title: "X" } }]);
    const oldEntries = [
      ...root.entries.map((entry) => ({ ...entry })),
      { name: "_store.csv", rollup: { version: 1, codec: "csv", source, schemaSource, schema: `sha256:${"3".repeat(64)}`, scope: "children", modelDigest } },
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    const oldRoot = write(dataRoot, encodeCanonicalCBOR({ type: "directory", entries: oldEntries }));
    expect(() => decodeWireObject(new Uint8Array(readFileSync(objectPath(dataRoot, oldRoot))))).toThrow();
    const db = new Database(join(dataRoot, "canopy.sqlite3"));
    db.run("UPDATE trees SET ref = ? WHERE id = ?", [oldRoot, community.id]);
    db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    db.close();

    const report = await migrate(dataRoot);
    const migrated = report.trees.find((tree) => tree.id === community.id)!;
    expect(migrated.rewritten).toBe(true);
    expect(migrated.previousRoot).toBe(oldRoot);
    expect(report.trees.filter((tree) => tree.id !== community.id).every((tree) => !tree.rewritten)).toBe(true);
    expect(report.trees.map((tree) => tree.id).sort()).toEqual(before.map((tree) => tree.id).sort());

    const newRoot = decodeWireObject(new Uint8Array(readFileSync(objectPath(dataRoot, migrated.root))));
    if (newRoot.type !== "directory") throw new Error("migrated root is not a directory");
    const rollup = newRoot.entries.find((entry) => entry.name === "_store.csv")?.rollup;
    expect(rollup?.modelHash).toBe(modelDigest);
    expect(rollup?.source).toBe(source);

    const reopened = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
    expect(reopened.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: CANOPY_SCHEMA_VERSION });
    const history = reopened.query(`SELECT kind, root FROM accepted_updates WHERE tree_id = '${community.id}'`).all();
    expect(history).toEqual([{ kind: "restored", root: migrated.root }]);
    reopened.close();
    await expect(migrate(dataRoot)).rejects.toThrow("already at schema version 3");

    const server = await CanopyDaemon.open(dataRoot);
    expect(server.community().ref).toBe(migrated.root);
    await server[Symbol.asyncDispose]();
  });
});
