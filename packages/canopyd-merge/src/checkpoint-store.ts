import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { hashObject } from "@overstory/protocol";
import { StateRecordReader, StateRecordWriter } from "./retained-state.ts";
import type { SavedCheckpoint } from "./sidecar.ts";

const FORMAT = "arbor-merge-records-1";
const PACK_BYTES = 1024 * 1024;
interface Manifest {
  format: string; tree: string; entry: string; object: string; state: string;
  decisions: SavedCheckpoint["decisions"];
  states: Array<[string, string]>; objects: string[];
}

/** Private, versioned cache. Compressed packs amortize SQLite/deflate overhead
 * across small immutable records; indexed identities share records across
 * checkpoints. Dependencies and manifest commit in one transaction. */
export class CheckpointStore {
  private db: Database;
  private writer: StateRecordWriter;
  private pending = new Map<string, Uint8Array>();
  private pendingBytes = 0;
  private dataVersion?: number;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "records-v1.sqlite"));
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS packs (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (hash TEXT PRIMARY KEY, pack INTEGER NOT NULL, slot INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (tree TEXT NOT NULL, entry TEXT NOT NULL, savedAt REAL NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(tree, entry));`);
    this.writer = new StateRecordWriter((bytes) => this.put(bytes));
  }
  close(): void { this.db.close(); }
  list(): Array<{ tree: string; entry: string; savedAt: number }> {
    return this.db.query("SELECT tree, entry, savedAt FROM checkpoints").all() as Array<{ tree: string; entry: string; savedAt: number }>;
  }
  private put(bytes: Uint8Array): string {
    const hash = hashObject(bytes);
    if (!this.pending.has(hash) && !this.db.query("SELECT 1 FROM records WHERE hash = ?").get(hash)) {
      this.pending.set(hash, bytes);
      this.pendingBytes += bytes.byteLength;
      if (this.pendingBytes >= PACK_BYTES) this.flush();
    }
    return hash;
  }
  private flush(): void {
    if (!this.pending.size) return;
    const records = [...this.pending].map(([hash, bytes]) => [hash, new TextDecoder().decode(bytes)] as const);
    const packed = gzipSync(JSON.stringify(records), { level: 6 });
    const { lastInsertRowid } = this.db.query("INSERT INTO packs(bytes) VALUES (?)").run(packed);
    const insert = this.db.query("INSERT INTO records(hash, pack, slot) VALUES (?, ?, ?)");
    for (const [slot, [hash]] of records.entries()) insert.run(hash, lastInsertRowid, slot);
    this.pending.clear(); this.pendingBytes = 0;
  }
  write(checkpoint: SavedCheckpoint): void {
    try {
      this.db.transaction(() => {
        const version = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
        if (version !== this.dataVersion) this.writer.clear();
        this.dataVersion = version;
        const states = [...checkpoint.states].map(([id, state]) => [id, this.writer.state(state)] as [string, string]);
        this.flush();
        const objects = this.db.query("INSERT OR IGNORE INTO objects(hash, bytes) VALUES (?, ?)");
        for (const [hash, bytes] of checkpoint.objects) {
          if (hashObject(bytes) !== hash) throw new Error("Invalid checkpoint object");
          if (!this.db.query("SELECT 1 FROM objects WHERE hash = ?").get(hash)) objects.run(hash, gzipSync(bytes, { level: 1 }));
        }
        const manifest: Manifest = { format: FORMAT, tree: checkpoint.tree, entry: checkpoint.entry,
          object: checkpoint.object, state: checkpoint.state, decisions: checkpoint.decisions, states,
          objects: checkpoint.objects.map(([hash]) => hash) };
        this.db.query("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?)")
          .run(checkpoint.tree, checkpoint.entry, Date.now(), JSON.stringify(manifest));
      }).immediate();
    } catch (error) {
      this.pending.clear(); this.pendingBytes = 0; this.writer.clear();
      throw error;
    }
  }
  read(tree: string, entry: string): SavedCheckpoint | null {
    try { return this.db.transaction(() => this.load(tree, entry))(); }
    catch (error) {
      // A damaged shared pack can affect several manifests. Drop the private
      // graph together, so future saves cannot reuse its broken dependencies.
      this.db.transaction(() => {
        this.db.exec("DELETE FROM checkpoints; DELETE FROM records; DELETE FROM packs; DELETE FROM objects;");
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
    // Bound decompressed packs to 16 MiB. The reader retains decoded records,
    // not a second expanded copy of all serialized history.
    const packs = new Map<number, { records: Array<[string, string]>; bytes: number }>();
    let packBytes = 0;
    const reader = new StateRecordReader((hash) => {
      const index = this.db.query("SELECT pack, slot FROM records WHERE hash = ?").get(hash) as { pack: number; slot: number } | null;
      if (!index) throw new Error("Missing checkpoint record");
      let pack = packs.get(index.pack);
      if (!pack) {
        const stored = this.db.query("SELECT bytes FROM packs WHERE id = ?").get(index.pack) as { bytes: Uint8Array } | null;
        if (!stored) throw new Error("Missing checkpoint pack");
        const json = gunzipSync(stored.bytes);
        pack = { records: JSON.parse(json.toString()), bytes: json.byteLength };
        packs.set(index.pack, pack); packBytes += pack.bytes;
        for (const [id, oldest] of packs) {
          if (packBytes <= 16 * 1024 * 1024 || packs.size <= 1) break;
          packs.delete(id); packBytes -= oldest.bytes;
        }
      } else { packs.delete(index.pack); packs.set(index.pack, pack); }
      const record = pack.records[index.slot];
      if (!record || record[0] !== hash) throw new Error("Invalid checkpoint index");
      const bytes = new TextEncoder().encode(record[1]);
      if (hashObject(bytes) !== hash) throw new Error("Corrupt checkpoint record");
      return bytes;
    });
    const states = new Map(manifest.states.map(([id, ref]) => {
      const decoded = reader.state(ref);
      if (decoded.id !== id || decoded.state.tree !== tree) throw new Error("Invalid checkpoint state identity");
      return [id, decoded.state] as const;
    }));
    const objects = manifest.objects.map((hash): [string, Uint8Array] => {
      const stored = this.db.query("SELECT bytes FROM objects WHERE hash = ?").get(hash) as { bytes: Uint8Array } | null;
      if (!stored) throw new Error("Missing checkpoint object");
      const bytes = gunzipSync(stored.bytes);
      if (hashObject(bytes) !== hash) throw new Error("Corrupt checkpoint object");
      return [hash, bytes];
    });
    return { ...manifest, states, objects };
  }
  remove(tree: string, entry: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM checkpoints WHERE tree = ? AND entry = ?").run(tree, entry);
      const roots: string[] = [], objects: string[] = [];
      for (const row of this.db.query("SELECT manifest FROM checkpoints").all() as Array<{ manifest: string }>) {
        const m = JSON.parse(row.manifest) as Manifest;
        roots.push(...m.states.map(([, ref]) => ref)); objects.push(...m.objects);
      }
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS live(hash TEXT PRIMARY KEY); DELETE FROM live;");
      const add = this.db.query("INSERT OR IGNORE INTO live VALUES (?)");
      for (const root of roots) add.run(root);
      // Build a compact adjacency index with one sequential pass over packs.
      // Random graph walks with a small decompression cache repeatedly inflate
      // the same packs when many branches share historical records.
      const records = this.db.query("SELECT hash, pack, slot FROM records").all() as Array<{ hash: string; pack: number; slot: number }>;
      const identities = new Map(records.map((record, index) => [record.hash, index]));
      const grouped = new Map<number, number[]>();
      for (const [index, record] of records.entries()) {
        const group = grouped.get(record.pack) ?? [];
        group.push(index); grouped.set(record.pack, group);
      }
      const links: Uint32Array[] = new Array(records.length);
      for (const [id, group] of grouped) {
        const data = this.db.query("SELECT bytes FROM packs WHERE id = ?").get(id) as { bytes: Uint8Array };
        const pack = JSON.parse(gunzipSync(data.bytes).toString()) as Array<[string, string]>;
        for (const index of group) {
          const record = records[index]!, raw = pack[record.slot];
          if (!raw || raw[0] !== record.hash) throw new Error("Invalid checkpoint index during collection");
          const children: number[] = [];
          for (const hash of raw[1].match(/sha256:[a-f0-9]{64}/g) ?? []) {
            const child = identities.get(hash);
            if (child !== undefined) children.push(child);
          }
          links[index] = Uint32Array.from(children);
        }
      }
      const seen = new Uint8Array(records.length), pending = roots.flatMap((hash) => {
        const id = identities.get(hash); return id === undefined ? [] : [id];
      });
      while (pending.length) {
        const index = pending.pop()!;
        if (seen[index]) continue;
        seen[index] = 1;
        add.run(records[index]!.hash);
        for (const child of links[index]!) if (!seen[child]) pending.push(child);
      }
      this.db.exec(`DELETE FROM records WHERE hash NOT IN (SELECT hash FROM live);
        DELETE FROM packs WHERE id NOT IN (SELECT pack FROM records);`);
      // Repack fragmented groups so a few shared records cannot retain an
      // unbounded succession of mostly dead packs. SQLite reuses freed pages.
      for (const row of this.db.query("SELECT id, bytes FROM packs").all() as Array<{ id: number; bytes: Uint8Array }>) {
        const packed = JSON.parse(gunzipSync(row.bytes).toString()) as Array<[string, string]>;
        const kept = this.db.query("SELECT hash, slot FROM records WHERE pack = ? ORDER BY slot").all(row.id) as Array<{ hash: string; slot: number }>;
        if (kept.length > packed.length * 0.75) continue;
        const compact = kept.map(({ hash, slot }) => {
          const value = packed[slot];
          if (!value || value[0] !== hash) throw new Error("Invalid checkpoint pack during collection");
          return value;
        });
        this.db.query("UPDATE packs SET bytes = ? WHERE id = ?").run(gzipSync(JSON.stringify(compact), { level: 6 }), row.id);
        const relocate = this.db.query("UPDATE records SET slot = ? WHERE hash = ?");
        for (const [slot, [hash]] of compact.entries()) relocate.run(slot, hash);
      }
      this.db.exec("DELETE FROM live;");
      for (const hash of objects) add.run(hash);
      this.db.exec("DELETE FROM objects WHERE hash NOT IN (SELECT hash FROM live); DELETE FROM live;");
    }).immediate();
    this.writer.clear();
  }
}
