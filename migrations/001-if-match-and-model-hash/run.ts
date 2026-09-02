// Migration 001: rename `modelDigest` to `modelHash` inside every stored rollup
// directory entry, re-root the trees that carry one, reset accepted history to
// one restored update per tree, prune unreachable objects, and stamp schema 3.
// Idempotent: refuses to run unless the data root is at schema version 2.
//   bun run migrations/001-if-match-and-model-hash/run.ts <canopy-data-root>
// Prints tree ids and roots only; never digests or tokens.
import { Database } from "bun:sqlite";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeCBOR, encodeCanonicalCBOR, sha256, type Hash } from "@arbor/core";
import { hashObject, type ObjectHash } from "@arbor/wire";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { rootProfileFacts } from "../../packages/canopy/src/profile.ts";
import { CANOPY_SCHEMA_VERSION, assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";

const FROM_STAMP = "2";

export interface MigrationReport {
  trees: Array<{ id: string; root: Hash; previousRoot: Hash; rewritten: boolean }>;
  rewrittenObjects: number;
  retainedObjects: number;
  prunedObjects: number;
}

/**
 * Re-encode one object with the renamed rollup field, recursively, returning
 * the new hash. Objects are decoded as plain canonical CBOR so that the old
 * field name, which the current codec rejects, can still be read.
 */
async function rewrite(objects: ObjectStore, hash: ObjectHash, generated: Map<ObjectHash, Uint8Array>, memo: Map<ObjectHash, ObjectHash>): Promise<ObjectHash> {
  const known = memo.get(hash);
  if (known) return known;
  const bytes = generated.get(hash) ?? await objects.read(hash);
  const value = decodeCBOR(bytes) as { type?: string; entries?: Array<Record<string, unknown>> };
  if (value.type !== "directory" || !Array.isArray(value.entries)) {
    memo.set(hash, hash);
    return hash;
  }
  let changed = false;
  const entries = [];
  for (const entry of value.entries) {
    const next: Record<string, unknown> = { ...entry };
    if (typeof entry.hash === "string") {
      const child = await rewrite(objects, entry.hash as ObjectHash, generated, memo);
      if (child !== entry.hash) { next.hash = child; changed = true; }
    }
    const rollup = entry.rollup as Record<string, unknown> | undefined;
    if (rollup && "modelDigest" in rollup) {
      const { modelDigest, ...rest } = rollup;
      next.rollup = { ...rest, modelHash: modelDigest };
      changed = true;
    }
    entries.push(next);
  }
  if (!changed) {
    memo.set(hash, hash);
    return hash;
  }
  const encoded = encodeCanonicalCBOR({ type: "directory", entries });
  const nextHash = hashObject(encoded);
  generated.set(nextHash, encoded);
  memo.set(hash, nextHash);
  return nextHash;
}

export async function migrate(dataRoot: string): Promise<MigrationReport> {
  const db = new Database(join(dataRoot, "canopy.sqlite3"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null;
    if (stamp === CANOPY_SCHEMA_VERSION) throw new Error(`Canopy data root is already at schema version ${stamp}`);
    if (stamp !== FROM_STAMP) throw new Error(`Canopy data root is at schema version ${stamp ?? "1 (unstamped)"}; this migration starts from ${FROM_STAMP}`);
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const trees = db.query("SELECT id, ref FROM trees ORDER BY rowid").all() as Array<{ id: string; ref: ObjectHash }>;

    const generated = new Map<ObjectHash, Uint8Array>();
    const memo = new Map<ObjectHash, ObjectHash>();
    const nextRefs = new Map<string, ObjectHash>();
    for (const tree of trees) nextRefs.set(tree.id, await rewrite(objects, tree.ref, generated, memo));
    await objects.store([...generated].map(([hash, bytes]) => ({ hash, bytes })));
    const profiles = new Map<ObjectHash, string>();
    for (const ref of nextRefs.values()) {
      profiles.set(ref, JSON.stringify(await rootProfileFacts(ref, (hash) => objects.read(hash))));
    }

    const now = Date.now();
    db.transaction(() => {
      for (const tree of trees) {
        const next = nextRefs.get(tree.id)!;
        if (next !== tree.ref) db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ?", [next, now, tree.id]);
      }
      db.run("DELETE FROM meta WHERE key LIKE 'profile:%'");
      for (const [ref, facts] of profiles) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`profile:${ref}`, facts]);
      db.run("DELETE FROM accepted_updates");
      db.run("DELETE FROM observations");
      db.run("DELETE FROM reflog");
      const store = new AcceptedUpdateStore(db);
      for (const tree of trees) {
        const ref = nextRefs.get(tree.id)!;
        store.insert({ tree: tree.id, root: ref, previousRoot: null, kind: "restored", acceptedAt: now });
        db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [tree.id, ref, now]);
      }
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [CANOPY_SCHEMA_VERSION]);
    })();

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
    return {
      trees: trees.map((tree) => ({ id: tree.id, root: nextRefs.get(tree.id)! as Hash, previousRoot: tree.ref as Hash, rewritten: nextRefs.get(tree.id) !== tree.ref })),
      rewrittenObjects: generated.size,
      retainedObjects: reachable.size,
      prunedObjects: pruned,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [target] = process.argv.slice(2);
  if (!target) {
    console.error("usage: bun run migrations/001-if-match-and-model-hash/run.ts <canopy-data-root>");
    process.exit(2);
  }
  console.log(JSON.stringify(await migrate(resolve(target)), null, 2));
}
