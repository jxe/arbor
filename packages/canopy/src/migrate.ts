import { Database } from "bun:sqlite";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { decodeWireObject, encodeWireObject, hashObject, type ObjectHash } from "@arbor/wire";
import { ObjectStore } from "./objects.ts";
import { rootProfileFacts } from "./profile.ts";
import { CANOPY_SCHEMA_VERSION, assertCurrentCanopySchema } from "./schema.ts";
import { AcceptedUpdateStore } from "./updates/store.ts";

export interface CanopyMigrationReport {
  trees: Array<{ id: string; policy: string; refBefore: ObjectHash; refAfter: ObjectHash }>;
  accounts: number;
  activeDevices: number;
  accessRules: number;
  boundaries: number;
  retainedObjects: number;
  prunedObjects: number;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

/** Rewrite a configuration tree's `trees.yaml` without per-tree `kind` lines, preserving comments and order. */
async function stripTreeKinds(objects: ObjectStore, root: ObjectHash): Promise<ObjectHash> {
  const directory = decodeWireObject(await objects.read(root));
  if (directory.type !== "directory") return root;
  const entry = directory.entries.find((item) => item.name === "trees.yaml");
  if (!entry?.hash) return root;
  const file = decodeWireObject(await objects.read(entry.hash));
  if (file.type !== "file") return root;
  const source = new TextDecoder().decode(file.bytes);
  const document = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true });
  const trees = document.get("trees");
  let changed = false;
  if (isMap(trees)) {
    for (const pair of trees.items) {
      if (isMap(pair.value) && pair.value.has("kind")) {
        pair.value.delete("kind");
        changed = true;
      }
    }
  }
  if (!changed) return root;
  const rewritten = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(document.toString()) });
  const rewrittenHash = hashObject(rewritten);
  const nextDirectory = encodeWireObject({
    type: "directory",
    entries: directory.entries.map((item) => item.name === "trees.yaml" ? { name: item.name, hash: rewrittenHash } : item),
  });
  const nextRoot = hashObject(nextDirectory);
  await objects.store([{ hash: rewrittenHash, bytes: rewritten }, { hash: nextRoot, bytes: nextDirectory }]);
  return nextRoot;
}

/**
 * Bring a Canopy data root written before the schema stamp up to the current
 * schema offline, in place. Accounts, devices, TreeIDs, ACLs, boundaries, and
 * every tree's current content survive; accepted history, transitions, and
 * observation cursors are reset to one restored update per tree, and objects no
 * longer reachable from a current root are deleted. Run it against a copy first.
 */
export async function migrateCanopy(dataRoot: string): Promise<CanopyMigrationReport> {
  const db = new Database(join(dataRoot, "canopy.sqlite3"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null;
    if (stamp === CANOPY_SCHEMA_VERSION) throw new Error(`Canopy data root is already at schema version ${stamp}`);
    if (stamp !== null) throw new Error(`Canopy data root has unknown schema version ${stamp}`);
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const trees = db.query("SELECT id, ref, policy FROM trees ORDER BY rowid").all() as Array<{ id: string; ref: ObjectHash; policy: string }>;

    // Asynchronous preparation first: new configuration roots and profile facts.
    const nextRefs = new Map<string, ObjectHash>();
    for (const tree of trees) {
      nextRefs.set(tree.id, tree.policy === "account-config-v1" ? await stripTreeKinds(objects, tree.ref) : tree.ref);
    }
    const profiles = new Map<ObjectHash, string>();
    for (const ref of nextRefs.values()) {
      profiles.set(ref, JSON.stringify(await rootProfileFacts(ref, (hash) => objects.read(hash))));
    }

    const now = Date.now();
    db.transaction(() => {
      for (const table of ["boundaries", "tree_reservations"]) {
        if (columns(db, table).includes("kind")) db.run(`ALTER TABLE ${table} DROP COLUMN kind`);
      }
      db.run("DROP INDEX IF EXISTS accepted_updates_tree_order");
      if (columns(db, "accepted_updates").includes("sequence")) db.run("ALTER TABLE accepted_updates DROP COLUMN sequence");
      for (const tree of trees) {
        const next = nextRefs.get(tree.id)!;
        if (next !== tree.ref) db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ?", [next, now, tree.id]);
      }
      db.run("DELETE FROM meta WHERE key LIKE 'members:%' OR key LIKE 'profile:%'");
      for (const [ref, facts] of profiles) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`profile:${ref}`, facts]);
      db.run("DELETE FROM accepted_updates");
      db.run("DELETE FROM reflog");
      db.run("DELETE FROM observations");
      const store = new AcceptedUpdateStore(db);
      for (const tree of trees) {
        const ref = nextRefs.get(tree.id)!;
        store.insert({ tree: tree.id, root: ref, previousRoot: null, kind: "restored", acceptedAt: now });
        db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [tree.id, ref, now]);
      }
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [CANOPY_SCHEMA_VERSION]);
    })();

    // Prune objects that only history reached.
    const reachable = new Set<ObjectHash>();
    for (const ref of nextRefs.values()) {
      for (const hash of (await objects.completeSnapshot(ref)).objects.keys()) reachable.add(hash);
    }
    let pruned = 0;
    const objectRoot = join(dataRoot, "objects");
    for (const prefix of await readdir(objectRoot)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      for (const rest of await readdir(join(objectRoot, prefix))) {
        const hash = `sha256:${prefix}${rest}` as ObjectHash;
        if (reachable.has(hash)) continue;
        await rm(join(objectRoot, prefix, rest), { force: true });
        pruned += 1;
      }
    }

    assertCurrentCanopySchema(db);
    await objects.verifyReachable([...nextRefs.values()]);
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    return {
      trees: trees.map((tree) => ({ id: tree.id, policy: tree.policy, refBefore: tree.ref, refAfter: nextRefs.get(tree.id)! })),
      accounts: count("SELECT COUNT(*) AS n FROM accounts"),
      activeDevices: count("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL"),
      accessRules: count("SELECT COUNT(*) AS n FROM access"),
      boundaries: count("SELECT COUNT(*) AS n FROM boundaries"),
      retainedObjects: reachable.size,
      prunedObjects: pruned,
    };
  } finally {
    db.close();
  }
}
