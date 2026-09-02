import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon, migrateCanopy } from "@arbor/canopy";
import { decodeWireObject, encodeWireObject, hashObject, type ObjectHash } from "@arbor/wire";
import { parseDocument, type YAMLMap } from "yaml";

const roots: string[] = [];
const bootstrap = {
  handle: "community",
  name: "Community",
  accounts: [{ handle: "owner", token: "test-token", communityWriter: true }],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function objectCount(dataRoot: string): Promise<number> {
  let count = 0;
  for (const prefix of await readdir(join(dataRoot, "objects"))) count += (await readdir(join(dataRoot, "objects", prefix))).length;
  return count;
}

function readObject(dataRoot: string, hash: ObjectHash): Uint8Array {
  return new Uint8Array(require("node:fs").readFileSync(join(dataRoot, "objects", hash.slice(7, 9), hash.slice(9))));
}

function treesYAML(dataRoot: string, root: ObjectHash): string {
  const directory = decodeWireObject(readObject(dataRoot, root));
  if (directory.type !== "directory") throw new Error("config root is not a directory");
  const entry = directory.entries.find((item) => item.name === "trees.yaml")!;
  const file = decodeWireObject(readObject(dataRoot, entry.hash!));
  if (file.type !== "file") throw new Error("trees.yaml is not a file");
  return new TextDecoder().decode(file.bytes);
}

describe("offline Canopy migration", () => {
  test("brings a pre-stamp data root to the current schema while preserving identities and content", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "arbor-canopy-migrate-"));
    roots.push(dataRoot);
    const canopy = await CanopyDaemon.open(dataRoot, bootstrap);
    await canopy.ensureAccountConfigTrees("https://canopy.test");
    const before = canopy.list().map((tree) => ({ id: tree.id, ref: tree.ref, policy: tree.policy, canonicalPath: tree.canonicalPath }));
    const configTree = before.find((tree) => tree.policy === "account-config-v1")!;
    const communityRef = canopy.community().ref;
    await canopy[Symbol.asyncDispose]();

    // De-migrate to the shape a data root had before the schema stamp: profile
    // kind columns, a per-tree sequence with its index, kind lines in trees.yaml,
    // the members: cache, several history rows per tree, and an orphan object.
    const db = new Database(join(dataRoot, "canopy.sqlite3"));
    db.run("ALTER TABLE boundaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared-subtree'");
    db.run("ALTER TABLE tree_reservations ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared-subtree'");
    db.run("ALTER TABLE accepted_updates ADD COLUMN sequence INTEGER");
    db.run("UPDATE accepted_updates SET sequence = (SELECT COUNT(*) FROM accepted_updates AS o WHERE o.tree_id = accepted_updates.tree_id AND o.rowid <= accepted_updates.rowid)");
    db.run("CREATE UNIQUE INDEX accepted_updates_tree_order ON accepted_updates(tree_id, sequence)");
    // Builds before the single observation log kept a separate events table.
    db.run("DROP TABLE observations");
    db.run("CREATE TABLE observation_events (cursor TEXT PRIMARY KEY, tree_id TEXT NOT NULL, kind TEXT NOT NULL, change_json TEXT, created_at INTEGER NOT NULL)");
    db.run("CREATE TABLE update_replays (id TEXT PRIMARY KEY)");
    db.run("DELETE FROM meta WHERE key = 'schema_version' OR key LIKE 'profile:%'");
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`members:${communityRef}`, JSON.stringify(["canopy.test/~owner"])]);
    const legacyDocument = parseDocument(treesYAML(dataRoot, configTree.ref), { keepSourceTokens: true });
    for (const pair of (legacyDocument.get("trees") as YAMLMap).items) (pair.value as YAMLMap).set("kind", "person-profile");
    const legacySource = legacyDocument.toString();
    expect(legacySource).toContain("kind: person-profile");
    const legacyFile = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(legacySource) });
    const configDirectory = decodeWireObject(readObject(dataRoot, configTree.ref));
    if (configDirectory.type !== "directory") throw new Error("unexpected");
    const legacyRoot = encodeWireObject({
      type: "directory",
      entries: configDirectory.entries.map((item) => item.name === "trees.yaml" ? { name: item.name, hash: hashObject(legacyFile) } : item),
    });
    const write = (bytes: Uint8Array) => {
      const hash = hashObject(bytes);
      require("node:fs").mkdirSync(join(dataRoot, "objects", hash.slice(7, 9)), { recursive: true });
      require("node:fs").writeFileSync(join(dataRoot, "objects", hash.slice(7, 9), hash.slice(9)), bytes);
      return hash;
    };
    write(legacyFile);
    const legacyConfigRef = write(legacyRoot);
    db.run("UPDATE trees SET ref = ? WHERE id = ?", [legacyConfigRef, configTree.id]);
    const orphan = write(encodeWireObject({ type: "file", bytes: new TextEncoder().encode("history only") }));
    db.close();
    const objectsBefore = await objectCount(dataRoot);

    const report = await migrateCanopy(dataRoot);
    expect(report.trees.map((tree) => tree.id).sort()).toEqual(before.map((tree) => tree.id).sort());
    expect(report.accounts).toBe(1);
    expect(report.prunedObjects).toBeGreaterThanOrEqual(1);
    expect(await objectCount(dataRoot)).toBe(objectsBefore - report.prunedObjects);
    expect(await objectCount(dataRoot)).toBe(report.retainedObjects);
    expect(() => readObject(dataRoot, orphan)).toThrow();
    await expect(migrateCanopy(dataRoot)).rejects.toThrow(`already at schema version ${CANOPY_SCHEMA_VERSION}`);

    const reopened = await CanopyDaemon.open(dataRoot);
    try {
      for (const tree of before) {
        const after = reopened.get(tree.id)!;
        expect(after.canonicalPath).toBe(tree.canonicalPath);
        if (tree.policy !== "account-config-v1") expect(after.ref).toBe(tree.ref);
        const history = reopened.acceptedUpdates(tree.id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ kind: "restored", previousRoot: null, root: after.ref });
        expect(Number.isInteger(Number(history[0]!.id))).toBe(true);
        expect(reopened.observedThrough(tree.id)).toBe(history[0]!.id);
      }
      const migratedConfig = reopened.get(configTree.id)!;
      const migratedTrees = parseDocument(treesYAML(dataRoot, migratedConfig.ref)).get("trees") as YAMLMap;
      for (const pair of migratedTrees.items) expect((pair.value as YAMLMap).has("kind")).toBe(false);
      expect(treesYAML(dataRoot, migratedConfig.ref)).toBe(treesYAML(dataRoot, configTree.ref));
      expect(reopened.rootProfileType(reopened.community().ref)).toBe("group");
      const check = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
      expect(check.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'members:%'").get()).toEqual({ n: 0 });
      expect((check.query("PRAGMA table_info(boundaries)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("kind");
      for (const legacy of ["observation_events", "update_replays"]) {
        expect(check.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(legacy)).toBeNull();
      }
      check.close();
    } finally {
      await reopened[Symbol.asyncDispose]();
    }
  });
});
