import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { hashObject } from "@overstory/protocol";
import { StateRecordReader, StateRecordWriter } from "./retained-state.ts";
import type { SavedCheckpoint } from "./sidecar.ts";

const FORMAT = "arbor-merge-records-1";
const FILE = "records-v2.sqlite";
const PACK_BYTES = 1024 * 1024;
/** Decompressed packs kept while reading one checkpoint. */
const READ_CACHE_BYTES = 16 * 1024 * 1024;
/** Collect once stored record bytes exceed this multiple of the live bytes
 * the last collection found, and at least `COLLECT_FLOOR`. */
const COLLECT_RATIO = 2;
const COLLECT_FLOOR = 16 * 1024 * 1024;
const HASH = /sha256:[a-f0-9]{64}/g;

interface Manifest {
  format: string; tree: string; entry: string; object: string; state: string;
  decisions: SavedCheckpoint["decisions"];
  states: Array<[string, string]>; objects: string[];
}

const key = (hash: string) => Buffer.from(hash.slice(7), "hex");
const named = (bytes: Uint8Array) => `sha256:${Buffer.from(bytes).toString("hex")}`;
const compress = (bytes: Uint8Array) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } } as never);

/** Private, versioned cache. State records and cache-only objects are stored
 * once by hash, as raw bytes in zstd packs of about 1 MiB, indexed by binary
 * hash; checkpoint manifests name them. Dependencies and manifest commit in
 * one transaction. Removing a checkpoint drops only its manifest; records no
 * manifest reaches are collected once garbage doubles. A `records-v1.sqlite`
 * from the undeployed previous layout is deleted: the cache is disposable. */
export class CheckpointStore {
  private db: Database;
  private writer: StateRecordWriter;
  private pending = new Map<string, Uint8Array>();
  private pendingBytes = 0;
  private dataVersion?: number;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(directory, `records-v1.sqlite${suffix}`), { force: true });
    this.db = new Database(join(directory, FILE));
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS packs (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL, raw INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records (hash BLOB PRIMARY KEY, pack INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS records_pack ON records(pack);
      CREATE TABLE IF NOT EXISTS checkpoints (tree TEXT NOT NULL, entry TEXT NOT NULL, savedAt REAL NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(tree, entry));`);
    this.writer = new StateRecordWriter((bytes) => this.put(bytes));
  }
  close(): void { this.db.close(); }
  list(): Array<{ tree: string; entry: string; savedAt: number }> {
    return this.db.query("SELECT tree, entry, savedAt FROM checkpoints").all() as Array<{ tree: string; entry: string; savedAt: number }>;
  }
  private has(hash: string): boolean {
    return this.pending.has(hash) || !!this.db.query("SELECT 1 FROM records WHERE hash = ?").get(key(hash));
  }
  private put(bytes: Uint8Array): string {
    const hash = hashObject(bytes);
    if (!this.has(hash)) {
      this.pending.set(hash, bytes);
      this.pendingBytes += bytes.byteLength;
      if (this.pendingBytes >= PACK_BYTES) this.flush();
    }
    return hash;
  }
  /** Write pending records (and objects) as one pack. */
  private flush(): void {
    if (!this.pending.size) return;
    const joined = new Uint8Array(this.pendingBytes);
    const placed: Array<[string, number, number]> = [];
    let offset = 0;
    for (const [hash, bytes] of this.pending) {
      joined.set(bytes, offset);
      placed.push([hash, offset, bytes.byteLength]);
      offset += bytes.byteLength;
    }
    const { lastInsertRowid } = this.db.query("INSERT INTO packs(bytes, raw) VALUES (?, ?)").run(compress(joined), offset);
    const insert = this.db.query("INSERT INTO records(hash, pack, offset, length) VALUES (?, ?, ?, ?)");
    for (const [hash, at, length] of placed) insert.run(key(hash), lastInsertRowid, at, length);
    this.pending.clear(); this.pendingBytes = 0;
  }
  write(checkpoint: SavedCheckpoint): void {
    try {
      this.db.transaction(() => {
        // Another connection's commit may have collected what this writer
        // remembers as published.
        const version = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
        if (version !== this.dataVersion) this.writer.clear();
        this.dataVersion = version;
        const states = [...checkpoint.states].map(([id, state]) => [id, this.writer.state(state)] as [string, string]);
        for (const [hash, bytes] of checkpoint.objects) {
          if (hashObject(bytes) !== hash) throw new Error("Invalid checkpoint object");
          if (!this.has(hash)) {
            this.pending.set(hash, bytes);
            this.pendingBytes += bytes.byteLength;
            if (this.pendingBytes >= PACK_BYTES) this.flush();
          }
        }
        this.flush();
        const manifest: Manifest = { format: FORMAT, tree: checkpoint.tree, entry: checkpoint.entry,
          object: checkpoint.object, state: checkpoint.state, decisions: checkpoint.decisions, states,
          objects: checkpoint.objects.map(([hash]) => hash) };
        this.db.query("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?)")
          .run(checkpoint.tree, checkpoint.entry, Date.now(), JSON.stringify(manifest));
      }).immediate();
      this.dataVersion = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    } catch (error) {
      this.pending.clear(); this.pendingBytes = 0; this.writer.clear();
      throw error;
    }
  }
  read(tree: string, entry: string): SavedCheckpoint | null {
    try {
      return this.db.transaction(() => this.load(tree, entry))();
    } catch (error) {
      // A damaged shared pack can affect several manifests. Drop the private
      // graph together, so future saves cannot reuse its broken dependencies.
      this.db.transaction(() => {
        this.db.exec("DELETE FROM checkpoints; DELETE FROM records; DELETE FROM packs; DELETE FROM meta;");
      }).immediate();
      this.writer.clear();
      throw error;
    }
  }
  private load(tree: string, entry: string): SavedCheckpoint | null {
    const row = this.db.query("SELECT manifest FROM checkpoints WHERE tree = ? AND entry = ?").get(tree, entry) as { manifest: string } | null;
    if (!row) return null;
    const manifest = JSON.parse(row.manifest) as Manifest;
    if (manifest.format !== FORMAT || manifest.tree !== tree || manifest.entry !== entry) throw new Error("Invalid checkpoint manifest");
    // Every location in one query: a restore reads most records.
    const at = new Map<string, { pack: number; offset: number; length: number }>();
    for (const r of this.db.query("SELECT hash, pack, offset, length FROM records").all() as Array<{ hash: Uint8Array; pack: number; offset: number; length: number }>)
      at.set(named(r.hash), r);
    const packs = new Map<number, Uint8Array>();
    let packBytes = 0;
    const record = (hash: string): Uint8Array => {
      const index = at.get(hash);
      if (!index) throw new Error("Missing checkpoint record");
      let pack = packs.get(index.pack);
      if (pack) { packs.delete(index.pack); packs.set(index.pack, pack); }
      else {
        const stored = this.db.query("SELECT bytes FROM packs WHERE id = ?").get(index.pack) as { bytes: Uint8Array } | null;
        if (!stored) throw new Error("Missing checkpoint pack");
        pack = new Uint8Array(zstdDecompressSync(stored.bytes));
        packs.set(index.pack, pack); packBytes += pack.byteLength;
        for (const [id, oldest] of packs) {
          if (packBytes <= READ_CACHE_BYTES || packs.size <= 1) break;
          packs.delete(id); packBytes -= oldest.byteLength;
        }
      }
      if (index.offset + index.length > pack.byteLength) throw new Error("Invalid checkpoint index");
      const bytes = pack.slice(index.offset, index.offset + index.length);
      if (hashObject(bytes) !== hash) throw new Error("Corrupt checkpoint record");
      return bytes;
    };
    const reader = new StateRecordReader(record);
    const states = new Map(manifest.states.map(([id, ref]) => {
      const decoded = reader.state(ref);
      if (decoded.id !== id || decoded.state.tree !== tree) throw new Error("Invalid checkpoint state identity");
      return [id, decoded.state] as const;
    }));
    const objects = manifest.objects.map((hash): [string, Uint8Array] => [hash, record(hash)]);
    return { ...manifest, states, objects };
  }
  /** Drop a checkpoint's manifest; collect when garbage has doubled. */
  remove(tree: string, entry: string): void {
    this.db.query("DELETE FROM checkpoints WHERE tree = ? AND entry = ?").run(tree, entry);
    const stored = (this.db.query("SELECT coalesce(sum(raw), 0) AS n FROM packs").get() as { n: number }).n;
    const live = (this.db.query("SELECT value FROM meta WHERE key = 'live'").get() as { value: number } | null)?.value ?? 0;
    if (stored > Math.max(COLLECT_FLOOR, COLLECT_RATIO * live)) this.collect();
  }
  /**
   * Keep what retained manifests reach (any hash a record names), drop the
   * rest, and repack packs with at least a quarter dead bytes. One
   * sequential pass over the packs builds the adjacency, so shared history is
   * decompressed once. Returns the live raw bytes.
   */
  collect(): number {
    let liveBytes = 0;
    this.db.transaction(() => {
      const roots: string[] = [];
      for (const row of this.db.query("SELECT manifest FROM checkpoints").all() as Array<{ manifest: string }>) {
        const m = JSON.parse(row.manifest) as Manifest;
        roots.push(...m.states.map(([, ref]) => ref), ...m.objects);
      }
      const records = this.db.query("SELECT hash, pack, offset, length FROM records").all() as Array<{ hash: Uint8Array; pack: number; offset: number; length: number }>;
      const index = new Map(records.map((r, i) => [named(r.hash), i]));
      const byPack = new Map<number, number[]>();
      for (const [i, r] of records.entries()) (byPack.get(r.pack) ?? byPack.set(r.pack, []).get(r.pack)!).push(i);
      const links: Uint32Array[] = new Array(records.length);
      const packBytes = new Map<number, Uint8Array>();
      for (const [id, members] of byPack) {
        const stored = this.db.query("SELECT bytes FROM packs WHERE id = ?").get(id) as { bytes: Uint8Array };
        const pack = new Uint8Array(zstdDecompressSync(stored.bytes));
        packBytes.set(id, pack);
        for (const i of members) {
          const r = records[i]!;
          const text = Buffer.from(pack.subarray(r.offset, r.offset + r.length)).toString("latin1");
          const children: number[] = [];
          for (const hash of text.match(HASH) ?? []) {
            const child = index.get(hash);
            if (child !== undefined) children.push(child);
          }
          links[i] = Uint32Array.from(children);
        }
      }
      const seen = new Uint8Array(records.length);
      const pending = roots.flatMap((hash) => { const i = index.get(hash); return i === undefined ? [] : [i]; });
      while (pending.length) {
        const i = pending.pop()!;
        if (seen[i]) continue;
        seen[i] = 1;
        liveBytes += records[i]!.length;
        for (const child of links[i]!) if (!seen[child]) pending.push(child);
      }
      const drop = this.db.query("DELETE FROM records WHERE hash = ?");
      const move = this.db.query("UPDATE records SET offset = ? WHERE hash = ?");
      for (const [id, members] of byPack) {
        const kept = members.filter((i) => seen[i]);
        for (const i of members) if (!seen[i]) drop.run(records[i]!.hash);
        if (!kept.length) { this.db.query("DELETE FROM packs WHERE id = ?").run(id); continue; }
        const keptBytes = kept.reduce((n, i) => n + records[i]!.length, 0);
        const raw = packBytes.get(id)!;
        if (keptBytes > raw.byteLength * 0.75) continue;
        // Repack so a few shared records cannot retain mostly dead packs.
        const compact = new Uint8Array(keptBytes);
        let offset = 0;
        for (const i of kept) {
          const r = records[i]!;
          compact.set(raw.subarray(r.offset, r.offset + r.length), offset);
          move.run(offset, r.hash);
          offset += r.length;
        }
        this.db.query("UPDATE packs SET bytes = ?, raw = ? WHERE id = ?").run(compress(compact), keptBytes, id);
      }
      this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('live', ?)").run(liveBytes);
    }).immediate();
    this.writer.clear();
    return liveBytes;
  }
}
