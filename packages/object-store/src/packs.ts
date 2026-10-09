import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * Packed objects: immutable pack files under `<objects>/packs/`, indexed in
 * `<objects>/packs/index.sqlite3`. A pack is a concatenation of records; each
 * index row says where one object's record is and how it is encoded:
 *
 * - `raw`: the canonical bytes;
 * - `zstd`: one zstd frame of them;
 * - `delta`: one zstd frame compressed with another object's canonical bytes
 *   (`base`) as its dictionary, so reading it reads the base first;
 * - `member`: a slice (`start`, `size`) of a zstd frame shared by several
 *   objects, the frame being the record.
 *
 * A hash still names canonical bytes; the index only says where they are, and
 * every read is checked against the hash by the caller, as loose reads are.
 * `used_at` is the packed object's freshened time, which the collector honors
 * as it honors a loose file's modification time.
 */
export const enum Encoding { Raw = 0, Zstd = 1, Delta = 2, Member = 3 }

export interface PackedLocation {
  pack: number;
  offset: number;
  length: number;
  encoding: Encoding;
  base: string | null;
  start: number;
  size: number;
}

/** One object's record as a packing pass prepared it. Records sharing a
 * `frame` (the same `Uint8Array`) are members of one zstd frame. */
export type PackRecord =
  | { hash: string; encoding: Encoding.Raw | Encoding.Zstd; body: Uint8Array; size: number }
  | { hash: string; encoding: Encoding.Delta; body: Uint8Array; base: string; size: number }
  | { hash: string; encoding: Encoding.Member; frame: Uint8Array; start: number; size: number };

const HASH = /^sha256:([a-f0-9]{64})$/;
const digest = (hash: string) => {
  const match = HASH.exec(hash);
  if (!match) throw new Error(`Invalid object hash: ${hash}`);
  return Buffer.from(match[1]!, "hex");
};
const named = (bytes: Uint8Array) => `sha256:${Buffer.from(bytes).toString("hex")}`;

export const PACK_INDEX = "index.sqlite3";

/** Create the index's tables in `db` when they do not exist. */
function createIndex(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS packs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS packed_objects (
    hash BLOB PRIMARY KEY,
    pack INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    length INTEGER NOT NULL,
    encoding INTEGER NOT NULL,
    base BLOB,
    start INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL,
    used_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.run("CREATE INDEX IF NOT EXISTS packed_objects_pack ON packed_objects(pack)");
  // Each document's newest packed version and its delta depth, so a later
  // pass deltas the next version against it.
  db.run(`CREATE TABLE IF NOT EXISTS pack_documents (
    doc BLOB PRIMARY KEY,
    latest BLOB NOT NULL,
    depth INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.run("CREATE INDEX IF NOT EXISTS packed_objects_base ON packed_objects(base) WHERE base IS NOT NULL");
}

/**
 * The pack index and reader one `ObjectStore` consults when an object has no
 * loose file. It opens the index lazily, once it exists, so a store that was
 * never packed costs one `existsSync` per loose miss.
 */
export class Packs {
  readonly directory: string;
  private db?: Database;
  private statements?: {
    find: ReturnType<Database["query"]>;
    pack: ReturnType<Database["query"]>;
    touch: ReturnType<Database["query"]>;
  };
  /** Open pack descriptors (packs are immutable, so reads need no locking). */
  private readonly handles = new Map<number, number>();
  /** Decompressed shared frames, by pack and offset, most recently used last. */
  private readonly frames = new Map<string, Uint8Array>();
  private frameBytes = 0;

  constructor(objectsRoot: string, private readonly options: { frameCacheBytes?: number } = {}) {
    this.directory = join(objectsRoot, "packs");
  }

  /** The open index, creating it when `create`; undefined when there is none. */
  index(create = false): Database | undefined {
    if (this.db) return this.db;
    const path = join(this.directory, PACK_INDEX);
    if (!create && !existsSync(path)) return undefined;
    mkdirSync(this.directory, { recursive: true });
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 10000");
    createIndex(db);
    this.db = db;
    this.statements = {
      find: db.query("SELECT pack, offset, length, encoding, base, start, size FROM packed_objects WHERE hash = ?"),
      pack: db.query("SELECT name FROM packs WHERE id = ?"),
      touch: db.query("UPDATE packed_objects SET used_at = max(used_at, ?) WHERE hash = ?"),
    };
    return db;
  }

  locate(hash: string): PackedLocation | null {
    if (!this.index()) return null;
    const row = this.statements!.find.get(digest(hash)) as (Omit<PackedLocation, "base"> & { base: Uint8Array | null }) | null;
    return row ? { ...row, base: row.base ? named(row.base) : null } : null;
  }

  has(hash: string): boolean {
    return this.locate(hash) !== null;
  }

  /** Mark packed objects as just used; returns the hashes not packed here. */
  freshen(hashes: Iterable<string>, now = Date.now()): string[] {
    const missing: string[] = [];
    const db = this.index();
    if (!db) return [...hashes];
    db.transaction(() => {
      for (const hash of hashes) {
        const result = this.statements!.touch.run(now, digest(hash));
        if (!result.changes) missing.push(hash);
      }
    })();
    return missing;
  }

  private file(pack: number): number {
    let fd = this.handles.get(pack);
    if (fd === undefined) {
      const row = this.statements!.pack.get(pack) as { name: string } | null;
      if (!row) throw Object.assign(new Error(`Pack ${pack} is not indexed`), { code: "ENOENT" });
      fd = openSync(join(this.directory, row.name), "r");
      this.handles.set(pack, fd);
    }
    return fd;
  }

  private async record(at: PackedLocation): Promise<Uint8Array> {
    const buffer = new Uint8Array(at.length);
    const read = readSync(this.file(at.pack), buffer, 0, at.length, at.offset);
    if (read !== at.length) throw new Error(`Pack ${at.pack} is shorter than its index`);
    return buffer;
  }

  /**
   * An object's canonical bytes, or null when it is not packed. `base` reads
   * a delta's base (through the store, so it is hash-checked and cached).
   * The caller checks the result against `hash`. A pack removed by a
   * concurrent rewrite is looked up again.
   */
  async read(hash: string, base: (hash: string, depth: number) => Promise<Uint8Array>, depth = 0): Promise<Uint8Array | null> {
    for (let attempt = 0; ; attempt++) {
      const at = this.locate(hash);
      if (!at) return null;
      try {
        return await this.decode(at, base, depth);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt > 0) throw error;
        this.forget(at.pack);
      }
    }
  }

  private async decode(at: PackedLocation, base: (hash: string, depth: number) => Promise<Uint8Array>, depth: number): Promise<Uint8Array> {
    if (at.encoding === Encoding.Member) {
      const key = `${at.pack}:${at.offset}`;
      let frame = this.frames.get(key);
      if (frame) { this.frames.delete(key); this.frames.set(key, frame); }
      else {
        frame = new Uint8Array(zstdDecompressSync(await this.record(at)));
        this.rememberFrame(key, frame);
      }
      if (at.start + at.size > frame.byteLength) throw new Error("Packed member lies outside its frame");
      return frame.slice(at.start, at.start + at.size);
    }
    const body = await this.record(at);
    if (at.encoding === Encoding.Raw) return body;
    if (at.encoding === Encoding.Zstd) return new Uint8Array(zstdDecompressSync(body));
    if (at.encoding === Encoding.Delta) {
      if (!at.base) throw new Error("Packed delta has no base");
      if (depth >= MAX_DELTA_DEPTH) throw new Error("Packed delta chain is too deep");
      const dictionary = await base(at.base, depth + 1);
      return new Uint8Array(zstdDecompressSync(body, { dictionary } as never));
    }
    throw new Error(`Unknown packed encoding ${at.encoding}`);
  }

  private rememberFrame(key: string, frame: Uint8Array): void {
    const limit = this.options.frameCacheBytes ?? 8 << 20;
    if (frame.byteLength > limit) return;
    this.frames.set(key, frame);
    this.frameBytes += frame.byteLength;
    for (const [oldest, old] of this.frames) {
      if (this.frameBytes <= limit) break;
      this.frames.delete(oldest);
      this.frameBytes -= old.byteLength;
    }
  }

  /** Drop a pack's open handle and cached frames (after a rewrite). */
  forget(pack: number): void {
    const fd = this.handles.get(pack);
    if (fd !== undefined) { this.handles.delete(pack); try { closeSync(fd); } catch {} }
    for (const [key, frame] of this.frames)
      if (key.startsWith(`${pack}:`)) { this.frames.delete(key); this.frameBytes -= frame.byteLength; }
  }

  close(): void {
    for (const pack of [...this.handles.keys()]) this.forget(pack);
    this.db?.close();
    this.db = undefined;
  }

  /**
   * Durably write one pack of `records` and index them in one transaction.
   * The file is complete and synced, under its content's name, before any
   * row names it; a crash before the commit leaves an unindexed pack, which
   * `removeOrphans` deletes. Records already packed elsewhere are skipped.
   * Returns the pack's id, or null when nothing was new.
   */
  async write(records: PackRecord[], now = Date.now()): Promise<number | null> {
    const db = this.index(true)!;
    const fresh = records.filter((r) => !this.has(r.hash));
    if (!fresh.length) return null;
    // Lay out the bodies; members of one frame share one record.
    const chunks: Uint8Array[] = [];
    const frames = new Map<Uint8Array, { offset: number; length: number }>();
    const placed: Array<{ record: PackRecord; offset: number; length: number }> = [];
    let offset = 0;
    for (const record of fresh) {
      if (record.encoding === Encoding.Member) {
        let at = frames.get(record.frame);
        if (!at) {
          at = { offset, length: record.frame.byteLength };
          frames.set(record.frame, at);
          chunks.push(record.frame); offset += record.frame.byteLength;
        }
        placed.push({ record, ...at });
      } else {
        placed.push({ record, offset, length: record.body.byteLength });
        chunks.push(record.body); offset += record.body.byteLength;
      }
    }
    const pack = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) { pack.set(chunk, at); at += chunk.byteLength; }
    const name = await this.writeFile(pack);
    const insertPack = db.query("INSERT INTO packs (name, bytes, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes RETURNING id");
    const insertObject = db.query(`INSERT OR IGNORE INTO packed_objects (hash, pack, offset, length, encoding, base, start, size, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let id = 0;
    db.transaction(() => {
      id = (insertPack.get(name, offset, now) as { id: number }).id;
      for (const { record, offset: o, length } of placed)
        insertObject.run(digest(record.hash), id, o, length, record.encoding,
          record.encoding === Encoding.Delta ? digest(record.base) : null,
          record.encoding === Encoding.Member ? record.start : 0, record.size, now);
    })();
    return id;
  }

  /**
   * Drop packed objects that are neither `live` nor used since `cutoff`,
   * keeping every base a kept object's delta reads (transitively). Each
   * row goes only if its `used_at` is still before the cutoff, so a
   * concurrent freshen wins. Then packs that lost at least half their bytes
   * are rewritten with what remains. Returns the dropped objects and bytes.
   */
  async collect(live: Set<string>, cutoff: number, remove: boolean): Promise<{ objects: number; bytes: number; young: number; kept: number; rewritten: number }> {
    const db = this.index();
    if (!db) return { objects: 0, bytes: 0, young: 0, kept: 0, rewritten: 0 };
    const rows = db.query("SELECT hash, base, size, length, used_at FROM packed_objects").all() as Array<{ hash: Uint8Array; base: Uint8Array | null; size: number; length: number; used_at: number }>;
    const byHash = new Map(rows.map((r) => [named(r.hash), r]));
    const kept = new Set<string>();
    let young = 0;
    const keep = (hash: string) => {
      for (let at: string | null = hash; at && !kept.has(at);) {
        kept.add(at);
        const row = byHash.get(at);
        at = row?.base ? named(row.base) : null;
      }
    };
    for (const [hash, row] of byHash) {
      if (live.has(hash)) keep(hash);
      else if (row.used_at >= cutoff) { young++; keep(hash); }
    }
    const dead = [...byHash].filter(([hash]) => !kept.has(hash));
    let objects = 0, bytes = 0, rewritten = 0;
    if (!remove) return { objects: dead.length, bytes: dead.reduce((n, [, r]) => n + r.size, 0), young, kept: kept.size - young, rewritten };
    const drop = db.query("DELETE FROM packed_objects WHERE hash = ? AND used_at < ?");
    db.transaction(() => {
      for (const [, row] of dead) {
        if (drop.run(row.hash, cutoff).changes) { objects++; bytes += row.size; }
      }
      db.run("DELETE FROM pack_documents WHERE NOT EXISTS (SELECT 1 FROM packed_objects WHERE hash = pack_documents.latest)");
    })();
    for (const { id, bytes: total } of db.query("SELECT id, bytes FROM packs").all() as Array<{ id: number; bytes: number }>) {
      const used = db.query("SELECT coalesce(sum(length), 0) AS n FROM (SELECT DISTINCT offset, length FROM packed_objects WHERE pack = ?)").get(id) as { n: number };
      if (used.n > 0 && used.n < total / 2) { await this.rewrite(id); rewritten++; }
    }
    await this.removeOrphans();
    return { objects, bytes, young, kept: kept.size - young, rewritten };
  }

  /** Copy a pack's remaining records into a new pack, move their rows in one
   * transaction, then remove the old pack. Records are copied as they are:
   * no object's encoding or base changes. */
  private async rewrite(pack: number): Promise<void> {
    const db = this.index()!;
    const rows = db.query("SELECT hash, offset, length FROM packed_objects WHERE pack = ?").all(pack) as Array<{ hash: Uint8Array; offset: number; length: number }>;
    const ranges = new Map<number, { length: number; to: number }>();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const row of rows) {
      if (ranges.has(row.offset)) continue;
      const bytes = await this.record({ pack, offset: row.offset, length: row.length, encoding: Encoding.Raw, base: null, start: 0, size: row.length });
      ranges.set(row.offset, { length: row.length, to: size });
      chunks.push(bytes); size += bytes.byteLength;
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    const name = await this.writeFile(joined);
    const old = db.query("SELECT name FROM packs WHERE id = ?").get(pack) as { name: string };
    db.transaction(() => {
      const { id } = db.query("INSERT INTO packs (name, bytes, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes RETURNING id").get(name, size, Date.now()) as { id: number };
      const move = db.query("UPDATE packed_objects SET pack = ?, offset = ? WHERE hash = ? AND pack = ?");
      for (const row of rows) move.run(id, ranges.get(row.offset)!.to, row.hash, pack);
      db.run("DELETE FROM packs WHERE id = ?", [pack]);
    })();
    this.forget(pack);
    if (old.name !== name) await unlink(join(this.directory, old.name)).catch(() => {});
  }

  /** Write `bytes` durably as a pack file named by its content. */
  private async writeFile(bytes: Uint8Array): Promise<string> {
    const name = `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}.pack`;
    const path = join(this.directory, name);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(this.directory);
    return name;
  }

  /** Delete pack files no index row names (left by a crash before commit)
   * and temporary files, once older than `minAgeMs`, and packs no row uses. */
  async removeOrphans(minAgeMs = 60 * 60_000): Promise<string[]> {
    const db = this.index();
    if (!db) return [];
    const known = new Set((db.query("SELECT name FROM packs").all() as Array<{ name: string }>).map((r) => r.name));
    const removed: string[] = [];
    const { readdir } = await import("node:fs/promises");
    const { stat } = await import("node:fs/promises");
    for (const name of await readdir(this.directory)) {
      if (name === PACK_INDEX || name.startsWith(`${PACK_INDEX}-`)) continue;
      if ((name.endsWith(".pack") && !known.has(name)) || name.endsWith(".tmp")) {
        // A pass in another process may have written it and not yet indexed it.
        const info = await stat(join(this.directory, name)).catch(() => null);
        if (!info || info.mtimeMs > Date.now() - minAgeMs) continue;
        await unlink(join(this.directory, name)).catch(() => {});
        removed.push(name);
      }
    }
    // A pack whose every row was dropped is no longer needed either.
    for (const { id, name } of db.query("SELECT id, name FROM packs WHERE NOT EXISTS (SELECT 1 FROM packed_objects WHERE pack = packs.id)").all() as Array<{ id: number; name: string }>) {
      db.run("DELETE FROM packs WHERE id = ?", [id]);
      this.forget(id);
      await unlink(join(this.directory, name)).catch(() => {});
      removed.push(name);
    }
    return removed;
  }
}

export interface PackCandidate {
  hash: string;
  bytes: Uint8Array;
  /** Document identity (a stable key, a path, a tree's log); versions of one
   * document are delta candidates for each other. */
  key: string;
}

export interface PackOptions {
  /** Longest delta chain written. */
  depth?: number;
  level?: number;
  /** Raw bytes per shared frame of one-version objects. */
  frameBytes?: number;
  /** A delta is kept when it is at most this share of the object alone. */
  deltaShare?: number;
}

/**
 * Prepare records for `candidates`, in the order given within each
 * document (oldest first): each version a zstd frame against the previous
 * version of its document (one packed earlier, from `pack_documents`, or the
 * one before it here) while the chain stays within `depth` and the delta
 * pays; the first version of a document, and anything a delta does not help,
 * alone. Objects compressed alone that are small are instead members of
 * shared frames in document order, since small objects compress poorly
 * alone. `load` reads an earlier packed base.
 */
export async function prepareRecords(
  packs: Packs,
  candidates: PackCandidate[],
  load: (hash: string) => Promise<Uint8Array>,
  options: PackOptions = {},
): Promise<{ records: PackRecord[]; documents: Map<string, { latest: string; depth: number }> }> {
  const depth = options.depth ?? 10, level = options.level ?? 3, frameBytes = options.frameBytes ?? 256 << 10;
  const share = options.deltaShare ?? 0.8;
  const db = packs.index(true)!;
  const latestOf = db.query("SELECT latest, depth FROM pack_documents WHERE doc = ?");
  const byKey = new Map<string, PackCandidate[]>();
  for (const c of candidates) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)!).push(c);
  const records: PackRecord[] = [];
  const small: PackCandidate[] = [];
  const documents = new Map<string, { latest: string; depth: number }>();
  for (const [key, versions] of byKey) {
    const docId = documentId(key);
    const row = latestOf.get(docId) as { latest: Uint8Array; depth: number } | null;
    let previous: { hash: string; bytes: Uint8Array | null; depth: number } | null =
      row ? { hash: named(row.latest), bytes: null, depth: row.depth } : null;
    for (const version of versions) {
      let chosen: PackRecord | null = null, chain = 0;
      if (previous && previous.depth < depth) {
        const base = previous.bytes ?? await load(previous.hash).catch(() => null);
        if (base) {
          const delta = zstd(version.bytes, level, base);
          const alone = zstd(version.bytes, level);
          if (delta.byteLength <= share * Math.min(alone.byteLength, version.bytes.byteLength)) {
            chosen = { hash: version.hash, encoding: Encoding.Delta, body: delta, base: previous.hash, size: version.bytes.byteLength };
            chain = previous.depth + 1;
          }
        }
      }
      if (!chosen) {
        if (version.bytes.byteLength < SMALL_ALONE) small.push(version);
        else {
          const alone = zstd(version.bytes, level);
          chosen = alone.byteLength < version.bytes.byteLength
            ? { hash: version.hash, encoding: Encoding.Zstd, body: alone, size: version.bytes.byteLength }
            : { hash: version.hash, encoding: Encoding.Raw, body: version.bytes, size: version.bytes.byteLength };
        }
      }
      if (chosen) records.push(chosen);
      previous = { hash: version.hash, bytes: version.bytes, depth: chain };
      documents.set(key, { latest: version.hash, depth: chain });
    }
  }
  // Small objects that stood alone share frames, in document order.
  let members: PackCandidate[] = [], size = 0;
  const flush = () => {
    if (!members.length) return;
    const joined = new Uint8Array(size);
    let at = 0;
    const starts = members.map((m) => { joined.set(m.bytes, at); at += m.bytes.byteLength; return at - m.bytes.byteLength; });
    const frame = zstd(joined, level);
    members.forEach((m, i) => records.push({ hash: m.hash, encoding: Encoding.Member, frame, start: starts[i]!, size: m.bytes.byteLength }));
    members = []; size = 0;
  };
  for (const c of small) {
    members.push(c); size += c.bytes.byteLength;
    if (size >= frameBytes) flush();
  }
  flush();
  return { records, documents };
}

/** Objects below this size compress poorly alone and share frames instead. */
const SMALL_ALONE = 4096;

const documentId = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest();

/** Record each document's newest packed version, after its pack is indexed. */
export function recordDocuments(packs: Packs, documents: Map<string, { latest: string; depth: number }>): void {
  const db = packs.index(true)!;
  const upsert = db.query("INSERT OR REPLACE INTO pack_documents (doc, latest, depth) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const [key, { latest, depth }] of documents) upsert.run(documentId(key), digest(latest), depth);
  })();
}

/** Deltas never chain deeper than this; a reader refuses deeper chains. */
export const MAX_DELTA_DEPTH = 64;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  void dirname;
}

/** zstd at `level`, with a window large enough for the input. */
export function zstd(bytes: Uint8Array, level: number, dictionary?: Uint8Array): Uint8Array {
  const windowLog = Math.min(27, Math.max(19, Math.ceil(Math.log2(Math.max(1, bytes.byteLength)))));
  return new Uint8Array(zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_windowLog]: windowLog },
    ...(dictionary ? { dictionary } : {}),
  } as never));
}
