import { Database } from "bun:sqlite";
import { close as closeFd, closeSync, existsSync, fdatasync, fstatSync, mkdirSync, openSync, readdirSync, readSync, write as writeFd } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * Packed objects: immutable pack files under `<objects>/packs/`, indexed in
 * `<objects>/packs/index.sqlite3`. A pack is a concatenation of records; each
 * index row says where one object's record is and how it is encoded:
 *
 * - `raw`: the canonical bytes;
 * - `zstd`: one zstd frame of them;
 * - `member`: a slice (`start`, `size`) of a zstd frame shared by several
 *   objects, the frame being the record.
 *
 * No object depends on another: decoding one reads only its own record.
 *
 * A hash still names canonical bytes; the index only says where they are, and
 * every read is checked against the hash by the caller, as loose reads are.
 * `used_at` is the packed object's freshened time, which the collector honors
 * as it honors a loose file's modification time.
 *
 * A journal (`journal-<uuid>.pack`) is a pack one store appends accepted
 * objects to, each record a 36-byte header (body length, big-endian u32, and
 * the 32-byte hash) and the raw body. An append is synced with one
 * `fdatasync` before its rows are indexed, so its records are durable even
 * if the index commit is lost: opening the index re-indexes any complete
 * records past a journal's indexed length (`bytes`). A journal is otherwise
 * a pack like any other: collected and rewritten by row.
 */
export const enum Encoding { Raw = 0, Zstd = 1, Member = 2 }

export interface PackedLocation {
  pack: number;
  offset: number;
  length: number;
  encoding: Encoding;
  start: number;
  size: number;
}

/** One object's record as a packing pass prepared it. Records sharing a
 * `frame` (the same `Uint8Array`) are members of one zstd frame. */
export type PackRecord =
  | { hash: string; encoding: Encoding.Raw | Encoding.Zstd; body: Uint8Array; size: number; usedAt?: number }
  | { hash: string; encoding: Encoding.Member; frame: Uint8Array; start: number; size: number; usedAt?: number };

const HASH = /^sha256:([a-f0-9]{64})$/;
const digest = (hash: string) => {
  const match = HASH.exec(hash);
  if (!match) throw new Error(`Invalid object hash: ${hash}`);
  return Buffer.from(match[1]!, "hex");
};
const named = (bytes: Uint8Array) => `sha256:${Buffer.from(bytes).toString("hex")}`;

export const PACK_INDEX = "index.sqlite3";
const JOURNAL = /^journal-[0-9a-f-]{36}\.pack$/;
const JOURNAL_HEADER = 36;
/** A journal this large is left for a new one. */
const JOURNAL_BYTES = 16 << 20;

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
    start INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL,
    used_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.run("CREATE INDEX IF NOT EXISTS packed_objects_pack ON packed_objects(pack)");
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
    db.run("PRAGMA synchronous = FULL");
    createIndex(db);
    this.db = db;
    this.statements = {
      find: db.query("SELECT pack, offset, length, encoding, start, size FROM packed_objects WHERE hash = ?"),
      pack: db.query("SELECT name FROM packs WHERE id = ?"),
      touch: db.query("UPDATE packed_objects SET used_at = max(used_at, ?) WHERE hash = ?"),
    };
    return db;
  }

  /**
   * Index every complete journal record past its journal's indexed length,
   * including journals the index lost (a lost index commit; an append is
   * synced before it is indexed, so a torn last record is never named).
   * Run by the writer before its first append and at host start, not by
   * readers: another process's append may be written and not yet synced.
   * `only` limits it to the named journals.
   */
  recover(only?: Set<string>): number {
    const db = this.index(true)!;
    const known = new Map((db.query("SELECT id, name, bytes FROM packs WHERE name LIKE 'journal-%'").all() as Array<{ id: number; name: string; bytes: number }>)
      .map((row) => [row.name, row]));
    let recovered = 0;
    for (const name of readdirSync(this.directory)) {
      if (!JOURNAL.test(name) || (only && !only.has(name))) continue;
      const row = known.get(name);
      let fd: number;
      try { fd = openSync(join(this.directory, name), "r"); } catch { continue; }
      try {
        const size = fstatSync(fd).size;
        let at = row?.bytes ?? 0;
        if (row && size <= at) continue;
        const found: Array<{ hash: Uint8Array; offset: number; length: number }> = [];
        const header = new Uint8Array(JOURNAL_HEADER);
        while (at + JOURNAL_HEADER <= size) {
          if (readSync(fd, header, 0, JOURNAL_HEADER, at) !== JOURNAL_HEADER) break;
          const length = new DataView(header.buffer).getUint32(0);
          if (at + JOURNAL_HEADER + length > size) break;
          const body = new Uint8Array(length);
          if (readSync(fd, body, 0, length, at + JOURNAL_HEADER) !== length) break;
          const hash = header.slice(4);
          if (!Buffer.from(new Bun.CryptoHasher("sha256").update(body).digest()).equals(Buffer.from(hash))) break;
          found.push({ hash, offset: at + JOURNAL_HEADER, length });
          at += JOURNAL_HEADER + length;
        }
        if (row && at === row.bytes) continue;
        const now = Date.now();
        db.transaction(() => {
          const id = row?.id ?? (db.query("INSERT INTO packs (name, bytes, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = max(bytes, excluded.bytes) RETURNING id").get(name, at, now) as { id: number }).id;
          const insert = db.query(`INSERT OR IGNORE INTO packed_objects (hash, pack, offset, length, encoding, start, size, used_at) VALUES (?, ?, ?, ?, ${Encoding.Raw}, 0, ?, ?)`);
          for (const record of found) insert.run(record.hash, id, record.offset, record.length, record.length, now);
          db.run("UPDATE packs SET bytes = max(bytes, ?) WHERE id = ?", [at, id]);
        })();
        recovered += found.length;
      } finally {
        closeSync(fd);
      }
    }
    return recovered;
  }

  /** This store's open journal, if it has appended. */
  private journal?: { id: number; name: string; fd: number; bytes: number };
  /** Appends run one at a time. */
  private appending: Promise<unknown> = Promise.resolve();
  private recovered = false;

  /**
   * Durably append objects to this store's journal and index them: one
   * write, one `fdatasync`, one index transaction. Objects already packed
   * are skipped. If the journal was collected or rewritten meanwhile (its
   * row is gone), the append is repeated on a new journal. Returns the
   * objects appended.
   */
  append(objects: Array<{ hash: string; bytes: Uint8Array }>, now = Date.now()): Promise<number> {
    const run = this.appending.then(() => this.appendNow(objects, now));
    this.appending = run.catch(() => {});
    return run;
  }

  /** fdatasync calls appends issued; a diagnostic. */
  syncs = 0;

  private async appendNow(objects: Array<{ hash: string; bytes: Uint8Array }>, now: number): Promise<number> {
    const db = this.index(true)!;
    if (!this.recovered) { this.recover(); this.recovered = true; }
    const fresh = objects.filter((o) => !this.has(o.hash));
    if (!fresh.length) return 0;
    const size = fresh.reduce((n, o) => n + JOURNAL_HEADER + o.bytes.byteLength, 0);
    const buffer = new Uint8Array(size), view = new DataView(buffer.buffer);
    const placed: Array<{ hash: Uint8Array; at: number; length: number }> = [];
    let at = 0;
    for (const o of fresh) {
      const hash = digest(o.hash);
      view.setUint32(at, o.bytes.byteLength);
      buffer.set(hash, at + 4);
      buffer.set(o.bytes, at + JOURNAL_HEADER);
      placed.push({ hash, at: at + JOURNAL_HEADER, length: o.bytes.byteLength });
      at += JOURNAL_HEADER + o.bytes.byteLength;
    }
    for (;;) {
      const journal = await this.openJournal();
      let written = 0;
      while (written < size) written += await writeAt(journal.fd, buffer, written, size - written, journal.bytes + written);
      await syncData(journal.fd);
      this.syncs++;
      const end = journal.bytes + size;
      // The commit need not be durable: the journal is, and recovery
      // re-indexes it.
      const indexed = relaxed(db, () => {
        if (!db.query("UPDATE packs SET bytes = ? WHERE id = ?").run(end, journal.id).changes) return false;
        const insert = db.query(`INSERT OR IGNORE INTO packed_objects (hash, pack, offset, length, encoding, start, size, used_at) VALUES (?, ?, ?, ?, ${Encoding.Raw}, 0, ?, ?)`);
        for (const record of placed) insert.run(record.hash, journal.id, journal.bytes + record.at, record.length, record.length, now);
        return true;
      });
      if (indexed) {
        journal.bytes = end;
        if (end >= JOURNAL_BYTES) await this.closeJournal();
        return fresh.length;
      }
      // Collected or rewritten under us: append again to a new journal.
      await this.closeJournal();
    }
  }

  private async openJournal() {
    if (this.journal) return this.journal;
    const db = this.index(true)!;
    const name = `journal-${crypto.randomUUID()}.pack`;
    const fd = openSync(join(this.directory, name), "wx", 0o600);
    try {
      // The new name must survive a crash before any record names it.
      await syncDirectory(this.directory);
      const { id } = db.query("INSERT INTO packs (name, bytes, created_at) VALUES (?, 0, ?) RETURNING id").get(name, Date.now()) as { id: number };
      this.journal = { id, name, fd, bytes: 0 };
      return this.journal;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** Objects held in journals, with their sizes and last use: what
   * packing compresses, as it does loose files. */
  journaled(): Array<{ hash: string; size: number; usedAt: number }> {
    const db = this.index();
    if (!db) return [];
    return (db.query("SELECT hash, size, used_at FROM packed_objects WHERE pack IN (SELECT id FROM packs WHERE name LIKE 'journal-%')").all() as Array<{ hash: Uint8Array; size: number; used_at: number }>)
      .map((row) => ({ hash: named(row.hash), size: row.size, usedAt: row.used_at }));
  }

  /** Rewrite journals other than the one this store appends to whose
   * remaining records fill less than half of them; returns how many. Packing
   * moves records out of journals, and a journal no record is left in is
   * removed with orphans. */
  async compactJournals(): Promise<number> {
    const db = this.index();
    if (!db) return 0;
    let rewritten = 0;
    for (const { id, bytes } of db.query("SELECT id, bytes FROM packs WHERE name LIKE 'journal-%'").all() as Array<{ id: number; bytes: number }>) {
      if (id === this.journal?.id) continue;
      const used = db.query("SELECT coalesce(sum(length), 0) AS n FROM packed_objects WHERE pack = ?").get(id) as { n: number };
      if (used.n > 0 && used.n < bytes / 2) { await this.rewrite(id); rewritten++; }
    }
    return rewritten;
  }

  private async closeJournal(): Promise<void> {
    const journal = this.journal;
    this.journal = undefined;
    if (journal) await closeAsync(journal.fd).catch(() => {});
  }

  locate(hash: string): PackedLocation | null {
    if (!this.index()) return null;
    return (this.statements!.find.get(digest(hash)) as PackedLocation | null) ?? null;
  }

  has(hash: string): boolean {
    return this.locate(hash) !== null;
  }

  /** Mark packed objects as just used; returns the hashes not packed here. */
  freshen(hashes: Iterable<string>, now = Date.now()): string[] {
    const missing: string[] = [];
    const db = this.index();
    if (!db) return [...hashes];
    // A lost freshen only shortens an object's grace: the update that
    // freshened it is lost with it.
    relaxed(db, () => {
      for (const hash of hashes) {
        const result = this.statements!.touch.run(now, digest(hash));
        if (!result.changes) missing.push(hash);
      }
    });
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
   * An object's canonical bytes, or null when it is not packed. The caller
   * checks the result against `hash`. A pack removed by a concurrent rewrite
   * is looked up again.
   */
  async read(hash: string): Promise<Uint8Array | null> {
    for (let attempt = 0; ; attempt++) {
      const at = this.locate(hash);
      if (!at) return null;
      try {
        return await this.decode(at);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt > 0) throw error;
        this.forget(at.pack);
      }
    }
  }

  private async decode(at: PackedLocation): Promise<Uint8Array> {
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
    if (this.journal) { try { closeSync(this.journal.fd); } catch {} this.journal = undefined; }
    for (const pack of [...this.handles.keys()]) this.forget(pack);
    this.db?.close();
    this.db = undefined;
  }

  /**
   * Durably write one pack of `records` and index them in one transaction.
   * The file is complete and synced, under its content's name, before any
   * row names it; a crash before the commit leaves an unindexed pack, which
   * `removeOrphans` deletes. Records already packed elsewhere are skipped,
   * except from a journal: a packed copy replaces a journal's.
   * Returns the pack's id, or null when nothing was new.
   */
  async write(records: PackRecord[], now = Date.now()): Promise<number | null> {
    const db = this.index(true)!;
    // Records a journal holds are packed again, compressed.
    const packed = db.query("SELECT 1 FROM packed_objects WHERE hash = ? AND pack NOT IN (SELECT id FROM packs WHERE name LIKE 'journal-%')");
    const fresh = records.filter((r) => !packed.get(digest(r.hash)));
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
    // A packed copy replaces a journal's (the journal goes once no row
    // names it); any other row already there stays.
    const insertObject = db.query(`INSERT INTO packed_objects (hash, pack, offset, length, encoding, start, size, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET pack = excluded.pack, offset = excluded.offset, length = excluded.length,
        encoding = excluded.encoding, start = excluded.start, size = excluded.size, used_at = max(used_at, excluded.used_at)
      WHERE packed_objects.pack IN (SELECT id FROM packs WHERE name LIKE 'journal-%')`);
    let id = 0;
    db.transaction(() => {
      id = (insertPack.get(name, offset, now) as { id: number }).id;
      for (const { record, offset: o, length } of placed)
        insertObject.run(digest(record.hash), id, o, length, record.encoding,
          record.encoding === Encoding.Member ? record.start : 0, record.size, Math.min(record.usedAt ?? now, now));
    })();
    return id;
  }

  /**
   * Drop packed objects that are neither `live` nor used since `cutoff`.
   * Each row goes only if its `used_at` is still before the cutoff, so a
   * concurrent freshen wins. Then packs that lost at least half their bytes
   * are rewritten with what remains. Returns the dropped objects and bytes.
   */
  async collect(live: Set<string>, cutoff: number, remove: boolean, beforeRemoval?: (dead: string[]) => Promise<void>): Promise<{ objects: number; bytes: number; young: number; kept: number; freshened: number; rewritten: number }> {
    const db = this.index();
    if (!db) { await beforeRemoval?.([]); return { objects: 0, bytes: 0, young: 0, kept: 0, freshened: 0, rewritten: 0 }; }
    const rows = db.query("SELECT hash, size, used_at FROM packed_objects").all() as Array<{ hash: Uint8Array; size: number; used_at: number }>;
    const byHash = new Map(rows.map((r) => [named(r.hash), r]));
    const kept = new Set<string>();
    let young = 0;
    for (const [hash, row] of byHash) {
      if (live.has(hash)) kept.add(hash);
      else if (row.used_at >= cutoff) { young++; kept.add(hash); }
    }
    const dead = [...byHash].filter(([hash]) => !kept.has(hash));
    let objects = 0, bytes = 0, rewritten = 0;
    await beforeRemoval?.(dead.map(([hash]) => hash));
    if (!remove) return { objects: dead.length, bytes: dead.reduce((n, [, r]) => n + r.size, 0), young, kept: kept.size - young, freshened: 0, rewritten };
    const drop = db.query("DELETE FROM packed_objects WHERE hash = ? AND used_at < ?");
    db.transaction(() => {
      for (const [, row] of dead) {
        if (drop.run(row.hash, cutoff).changes) { objects++; bytes += row.size; }
      }
    })();
    for (const { id, bytes: total } of db.query("SELECT id, bytes FROM packs").all() as Array<{ id: number; bytes: number }>) {
      const used = db.query("SELECT coalesce(sum(length), 0) AS n FROM (SELECT DISTINCT offset, length FROM packed_objects WHERE pack = ?)").get(id) as { n: number };
      if (used.n > 0 && used.n < total / 2) { await this.rewrite(id); rewritten++; }
    }
    await this.removeOrphans();
    // Dead rows a concurrent freshen kept.
    return { objects, bytes, young, kept: kept.size - young, freshened: dead.length - objects, rewritten };
  }

  /** Copy a pack's remaining records into a new pack, move their rows in one
   * transaction, then remove the old pack. Records are copied as they are. */
  private async rewrite(pack: number): Promise<void> {
    const db = this.index()!;
    const rows = db.query("SELECT hash, offset, length FROM packed_objects WHERE pack = ?").all(pack) as Array<{ hash: Uint8Array; offset: number; length: number }>;
    const ranges = new Map<number, { length: number; to: number }>();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const row of rows) {
      if (ranges.has(row.offset)) continue;
      const bytes = await this.record({ pack, offset: row.offset, length: row.length, encoding: Encoding.Raw, start: 0, size: row.length });
      ranges.set(row.offset, { length: row.length, to: size });
      chunks.push(bytes); size += bytes.byteLength;
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    const name = await this.writeFile(joined);
    const old = db.query("SELECT name FROM packs WHERE id = ?").get(pack) as { name: string } | null;
    // Another pass removed or rewrote it meanwhile; the new pack, if no row
    // names it, goes with orphans.
    if (!old) return;
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

  /** What the index holds: pack files and their bytes on disk, and the
   * objects they hold with their canonical bytes. */
  usage(): PackUsage {
    const db = this.index();
    if (!db) return { packs: 0, bytes: 0, objects: 0, objectBytes: 0 };
    const packs = db.query("SELECT count(*) AS packs, coalesce(sum(bytes), 0) AS bytes FROM packs").get() as { packs: number; bytes: number };
    const objects = db.query("SELECT count(*) AS objects, coalesce(sum(size), 0) AS objectBytes FROM packed_objects").get() as { objects: number; objectBytes: number };
    return { ...packs, ...objects };
  }

  /**
   * Hash every indexed pack file against its name and size. Reads check each
   * object they decode, so without this a damaged pack is found only when one
   * of its objects is read. Returns the usage and the names of damaged or
   * missing packs.
   */
  async verify(): Promise<PackUsage & { damaged: string[] }> {
    const db = this.index();
    if (!db) return { ...this.usage(), damaged: [] };
    const damaged: string[] = [];
    // A collection in another process may rewrite a pack meanwhile; only a pack still indexed counts.
    const indexed = db.query("SELECT 1 FROM packs WHERE name = ?");
    for (const { name, bytes } of db.query("SELECT name, bytes FROM packs ORDER BY id").all() as Array<{ name: string; bytes: number }>) {
      const file = Bun.file(join(this.directory, name));
      let sound = await file.exists() && (JOURNAL.test(name) ? file.size >= bytes : file.size === bytes);
      if (sound && !JOURNAL.test(name)) {
        const hasher = new Bun.CryptoHasher("sha256");
        for await (const chunk of file.stream()) hasher.update(chunk);
        sound = `${hasher.digest("hex")}.pack` === name;
      }
      if (!sound && indexed.get(name)) damaged.push(name);
    }
    return { ...this.usage(), damaged };
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
        if (!info || (minAgeMs > 0 && info.mtimeMs > Date.now() - minAgeMs)) continue;
        // A journal the index lost is indexed again, not removed: its records
        // were durable before any commit named them.
        if (JOURNAL.test(name) && this.recover(new Set([name]))) continue;
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

export interface PackUsage {
  /** Pack files, and their bytes on disk. */
  packs: number;
  bytes: number;
  /** Objects packed in them, and those objects' canonical bytes. */
  objects: number;
  objectBytes: number;
}

export interface PackCandidate {
  hash: string;
  bytes: Uint8Array;
  /** Document identity (a stable key, a path, a tree's log): versions of one
   * document are packed together. */
  key: string;
  /** When the object was last used (its loose file's time); packing keeps
   * it, so the collector's grace period is not restarted. */
  usedAt?: number;
}

export interface PackOptions {
  level?: number;
  /** Raw bytes per shared frame; an object this large is packed alone. */
  frameBytes?: number;
}

/**
 * Records for `candidates`: documents in order of their first candidate,
 * each document's versions in the order given (oldest first), concatenated
 * into zstd frames of about `frameBytes` raw. A frame ends where a document
 * ends once it is half full, and an object of `frameBytes` or more is packed
 * alone (zstd, or raw when that does not help).
 *
 * Grouping by document is chosen from the 2026-10-09 measurement of a copy
 * of live data (overstoryd 001): versions of one document compress against each
 * other within a frame far better than a delta against only the previous
 * version, and a cold single read decompresses at most one frame.
 */
export function prepareRecords(candidates: PackCandidate[], options: PackOptions = {}): PackRecord[] {
  const level = options.level ?? 3, frameBytes = options.frameBytes ?? 1 << 20;
  const byKey = new Map<string, PackCandidate[]>();
  for (const c of candidates) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)!).push(c);
  const records: PackRecord[] = [];
  let members: PackCandidate[] = [], size = 0;
  const flush = () => {
    if (!members.length) return;
    const joined = new Uint8Array(size);
    let at = 0;
    const starts = members.map((m) => { joined.set(m.bytes, at); at += m.bytes.byteLength; return at - m.bytes.byteLength; });
    const frame = zstd(joined, level);
    members.forEach((m, i) => records.push({ hash: m.hash, encoding: Encoding.Member, frame, start: starts[i]!, size: m.bytes.byteLength, ...(m.usedAt === undefined ? {} : { usedAt: m.usedAt }) }));
    members = []; size = 0;
  };
  for (const versions of byKey.values()) {
    if (size >= frameBytes / 2) flush();
    for (const version of versions) {
      if (version.bytes.byteLength >= frameBytes) {
        const alone = zstd(version.bytes, level);
        const usedAt = version.usedAt === undefined ? {} : { usedAt: version.usedAt };
        records.push(alone.byteLength < version.bytes.byteLength
          ? { hash: version.hash, encoding: Encoding.Zstd, body: alone, size: version.bytes.byteLength, ...usedAt }
          : { hash: version.hash, encoding: Encoding.Raw, body: version.bytes, size: version.bytes.byteLength, ...usedAt });
        continue;
      }
      if (size + version.bytes.byteLength > frameBytes) flush();
      members.push(version); size += version.bytes.byteLength;
    }
  }
  flush();
  return records;
}

const writeAt = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) =>
  new Promise<number>((resolve, reject) => writeFd(fd, buffer, offset, length, position, (error, written) => error ? reject(error) : resolve(written)));
const syncData = promisify(fdatasync);
const closeAsync = promisify(closeFd);

/** Run `body` in one transaction committed without waiting for the disk
 * (WAL, `synchronous = NORMAL`): a crash may lose it, never corrupt it. */
function relaxed<T>(db: Database, body: () => T): T {
  db.run("PRAGMA synchronous = NORMAL");
  try {
    return db.transaction(body)();
  } finally {
    db.run("PRAGMA synchronous = FULL");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** zstd at `level`, with a window large enough for the input. */
export function zstd(bytes: Uint8Array, level: number): Uint8Array {
  const windowLog = Math.min(27, Math.max(19, Math.ceil(Math.log2(Math.max(1, bytes.byteLength)))));
  return new Uint8Array(zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_windowLog]: windowLog },
  } as never));
}
