// Migration 002: replace schema-3 embedded collection-file entries with
// ordinary source/schema entries plus a directory-level childrenSource
// descriptor. Every affected ancestor is re-rooted and accepted history is
// reset to one restored update per tree. Runs only from schema 3 to schema 4.
//   bun run migrations/002-collection-file-wire/run.ts <canopy-data-root>
// Reports tree ids and roots only; never content, credentials, or digests.
import { Database } from "bun:sqlite";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalCBORHash, decodeCBOR, encodeCanonicalCBOR, type Hash } from "@arbor/core";
import { decodeWireObject, hashObject, type ObjectHash } from "@arbor/wire";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { rootProfileFacts } from "../../packages/canopy/src/profile.ts";
import { CANOPY_SCHEMA_VERSION, assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";

const FROM_STAMP = "3";
const TARGET_STAMP = "4";

type LegacyEntry = {
  name: string;
  hash?: ObjectHash;
  tree?: string;
  rollup?: {
    version: number;
    codec: string;
    source: ObjectHash;
    schemaSource: ObjectHash;
    schema: Hash;
    scope: string;
    modelHash: Hash;
  };
};

type LegacyDirectory = { type: "directory"; entries: LegacyEntry[] };

export interface MigrationReport {
  fromSchema: string;
  toSchema: string;
  trees: Array<{ id: string; root: Hash; previousRoot: Hash; rewritten: boolean }>;
  rewrittenObjects: number;
  retainedObjects: number;
  prunedObjects: number;
}

function asDirectory(value: unknown): LegacyDirectory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { type?: unknown; entries?: unknown };
  if (candidate.type !== "directory" || !Array.isArray(candidate.entries)) return null;
  return candidate as LegacyDirectory;
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return Buffer.compare(Buffer.from(left.name), Buffer.from(right.name));
}

function validateLegacyDescriptor(entry: LegacyEntry): NonNullable<LegacyEntry["rollup"]> {
  const value = entry.rollup;
  if (!value || value.version !== 1 || !["csv", "json", "jsonl"].includes(value.codec)
      || value.scope !== "children" || entry.name !== `_store.${value.codec}`
      || typeof value.source !== "string" || typeof value.schemaSource !== "string"
      || typeof value.schema !== "string" || typeof value.modelHash !== "string") {
    throw new Error(`Ambiguous legacy collection-file descriptor at ${entry.name}`);
  }
  return value;
}

/** A migration-only logical proof that ignores collection-file formatting. */
async function logicalFingerprint(
  objects: ObjectStore,
  hash: ObjectHash,
  generated: Map<ObjectHash, Uint8Array>,
  memo = new Map<ObjectHash, Hash>(),
): Promise<Hash> {
  const known = memo.get(hash);
  if (known) return known;
  const value = decodeCBOR(generated.get(hash) ?? await objects.read(hash)) as unknown;
  const directory = asDirectory(value);
  if (!directory) {
    memo.set(hash, hash as Hash);
    return hash as Hash;
  }
  const modern = value as { childrenSource?: { schemaFingerprint?: unknown; childSetHash?: unknown } };
  const old = directory.entries.find((entry) => entry.rollup)?.rollup;
  const descriptor = old
    ? { schemaFingerprint: old.schema, childSetHash: old.modelHash }
    : modern.childrenSource
      ? { schemaFingerprint: modern.childrenSource.schemaFingerprint, childSetHash: modern.childrenSource.childSetHash }
      : null;
  const physicalNames = descriptor
    ? new Set(["_store.csv", "_store.json", "_store.jsonl", "schema.ts"])
    : new Set<string>();
  const entries = [];
  for (const entry of directory.entries) {
    if (entry.rollup || physicalNames.has(entry.name)) continue;
    entries.push({
      name: entry.name,
      ...(entry.hash ? { hash: await logicalFingerprint(objects, entry.hash, generated, memo) } : { tree: entry.tree }),
    });
  }
  const result = canonicalCBORHash({ type: "directory", entries, ...(descriptor ? { childrenSource: descriptor } : {}) });
  memo.set(hash, result);
  return result;
}

async function rewrite(
  objects: ObjectStore,
  hash: ObjectHash,
  generated: Map<ObjectHash, Uint8Array>,
  memo: Map<ObjectHash, ObjectHash>,
): Promise<ObjectHash> {
  const known = memo.get(hash);
  if (known) return known;
  const value = decodeCBOR(generated.get(hash) ?? await objects.read(hash)) as unknown;
  const directory = asDirectory(value);
  if (!directory) {
    memo.set(hash, hash);
    return hash;
  }

  const legacyEntries = directory.entries.filter((entry) => entry.rollup);
  if (legacyEntries.length > 1) throw new Error("A legacy directory has more than one collection-file entry");
  let changed = false;
  const entries: Array<{ name: string; hash?: ObjectHash; tree?: string }> = [];
  for (const entry of directory.entries) {
    if (entry.rollup) continue;
    if (typeof entry.name !== "string") throw new Error("Legacy directory entry has no name");
    if (entry.hash) {
      const child = await rewrite(objects, entry.hash, generated, memo);
      entries.push({ name: entry.name, hash: child });
      if (child !== entry.hash) changed = true;
    } else if (entry.tree) {
      entries.push({ name: entry.name, tree: entry.tree });
    } else {
      throw new Error(`Legacy directory entry ${entry.name} has no target`);
    }
  }

  let childrenSource: Record<string, unknown> | undefined;
  if (legacyEntries[0]) {
    const sourceEntry = legacyEntries[0];
    const legacy = validateLegacyDescriptor(sourceEntry);
    const existingSource = entries.find((entry) => entry.name === sourceEntry.name);
    if (existingSource && existingSource.hash !== legacy.source) {
      throw new Error(`Conflicting source entry ${sourceEntry.name}`);
    }
    if (!existingSource) entries.push({ name: sourceEntry.name, hash: legacy.source });
    const existingSchema = entries.find((entry) => entry.name === "schema.ts");
    if (existingSchema && existingSchema.hash !== legacy.schemaSource) {
      throw new Error("Conflicting schema.ts entry");
    }
    if (!existingSchema) entries.push({ name: "schema.ts", hash: legacy.schemaSource });
    const allowed = new Set([sourceEntry.name, "schema.ts", "_index.md"]);
    if (entries.some((entry) => !allowed.has(entry.name))) {
      throw new Error("Legacy collection-file directory mixes immediate-child backings");
    }
    childrenSource = {
      version: 1,
      type: "collection-file",
      format: legacy.codec,
      source: sourceEntry.name,
      schemaSource: "schema.ts",
      schemaFingerprint: legacy.schema,
      childSetHash: legacy.modelHash,
    };
    changed = true;
  }

  if (!changed) {
    memo.set(hash, hash);
    return hash;
  }
  entries.sort(compareNames);
  const encoded = encodeCanonicalCBOR({ type: "directory", entries, ...(childrenSource ? { childrenSource } : {}) });
  decodeWireObject(encoded);
  const nextHash = hashObject(encoded);
  generated.set(nextHash, encoded);
  memo.set(hash, nextHash);
  return nextHash;
}

export async function migrate(dataRoot: string): Promise<MigrationReport> {
  if (String(CANOPY_SCHEMA_VERSION) !== TARGET_STAMP) {
    throw new Error(`Migration target ${TARGET_STAMP} does not match this build's schema ${CANOPY_SCHEMA_VERSION}`);
  }
  const db = new Database(join(dataRoot, "canopy.sqlite3"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null;
    if (stamp === TARGET_STAMP) throw new Error(`Canopy data root is already at schema version ${stamp}`);
    if (stamp !== FROM_STAMP) throw new Error(`Canopy data root is at schema version ${stamp ?? "1 (unstamped)"}; this migration starts from ${FROM_STAMP}`);
    const objects = new ObjectStore(join(dataRoot, "objects"));
    const trees = db.query("SELECT id, ref FROM trees ORDER BY rowid").all() as Array<{ id: string; ref: ObjectHash }>;
    const generated = new Map<ObjectHash, Uint8Array>();
    const memo = new Map<ObjectHash, ObjectHash>();
    const nextRefs = new Map<string, ObjectHash>();
    for (const tree of trees) {
      const beforeProof = await logicalFingerprint(objects, tree.ref, generated);
      const next = await rewrite(objects, tree.ref, generated, memo);
      const afterProof = await logicalFingerprint(objects, next, generated);
      if (beforeProof !== afterProof) throw new Error(`Logical equivalence failed for tree ${tree.id}`);
      nextRefs.set(tree.id, next);
    }
    await objects.store([...generated].map(([objectHash, bytes]) => ({ hash: objectHash, bytes })));
    const profiles = new Map<ObjectHash, string>();
    for (const ref of nextRefs.values()) profiles.set(ref, JSON.stringify(await rootProfileFacts(ref, (objectHash) => objects.read(objectHash))));

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
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [TARGET_STAMP]);
    })();

    const reachable = new Set<ObjectHash>();
    for (const ref of nextRefs.values()) for (const objectHash of (await objects.completeSnapshot(ref)).objects.keys()) reachable.add(objectHash);
    let pruned = 0;
    const objectRoot = join(dataRoot, "objects");
    for (const prefix of await readdir(objectRoot)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      for (const rest of await readdir(join(objectRoot, prefix))) {
        const objectHash = `sha256:${prefix}${rest}` as ObjectHash;
        if (reachable.has(objectHash)) continue;
        await rm(join(objectRoot, prefix, rest), { force: true });
        pruned += 1;
      }
    }
    assertCurrentCanopySchema(db);
    await objects.verifyReachable([...nextRefs.values()]);
    return {
      fromSchema: FROM_STAMP,
      toSchema: TARGET_STAMP,
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
    console.error("usage: bun run migrations/002-collection-file-wire/run.ts <canopy-data-root>");
    process.exit(2);
  }
  console.log(JSON.stringify(await migrate(resolve(target)), null, 2));
}
