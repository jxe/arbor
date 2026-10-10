/** Grouping experiments for overstoryd 001 (pack object storage), run on a
 * copied data root: never point it at a data root an overstoryd serves. It reads
 * `objects/` and `overstoryd.sqlite3`, writes candidate layouts under a work
 * directory, replays read workloads against each, and prints one report.
 *
 * Layouts compared, all holding every object once under its own hash:
 * - `loose`: today's one file per object.
 * - `write`: zstd groups in first-acceptance order.
 * - `document`: groups of one document's versions (stable key; a
 *   directory's path; a tree's log entries), documents concatenated.
 * - `hybrid`: the current trees and recent objects stay loose; the rest is
 *   grouped as `document`.
 * - `similar`: groups in order of a content sketch (min-hash of shingles)
 *   within each object kind, regardless of document or time.
 * - `delta-N`: Git-style: each object compressed alone, against the
 *   previous version of its document as a zstd dictionary, with chains of at
 *   most N (a version at the limit, or one a delta does not help, is a base).
 * - `keyframe`: each version compressed against its document's keyframe
 *   (depth one, no chains); one-version documents grouped as `document`.
 *
 *   bun tests/performance/storage/pack-experiments.ts <data-root> [--work DIR] [--quick]
 *     [--policies write,document,hybrid,similar,keyframe,delta-10,delta-50]
 *     [--sizes 262144] [--levels 3] [--cache-mb 8] [--hot-days 7]
 *     [--incremental] [--json report.json]
 */
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { decodeProtocolDirectory, hashObject } from "@ovst/protocol";
import { decodeLogEntry } from "@ovst/merge-protocol";

// ---- Inventory --------------------------------------------------------------

type Kind = "entry" | "directory" | "file";
interface Obj {
  hash: string;
  bytes: Uint8Array;
  kind: Kind;
  /** Document identity: stable key, else tree and first path; a tree's log. */
  key: string;
  /** First accepted update that named it (write-order proxy). */
  order: number;
  /** Position among its document's versions. */
  version: number;
  mtime: number;
  /** Bytes of this object compressed alone (zstd 3), for bypass decisions. */
  alone?: number;
}

interface Row { ordinal: number; tree: string; root: string; entry: string; at: number }

interface Inventory {
  objects: Map<string, Obj>;
  rows: Row[];
  /** Hashes read by each workload, in order. */
  workloads: Record<string, string[]>;
  hot: Set<string>;
  looseAllocated: number;
}

const BLOCK = 4096;
const allocated = (bytes: number) => Math.ceil(bytes / BLOCK) * BLOCK;

async function inventory(root: string, hotDays: number, progress: (m: string) => void): Promise<Inventory> {
  const objectsRoot = join(root, "objects");
  const objects = new Map<string, Obj>();
  let looseAllocated = 0;
  for (const shard of await readdir(objectsRoot)) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    for (const name of await readdir(join(objectsRoot, shard))) {
      if (!/^[a-f0-9]{62}$/.test(name)) continue;
      const path = join(objectsRoot, shard, name);
      const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
      looseAllocated += info.blocks * 512;
      const hash = `sha256:${shard}${name}`;
      objects.set(hash, { hash, bytes: new Uint8Array(bytes), kind: "file", key: "", order: Infinity, version: 0, mtime: info.mtimeMs });
    }
  }
  progress(`${objects.size} objects read`);
  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const rows = (db.query("SELECT ordinal, tree_id AS tree, root, entry, accepted_at AS at FROM accepted_updates ORDER BY ordinal").all() as Row[]);
  const versions = db.query("SELECT tree_id AS tree, stable_key AS key, content_hash AS hash FROM document_versions ORDER BY rowid").all() as Array<{ tree: string; key: string; hash: string }>;
  db.close();
  for (const v of versions) {
    const o = objects.get(v.hash);
    if (o && !o.key) o.key = `doc:${v.tree}:${v.key}`;
  }
  // Classify, and give each object the first accepted update that names it.
  const directories = new Map<string, ReturnType<typeof decodeProtocolDirectory>>();
  const directory = (hash: string) => {
    let d = directories.get(hash);
    if (d === undefined) {
      const o = objects.get(hash);
      if (!o) return null;
      try { d = decodeProtocolDirectory(o.bytes); o.kind = "directory"; } catch { return null; }
      directories.set(hash, d);
    }
    return d;
  };
  for (const o of objects.values()) {
    if (o.bytes[0] === 0x7b) try { decodeLogEntry(o.bytes); o.kind = "entry"; } catch {}
  }
  const seenDirs = new Set<string>();
  for (const row of rows) {
    const entry = objects.get(row.entry);
    if (entry && entry.order === Infinity) { entry.order = row.ordinal; entry.key = `log:${row.tree}`; }
    const pending: Array<[string, string]> = [[row.root, ""]];
    while (pending.length) {
      const [hash, path] = pending.pop()!;
      if (seenDirs.has(hash)) continue;
      seenDirs.add(hash);
      const d = directory(hash), o = objects.get(hash);
      if (!d || !o) continue;
      if (o.order === Infinity) { o.order = row.ordinal; o.key ||= `dir:${row.tree}:${path || "/"}`; }
      for (const e of d.entries) {
        const child = `${path}/${e.name}`;
        if (e.directory) pending.push([e.directory, child]);
        else if (e.file) {
          const f = objects.get(e.file);
          if (f && f.order === Infinity) { f.order = row.ordinal; f.key ||= `path:${row.tree}:${child}`; }
        }
      }
    }
  }
  // Everything else (alternatives, older bodies, unclassified) follows by time.
  const late = [...objects.values()].filter((o) => o.order === Infinity).sort((a, b) => a.mtime - b.mtime);
  const last = rows.at(-1)?.ordinal ?? 0;
  for (const [i, o] of late.entries()) {
    o.order = last + 1 + i;
    if (!o.key) {
      if (directory(o.hash)) o.key = `dir:unplaced:${o.hash.slice(7, 9)}`;
      else o.key = o.kind === "entry" ? "log:unplaced" : `blob:${o.hash}`;
    }
  }
  // Versions within each document, in acceptance order.
  const byKey = new Map<string, Obj[]>();
  for (const o of objects.values()) (byKey.get(o.key) ?? byKey.set(o.key, []).get(o.key)!).push(o);
  for (const list of byKey.values()) list.sort((a, b) => a.order - b.order).forEach((o, i) => { o.version = i; });
  progress(`${rows.length} accepted rows, ${byKey.size} documents`);

  // ---- Workloads: hash sequences replayed against every layout -----------
  const latestRoots = new Map<string, Row>();
  for (const row of rows) latestRoots.set(row.tree, row);
  const closure = (rootHash: string): string[] => {
    const out: string[] = [], seen = new Set<string>(), pending = [rootHash];
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash) || !objects.has(hash)) continue;
      seen.add(hash); out.push(hash);
      const d = directory(hash);
      if (!d) continue;
      for (const e of d.entries) {
        if (e.directory) pending.push(e.directory);
        else if (e.file && !seen.has(e.file) && objects.has(e.file)) { seen.add(e.file); out.push(e.file); }
      }
    }
    return out;
  };
  const current = [...latestRoots.values()].flatMap((row) => closure(row.root));
  // An edit reads the objects that changed between consecutive roots and the
  // versions they replaced: the directories on each changed path, and each
  // changed file's previous body.
  const edits: string[] = [];
  const lastRows = rows.slice(-50);
  for (const row of lastRows) {
    const previous = rows.filter((r) => r.tree === row.tree && r.ordinal < row.ordinal).at(-1);
    edits.push(row.entry);
    if (previous) edits.push(previous.entry);
    const diff = (before: string | undefined, after: string) => {
      const a = after ? directory(after) : null, b = before ? directory(before) : null;
      if (after) edits.push(after);
      if (before) edits.push(before);
      if (!a) return;
      const old = new Map((b?.entries ?? []).map((e) => [e.name, e]));
      for (const e of a.entries) {
        const prior = old.get(e.name);
        if (e.directory && prior?.directory !== e.directory) diff(prior?.directory, e.directory);
        else if (e.file && prior?.file !== e.file) { edits.push(e.file); if (prior?.file) edits.push(prior.file); }
      }
    };
    diff(previous?.root, row.root);
  }
  // Document history: every version of the most-versioned documents.
  const documents = [...byKey.entries()].filter(([key]) => key.startsWith("doc:") || key.startsWith("path:"))
    .sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  const history = documents.flatMap(([, list]) => list.map((o) => o.hash));
  // Full-history load: every log entry, newest first, as replay walks back.
  const log = rows.slice().reverse().map((row) => row.entry);
  // Random single objects, each read with a cold group cache.
  const all = [...objects.keys()];
  let seed = 7;
  const random = Array.from({ length: Math.min(2000, all.length) }, () => all[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % all.length]!);
  const audit = all;
  // Hot: the current trees, recent objects, and the newest log entries.
  const newest = [...objects.values()].reduce((n, o) => Math.max(n, o.mtime), 0);
  const hot = new Set<string>([...current, ...rows.slice(-200).map((row) => row.entry)]);
  for (const o of objects.values()) if (o.mtime >= newest - hotDays * 86_400_000) hot.add(o.hash);
  return { objects, rows, workloads: { current, edits, history, log, random, audit }, hot, looseAllocated };
}

// ---- Layouts ----------------------------------------------------------------

interface Packed {
  name: string;
  /** Bytes on disk, rounded to blocks, including loose objects kept. */
  allocated: number;
  compressed: number;
  files: number;
  groups: number;
  indexBytes: number;
  packMs: number;
  read: (hash: string, cache: GroupCache) => { bytes: Uint8Array; decompressed: number; fileReads: number };
  dispose: () => void;
}

class GroupCache {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  hits = 0; misses = 0;
  constructor(private readonly limit: number) {}
  get(key: string) {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); this.hits++; } else this.misses++;
    return v;
  }
  set(key: string, value: Uint8Array) {
    if (value.byteLength > this.limit) return;
    this.map.set(key, value); this.bytes += value.byteLength;
    for (const [k, v] of this.map) { if (this.bytes <= this.limit) break; this.map.delete(k); this.bytes -= v.byteLength; }
  }
  clear() { this.map.clear(); this.bytes = 0; }
}

function zstd(bytes: Uint8Array, level: number, dictionary?: Uint8Array): Uint8Array {
  const windowLog = Math.min(27, Math.max(19, Math.ceil(Math.log2(Math.max(1, bytes.byteLength)))));
  return new Uint8Array(zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_windowLog]: windowLog },
    ...(dictionary ? { dictionary } : {}),
  } as never));
}
const unzstd = (bytes: Uint8Array, dictionary?: Uint8Array) =>
  new Uint8Array(zstdDecompressSync(bytes, dictionary ? { dictionary } as never : undefined));

function indexSize(work: string, rows: number): number {
  const path = join(work, `index-${rows}.sqlite3`);
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  // Binary digests and integer group ids: a third of the size of text.
  db.run("CREATE TABLE packed_objects (hash BLOB PRIMARY KEY, pack INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL) WITHOUT ROWID");
  const insert = db.prepare("INSERT INTO packed_objects VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(Buffer.from(hashObject(new TextEncoder().encode(String(i))).slice(7), "hex"), i >> 8, i * 1000, 1000);
  })();
  db.run("VACUUM");
  db.close();
  const size = statSync(path).size;
  rmSync(path, { force: true });
  return size;
}

function looseLayout(root: string, inv: Inventory): Packed {
  return {
    name: "loose", allocated: inv.looseAllocated, compressed: [...inv.objects.values()].reduce((n, o) => n + o.bytes.byteLength, 0),
    files: inv.objects.size, groups: 0, indexBytes: 0, packMs: 0,
    read: (hash) => {
      const bytes = new Uint8Array(readFileSync(join(root, "objects", hash.slice(7, 9), hash.slice(9))));
      return { bytes, decompressed: 0, fileReads: 1 };
    },
    dispose: () => {},
  };
}

/** Group files: each a zstd frame of its members' bytes. Objects that do not
 * compress alone below 90% stay raw in a `.raw` group of their own kind. */
function groupLayout(name: string, root: string, work: string, inv: Inventory, groups: string[][], loose: Set<string>, level: number, indexBytesPerRow: number): Packed {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const where = new Map<string, { group: number; offset: number; length: number }>();
  const sizes: number[] = [], raw: boolean[] = [];
  let compressed = 0;
  const started = performance.now();
  for (const [index, members] of groups.entries()) {
    const total = members.reduce((n, h) => n + inv.objects.get(h)!.bytes.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const h of members) {
      const b = inv.objects.get(h)!.bytes;
      joined.set(b, offset);
      where.set(h, { group: index, offset, length: b.byteLength });
      offset += b.byteLength;
    }
    const frame = zstd(joined, level);
    const bypass = frame.byteLength > 0.9 * total;
    const body = bypass ? joined : frame;
    writeFileSync(join(dir, `${index}`), body);
    sizes.push(body.byteLength); raw.push(bypass);
    compressed += body.byteLength;
  }
  const packMs = performance.now() - started;
  let looseBytes = 0;
  for (const h of loose) looseBytes += allocated(inv.objects.get(h)!.bytes.byteLength);
  const packedRows = where.size;
  return {
    name, compressed, groups: groups.length, files: groups.length + loose.size, packMs,
    indexBytes: Math.round(indexBytesPerRow * packedRows),
    allocated: sizes.reduce((n, s) => n + allocated(s), 0) + looseBytes + allocated(Math.round(indexBytesPerRow * packedRows)),
    read: (hash, cache) => {
      const at = where.get(hash);
      if (!at) {
        const bytes = new Uint8Array(readFileSync(join(root, "objects", hash.slice(7, 9), hash.slice(9))));
        return { bytes, decompressed: 0, fileReads: 1 };
      }
      const key = `${at.group}`;
      let group = cache.get(key), decompressed = 0, fileReads = 0;
      if (!group) {
        const body = new Uint8Array(readFileSync(join(dir, key)));
        fileReads = 1;
        group = raw[at.group] ? body : unzstd(body);
        decompressed = raw[at.group] ? 0 : group.byteLength;
        cache.set(key, group);
      }
      return { bytes: group.subarray(at.offset, at.offset + at.length), decompressed, fileReads };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Per-object records in one pack file, each a zstd frame alone, or against
 * a base version of its document as a zstd dictionary:
 * - `chain`: Git-style, against the previous version, at most `depth` deep;
 * - `keyframe`: against the document's current keyframe only (never a
 *   chain); a version a delta does not halve becomes the next keyframe.
 *   Documents with one version are grouped as `document` instead, since
 *   small objects compress poorly alone. */
type DeltaMode = { kind: "chain"; depth: number } | { kind: "keyframe"; groupBytes: number };

function deltaLayout(name: string, work: string, inv: Inventory, mode: DeltaMode, level: number, indexBytesPerRow: number): Packed {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const byKey = new Map<string, Obj[]>();
  for (const o of inv.objects.values()) (byKey.get(o.key) ?? byKey.set(o.key, []).get(o.key)!).push(o);
  const records = new Map<string, { offset: number; length: number; base: string | null; inner?: [number, number] }>();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  // One flag byte: 0 raw, 1 zstd alone, 2 zstd against base, 3 a group frame.
  const append = (flag: number, body: Uint8Array) => {
    const record = new Uint8Array(body.byteLength + 1);
    record[0] = flag; record.set(body, 1);
    chunks.push(record);
    const at = { offset, length: record.byteLength };
    offset += record.byteLength;
    return at;
  };
  const started = performance.now();
  const singles: Obj[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.version - b.version);
    if (mode.kind === "keyframe" && list.length === 1) { singles.push(list[0]!); continue; }
    let previous: Obj | null = null, keyframe: Obj | null = null, chain = 0;
    for (const o of list) {
      const alone = zstd(o.bytes, level);
      let body = alone.byteLength < o.bytes.byteLength ? alone : o.bytes, base: string | null = null;
      const against = mode.kind === "chain" ? (chain < mode.depth ? previous : null) : keyframe;
      if (against) {
        const delta = zstd(o.bytes, level, against.bytes);
        const enough = mode.kind === "chain" ? 0.8 : 0.5;
        if (delta.byteLength < enough * body.byteLength) { body = delta; base = against.hash; }
      }
      chain = base ? chain + 1 : 0;
      if (!base) keyframe = o;
      records.set(o.hash, { ...append(base ? 2 : body === o.bytes ? 0 : 1, body), base });
      previous = o;
    }
  }
  if (mode.kind === "keyframe") for (const members of documentOrder(singles, mode.groupBytes)) {
    const joined = new Uint8Array(members.reduce((n, h) => n + inv.objects.get(h)!.bytes.byteLength, 0));
    const inner: Array<[string, number, number]> = [];
    let o = 0;
    for (const h of members) { const b = inv.objects.get(h)!.bytes; joined.set(b, o); inner.push([h, o, b.byteLength]); o += b.byteLength; }
    const at = append(3, zstd(joined, level));
    for (const [h, start, length] of inner) records.set(h, { ...at, base: null, inner: [start, length] });
  }
  const packPath = join(dir, "pack");
  const pack = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { pack.set(c, at); at += c.byteLength; }
  writeFileSync(packPath, pack);
  const packMs = performance.now() - started;
  const fd = openSync(packPath, "r");
  const load = (hash: string, cache: GroupCache, stats: { decompressed: number; fileReads: number }): Uint8Array => {
    const r = records.get(hash)!;
    const key = r.inner ? `g${r.offset}` : hash;
    let bytes = cache.get(key);
    if (!bytes) {
      const record = new Uint8Array(r.length);
      readSync(fd, record, 0, r.length, r.offset);
      stats.fileReads++;
      const body = record.subarray(1);
      if (record[0] === 0) bytes = body;
      else if (record[0] === 1 || record[0] === 3) bytes = unzstd(body);
      else bytes = unzstd(body, load(r.base!, cache, stats));
      stats.decompressed += record[0] ? bytes.byteLength : 0;
      cache.set(key, bytes);
    }
    return r.inner ? bytes.subarray(r.inner[0], r.inner[0] + r.inner[1]) : bytes;
  };
  return {
    name, compressed: offset, groups: 1, files: 1, packMs, indexBytes: Math.round(indexBytesPerRow * records.size),
    allocated: allocated(offset) + allocated(Math.round(indexBytesPerRow * records.size)),
    read: (hash, cache) => {
      const stats = { decompressed: 0, fileReads: 0 };
      return { bytes: load(hash, cache, stats), ...stats };
    },
    dispose: () => { closeSync(fd); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- Grouping policies ------------------------------------------------------

/** Cut an ordered list into groups of about `target` raw bytes; with `keys`,
 * a group also ends where a document ends once it is half full. */
function chunk(list: Obj[], target: number, byDocument: boolean): string[][] {
  const groups: string[][] = [];
  let current: string[] = [], size = 0, key = "";
  for (const o of list) {
    const boundary = byDocument && o.key !== key && size >= target / 2;
    if (current.length && (size + o.bytes.byteLength > target || boundary)) { groups.push(current); current = []; size = 0; }
    current.push(o.hash); size += o.bytes.byteLength; key = o.key;
  }
  if (current.length) groups.push(current);
  return groups;
}

const KIND_RANK: Record<Kind, number> = { file: 0, directory: 1, entry: 2 };

function writeOrder(objects: Obj[], target: number) {
  return chunk(objects.slice().sort((a, b) => a.order - b.order || KIND_RANK[a.kind] - KIND_RANK[b.kind]), target, false);
}

function documentOrder(objects: Obj[], target: number) {
  // Documents in order of first appearance; each one's versions together.
  const first = new Map<string, number>();
  for (const o of objects) first.set(o.key, Math.min(first.get(o.key) ?? Infinity, o.order));
  return chunk(objects.slice().sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || first.get(a.key)! - first.get(b.key)! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.version - b.version), target, true);
}

/** Min-hash of 8-byte shingles sampled at content-defined points: objects
 * sharing their smallest shingle hashes sort together. */
function sketch(bytes: Uint8Array): [number, number] {
  let best = 0xffffffff, second = 0xffffffff;
  for (let i = 0; i + 8 <= bytes.length; i++) {
    let h = 2166136261;
    for (let j = 0; j < 8; j++) h = Math.imul(h ^ bytes[i + j]!, 16777619) >>> 0;
    const g = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    if (h < best) best = h;
    if (g < second) second = g;
  }
  return [best, second];
}

function similarOrder(objects: Obj[], target: number) {
  const sketches = new Map(objects.map((o) => [o.hash, sketch(o.bytes)]));
  const sizeClass = (o: Obj) => Math.floor(Math.log2(o.bytes.byteLength + 1));
  return chunk(objects.slice().sort((a, b) => {
    const sa = sketches.get(a.hash)!, sb = sketches.get(b.hash)!;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind] || sa[0] - sb[0] || sa[1] - sb[1] || sizeClass(a) - sizeClass(b) || a.order - b.order;
  }), target, false);
}

// ---- Measurement ------------------------------------------------------------

interface WorkloadResult { reads: number; ms: number; p50: number; p95: number; decompressedMB: number; fileReads: number; cacheHits: number }

function replay(layout: Packed, inv: Inventory, hashes: string[], cacheBytes: number, coldEach: boolean, verify: boolean): WorkloadResult {
  const cache = new GroupCache(cacheBytes);
  const times: number[] = [];
  let decompressed = 0, fileReads = 0;
  const started = performance.now();
  for (const hash of hashes) {
    if (coldEach) cache.clear();
    const t = performance.now();
    const r = layout.read(hash, cache);
    times.push(performance.now() - t);
    decompressed += r.decompressed; fileReads += r.fileReads;
    if (verify && hashObject(r.bytes) !== hash) throw new Error(`${layout.name} returned the wrong bytes for ${hash}`);
    if (!verify && r.bytes.byteLength !== inv.objects.get(hash)!.bytes.byteLength) throw new Error(`${layout.name} returned the wrong length for ${hash}`);
  }
  const ms = performance.now() - started;
  times.sort((a, b) => a - b);
  const q = (p: number) => times.length ? +times[Math.min(times.length - 1, Math.floor(p * times.length))]!.toFixed(4) : 0;
  return { reads: hashes.length, ms: +ms.toFixed(1), p50: q(0.5), p95: q(0.95), decompressedMB: +(decompressed / 1048576).toFixed(2), fileReads, cacheHits: cache.hits };
}

/** Incremental packing as history arrives: every `step` accepted updates,
 * objects first named at least `lag` updates ago are packed with the policy,
 * leaving earlier groups untouched. Reports the final compressed size. */
function incremental(inv: Inventory, policy: (objects: Obj[], target: number) => string[][], target: number, level: number, step: number, lag: number) {
  const objects = [...inv.objects.values()].sort((a, b) => a.order - b.order);
  const last = objects.at(-1)?.order ?? 0;
  let packed = 0, compressed = 0, groups = 0, allocatedBytes = 0, cursor = 0;
  for (let at = step; at <= last + step; at += step) {
    const eligible: Obj[] = [];
    while (cursor < objects.length && objects[cursor]!.order <= at - lag) eligible.push(objects[cursor++]!);
    if (!eligible.length) continue;
    for (const members of policy(eligible, target)) {
      const joined = new Uint8Array(members.reduce((n, h) => n + inv.objects.get(h)!.bytes.byteLength, 0));
      let o = 0;
      for (const h of members) { const b = inv.objects.get(h)!.bytes; joined.set(b, o); o += b.byteLength; }
      const size = Math.min(zstd(joined, level).byteLength, joined.byteLength);
      compressed += size; allocatedBytes += allocated(size); groups++; packed += members.length;
    }
  }
  return { packed, groups, compressedMB: +(compressed / 1048576).toFixed(2), allocatedMB: +(allocatedBytes / 1048576).toFixed(2) };
}

// ---- Main ------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const bool = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const quick = bool("--quick"), withIncremental = bool("--incremental");
  const root = resolve(flag("--data-root") ?? args[0] ?? "");
  const work = resolve(flag("--work") ?? join(root, "..", `pack-experiments-${process.pid}`));
  const policies = (flag("--policies") ?? "write,document,hybrid,similar,keyframe,delta-10,delta-50").split(",");
  const sizes = (flag("--sizes") ?? (quick ? "262144" : "65536,262144,1048576,4194304")).split(",").map(Number);
  const levels = (flag("--levels") ?? "3").split(",").map(Number);
  const cacheBytes = Number(flag("--cache-mb") ?? 8) * 1048576;
  const hotDays = Number(flag("--hot-days") ?? 7);
  const jsonOut = flag("--json");
  if (!root || !statSync(join(root, "overstoryd.sqlite3"), { throwIfNoEntry: false })) {
    console.error("usage: pack-experiments.ts <copied-data-root> [--work DIR] [--policies ...] [--sizes ...] [--levels ...] [--cache-mb 8] [--hot-days 7] [--incremental] [--quick] [--json FILE]");
    process.exit(2);
  }
  mkdirSync(work, { recursive: true });
  const progress = (m: string) => console.error(`pack-experiments: ${m}`);
  const started = performance.now();
  const inv = await inventory(root, hotDays, progress);
  const objects = [...inv.objects.values()];
  const kinds: Record<string, { objects: number; bytes: number }> = {};
  for (const o of objects) { const k = (kinds[o.kind] ??= { objects: 0, bytes: 0 }); k.objects++; k.bytes += o.bytes.byteLength; }
  const sizesSorted = objects.map((o) => o.bytes.byteLength).sort((a, b) => a - b);
  const keyCounts = new Map<string, number>();
  for (const o of objects) keyCounts.set(o.key, (keyCounts.get(o.key) ?? 0) + o.bytes.byteLength);
  const topDocuments = [...keyCounts].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([key, bytes]) => ({ key: key.replace(/^(doc|path|dir):[^:]+:/, "$1:"), bytes, versions: objects.filter((o) => o.key === key).length }));
  const summary = {
    objects: objects.length,
    rawMB: +(sizesSorted.reduce((n, s) => n + s, 0) / 1048576).toFixed(1),
    looseAllocatedMB: +(inv.looseAllocated / 1048576).toFixed(1),
    median: sizesSorted[Math.floor(sizesSorted.length / 2)], p90: sizesSorted[Math.floor(sizesSorted.length * 0.9)], max: sizesSorted.at(-1),
    kinds, hot: inv.hot.size, rows: inv.rows.length, topDocuments,
    workloads: Object.fromEntries(Object.entries(inv.workloads).map(([k, v]) => [k, v.length])),
  };
  progress(JSON.stringify(summary));
  const perRow = indexSize(work, 20_000) / 20_000;
  const results: Array<Record<string, unknown>> = [];
  const measure = (layout: Packed, extra: Record<string, unknown> = {}) => {
    const workloads: Record<string, WorkloadResult> = {};
    for (const [name, hashes] of Object.entries(inv.workloads)) {
      if (quick && name === "audit") continue;
      workloads[name] = replay(layout, inv, hashes, cacheBytes, name === "random", name === "audit" || name === "current");
    }
    const row = {
      layout: layout.name, ...extra,
      allocatedMB: +(layout.allocated / 1048576).toFixed(2), compressedMB: +(layout.compressed / 1048576).toFixed(2),
      files: layout.files, groups: layout.groups, indexMB: +(layout.indexBytes / 1048576).toFixed(2), packMs: Math.round(layout.packMs),
      workloads,
    };
    results.push(row);
    progress(`${layout.name}: ${row.allocatedMB} MB allocated, ${row.files} files, ${row.packMs} ms; edits ${workloads.edits?.ms} ms, history ${workloads.history?.ms} ms, random p95 ${workloads.random?.p95} ms`);
    layout.dispose();
  };
  measure(looseLayout(root, inv));
  const notHot = objects.filter((o) => !inv.hot.has(o.hash));
  for (const level of levels) for (const policy of policies) {
    if (policy.startsWith("delta-")) {
      const depth = Number(policy.slice(6));
      measure(deltaLayout(`${policy}-l${level}`, work, inv, { kind: "chain", depth }, level, perRow), { policy, level });
      continue;
    }
    if (policy === "keyframe") {
      measure(deltaLayout(`keyframe-l${level}`, work, inv, { kind: "keyframe", groupBytes: 262144 }, level, perRow), { policy, level });
      continue;
    }
    for (const size of sizes) {
      const name = `${policy}-${size >> 10}k-l${level}`;
      const grouping = policy === "write" ? writeOrder(objects, size)
        : policy === "document" ? documentOrder(objects, size)
        : policy === "similar" ? similarOrder(objects, size)
        : policy === "hybrid" ? documentOrder(notHot, size)
        : null;
      if (!grouping) throw new Error(`Unknown policy ${policy}`);
      const loose = policy === "hybrid" ? inv.hot : new Set<string>();
      measure(groupLayout(name, root, work, inv, grouping, loose, level, perRow), { policy, size, level });
    }
  }
  const incrementalResults: Array<Record<string, unknown>> = [];
  if (withIncremental) {
    for (const size of sizes) for (const [name, policy] of [["write", writeOrder], ["document", documentOrder], ["similar", similarOrder]] as const) {
      for (const step of [50, 200]) {
        const r = incremental(inv, policy, size, levels[0]!, step, 20);
        incrementalResults.push({ policy: name, size, step, ...r });
        progress(`incremental ${name} ${size >> 10}k every ${step}: ${r.compressedMB} MB in ${r.groups} groups`);
      }
    }
  }
  rmSync(work, { recursive: true, force: true });
  const report = { summary, cacheMB: cacheBytes / 1048576, hotDays, results, incremental: incrementalResults, ms: Math.round(performance.now() - started) };
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
