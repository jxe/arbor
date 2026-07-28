import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeWireObject, hashObject, type ObjectHash, type TreeSnapshot } from "./objects.ts";

export type PublicationMode = "private" | "public-read" | "public-write";

export interface AuthorityTree {
  id: string;
  slug: string;
  ref: ObjectHash;
  publication: PublicationMode;
  updatedAt: number;
}

export interface PushRequest {
  expected: ObjectHash | null;
  root: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

function treeID(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return `tr_${result}`;
}

export class RefConflictError extends Error {
  constructor(readonly current: ObjectHash | null) {
    super("Tree ref changed");
    this.name = "RefConflictError";
  }
}

export class WireAuthority implements AsyncDisposable {
  private db: Database;
  private listeners = new Map<string, Set<(tree: AuthorityTree) => void>>();

  private constructor(readonly dataRoot: string, db: Database) {
    this.db = db;
  }

  static async open(dataRoot: string): Promise<WireAuthority> {
    await mkdir(join(dataRoot, "objects"), { recursive: true });
    const db = new Database(join(dataRoot, "authority.sqlite3"), { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        ref TEXT NOT NULL,
        publication TEXT NOT NULL DEFAULT 'private',
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS reflog (
        tree_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        previous_ref TEXT,
        changed_at INTEGER NOT NULL
      )
    `);
    return new WireAuthority(dataRoot, db);
  }

  private row(value: unknown): AuthorityTree | null {
    if (!value) return null;
    const row = value as { id: string; slug: string; ref: string; publication: PublicationMode; updated_at: number };
    return { id: row.id, slug: row.slug, ref: row.ref, publication: row.publication, updatedAt: row.updated_at };
  }

  list(): AuthorityTree[] {
    return this.db.query("SELECT * FROM trees ORDER BY slug").all().map((row) => this.row(row)!);
  }

  get(id: string): AuthorityTree | null {
    return this.row(this.db.query("SELECT * FROM trees WHERE id = ?").get(id));
  }

  bySlug(slug: string): AuthorityTree | null {
    return this.row(this.db.query("SELECT * FROM trees WHERE slug = ?").get(slug));
  }

  async create(slug: string, snapshot: TreeSnapshot): Promise<AuthorityTree> {
    if (!SLUG.test(slug) || slug === "tree") throw new Error(`Invalid or reserved tree slug: ${slug}`);
    await this.validateGraph(snapshot.root, snapshot.objects);
    await this.storeObjects([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const id = treeID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run("INSERT INTO trees (id, slug, ref, publication, updated_at) VALUES (?, ?, ?, 'private', ?)", [id, slug, snapshot.root, now]);
      this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, NULL, ?)", [id, snapshot.root, now]);
    })();
    return this.get(id)!;
  }

  async push(id: string, request: PushRequest): Promise<AuthorityTree> {
    const tree = this.get(id);
    if (!tree) throw new Error(`Unknown tree: ${id}`);
    if (tree.ref !== request.expected) throw new RefConflictError(tree.ref);
    const proposed = new Map(request.objects.map(({ hash, bytes }) => [hash, bytes]));
    await this.validateGraph(request.root, proposed);
    await this.storeObjects(request.objects);
    const now = Date.now();
    this.db.transaction(() => {
      const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
        request.root,
        now,
        id,
        request.expected,
      ]);
      if (result.changes !== 1) throw new RefConflictError(this.get(id)?.ref ?? null);
      this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)", [
        id,
        request.root,
        request.expected,
        now,
      ]);
    })();
    const updated = this.get(id)!;
    for (const listener of this.listeners.get(id) ?? []) listener(updated);
    return updated;
  }

  setPublication(id: string, publication: PublicationMode): AuthorityTree {
    if (!["private", "public-read", "public-write"].includes(publication)) throw new Error(`Invalid publication mode: ${publication}`);
    const result = this.db.run("UPDATE trees SET publication = ?, updated_at = ? WHERE id = ?", [publication, Date.now(), id]);
    if (result.changes !== 1) throw new Error(`Unknown tree: ${id}`);
    return this.get(id)!;
  }

  subscribe(id: string, listener: (tree: AuthorityTree) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => listeners.delete(listener);
  }

  private objectPath(hash: ObjectHash): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid object hash: ${hash}`);
    return join(this.dataRoot, "objects", hash.slice(7, 9), hash.slice(9));
  }

  async hasObject(hash: ObjectHash): Promise<boolean> {
    try {
      await readFile(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async object(hash: ObjectHash): Promise<Uint8Array> {
    const bytes = new Uint8Array(await readFile(this.objectPath(hash)));
    if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    return bytes;
  }

  async isPublicObject(hash: ObjectHash): Promise<boolean> {
    for (const tree of this.list()) {
      if (tree.publication === "private") continue;
      if (await this.graphContains(tree.ref, hash)) return true;
    }
    return false;
  }

  private async graphContains(root: ObjectHash, target: ObjectHash): Promise<boolean> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (hash === target) return true;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const object = decodeWireObject(await this.object(hash));
      if (object.type === "directory") {
        for (const entry of object.entries) if (entry.hash) pending.push(entry.hash);
      }
    }
    return false;
  }

  private async validateGraph(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array>): Promise<void> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    let totalBytes = 0;
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (seen.size > 100_000) throw new Error("Tree exceeds the object quota");
      const bytes = proposed.get(hash) ?? (await this.hasObject(hash) ? await this.object(hash) : null);
      if (!bytes) throw new Error(`Missing referenced object: ${hash}`);
      if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > 1_000_000_000) throw new Error("Tree exceeds the storage quota");
      const object = decodeWireObject(bytes);
      if (object.type !== "directory") continue;
      const names = new Set<string>();
      for (const entry of object.entries) {
        if (
          !entry.name
          || entry.name === "."
          || entry.name === ".."
          || entry.name.includes("/")
          || entry.name.includes("\\")
          || names.has(entry.name)
        ) throw new Error(`Invalid or duplicate directory entry: ${entry.name}`);
        names.add(entry.name);
        if (entry.hash) pending.push(entry.hash);
      }
    }
  }

  private async storeObjects(objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    for (const object of objects) {
      if (hashObject(object.bytes) !== object.hash) throw new Error(`Object hash mismatch: ${object.hash}`);
      const path = this.objectPath(object.hash);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, object.bytes, { flag: "wx" }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.db.close();
    this.listeners.clear();
  }
}
