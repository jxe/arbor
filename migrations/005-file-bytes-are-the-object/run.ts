import { Database } from "bun:sqlite";
import { readdir, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { decodeWireDirectory, encodeWireDirectory, hashObject, verifyTreeSnapshotGraph, type ObjectHash, type WireDirectoryEntry } from "@arbor/wire";
import { decodeLegacyObject } from "./legacy.ts";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { rootProfileFacts } from "../../packages/canopy/src/profile.ts";

/** Offline only. Caller must quiesce writers and preserve a verified rollback archive. */
export async function migrateCanopy(dataRoot: string) {
  const root = await realpath(dataRoot);
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  const store = new ObjectStore(join(root, "objects"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value;
    if (stamp !== "6" && stamp !== "7") throw new Error(`Expected schema 6 or 7, found ${stamp}`);
    if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("SQLite integrity check failed");
    const trees = db.query("SELECT id, ref FROM trees ORDER BY id").all() as Array<{ id: string; ref: ObjectHash }>;
    const generated = new Map<ObjectHash, Uint8Array>();
    const memo = new Map<ObjectHash, { hash: ObjectHash; kind: "file" | "directory" }>();
    const visiting = new Set<ObjectHash>();
    async function rewrite(hash: ObjectHash): Promise<{ hash: ObjectHash; kind: "file" | "directory" }> {
      if (memo.has(hash)) return memo.get(hash)!;
      if (visiting.has(hash)) throw new Error("Legacy graph cycle");
      visiting.add(hash);
      const old = decodeLegacyObject(await store.read(hash));
      let bytes: Uint8Array;
      if (old.type === "file") bytes = old.bytes;
      else {
        const entries: WireDirectoryEntry[] = [];
        for (const entry of old.entries) {
          if (entry.tree) entries.push({ name: entry.name, tree: entry.tree });
          else {
            const child = await rewrite(entry.hash!);
            entries.push(child.kind === "file" ? { name: entry.name, file: child.hash } : { name: entry.name, directory: child.hash });
          }
        }
        bytes = encodeWireDirectory({ type: "directory", entries, ...(old.childrenSource ? { childrenSource: old.childrenSource } : {}) });
      }
      const result = { hash: hashObject(bytes), kind: old.type };
      generated.set(result.hash, bytes);
      memo.set(hash, result);
      visiting.delete(hash);
      return result;
    }
    // Fingerprints compare exact file bytes and nested-tree identity at every path.
    async function manifest(hash: string, legacy: boolean): Promise<string> {
      const rows: Array<[string, string, string]> = [];
      async function walk(h: string, path: string, kind: "file" | "directory") {
        const bytes = generated.get(h) ?? await store.read(h);
        if (legacy) {
          const value = decodeLegacyObject(bytes);
          if (value.type === "file") { rows.push([path, "file", hashObject(value.bytes)]); return; }
          rows.push([path, "directory", ""]);
          for (const entry of value.entries) {
            if (entry.tree) rows.push([`${path}/${entry.name}`, "tree", entry.tree]);
            else await walk(entry.hash!, `${path}/${entry.name}`, "directory");
          }
        } else if (kind === "file") rows.push([path, "file", hashObject(bytes)]);
        else {
          rows.push([path, "directory", ""]);
          for (const entry of decodeWireDirectory(bytes).entries) {
            if (entry.tree) rows.push([`${path}/${entry.name}`, "tree", entry.tree]);
            else await walk((entry.file ?? entry.directory)!, `${path}/${entry.name}`, entry.file ? "file" : "directory");
          }
        }
      }
      await walk(hash, "", "directory");
      return JSON.stringify(rows);
    }
    const changed: Array<{ id: string; previousRoot: string; root: string }> = [];
    for (const tree of trees) {
      const next = stamp === "7" ? tree.ref : (await rewrite(tree.ref)).hash;
      if (stamp === "6" && await manifest(tree.ref, true) !== await manifest(next, false)) throw new Error(`File fidelity failed for ${tree.id}`);
      changed.push({ id: tree.id, previousRoot: tree.ref, root: next });
    }
    await store.store([...generated].map(([hash, bytes]) => ({ hash, bytes })));
    for (const tree of changed) verifyTreeSnapshotGraph(await store.completeSnapshot(tree.root));
    const profiles = new Map<string, string>();
    for (const tree of changed) profiles.set(tree.root, JSON.stringify(await rootProfileFacts(tree.root, hash => store.read(hash))));
    if (stamp === "6") {
      const now = Date.now();
      db.transaction(() => {
        // All graph bytes are durable before the database switches roots.
        db.run("DELETE FROM accepted_updates");
        db.run("DELETE FROM observations");
        db.run("DELETE FROM reflog");
        db.run("DELETE FROM meta WHERE key LIKE 'profile:%'");
        const updates = new AcceptedUpdateStore(db);
        for (const tree of changed) {
          db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ?", [tree.root, now, tree.id]);
          updates.insert({ tree: tree.id, root: tree.root, previousRoot: null, kind: "restored", acceptedAt: now });
          db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [tree.id, tree.root, now]);
        }
        for (const [hash, facts] of profiles) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`profile:${hash}`, facts]);
        db.run("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
      })();
    }
    assertCurrentCanopySchema(db);
    await store.verifyReachable(changed.map(tree => tree.root));
    const keep = new Set<string>();
    for (const tree of changed) for (const hash of (await store.completeSnapshot(tree.root)).objects.keys()) keep.add(hash);
    let pruned = 0;
    for (const shard of await readdir(join(root, "objects"))) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      for (const name of await readdir(join(root, "objects", shard))) {
        if (!/^[a-f0-9]{62}$/.test(name) || keep.has(`sha256:${shard}${name}`)) continue;
        await unlink(join(root, "objects", shard, name));
        pruned++;
      }
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return { fromSchema: stamp, toSchema: "7", alreadyMigrated: stamp === "7", trees: changed, objects: keep.size, pruned };
  } finally { db.close(); }
}

if (import.meta.main) {
  const [root, flag] = Bun.argv.slice(2);
  if (!root || flag !== "--writers-quiesced") throw new Error("Usage: run.ts <offline-data-root> --writers-quiesced (requires verified backup and synchronized clients)");
  console.log(JSON.stringify(await migrateCanopy(root), null, 2));
}
