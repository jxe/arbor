import { access, link, mkdir, open, readFile, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isProtocolContentKind,
  applyObjectDelta,
  hashObject,
  protocolObjectReferences,
  type ObjectDelta,
  type ProtocolObjectKind,
  type ObjectHash,
  type TreeSnapshot,
} from "@ovst/protocol";

import { Packs, prepareRecords, type PackCandidate, type PackOptions } from "./packs.ts";

export { Encoding, PACK_INDEX, Packs, zstd, type PackCandidate, type PackOptions, type PackRecord, type PackUsage, type PackedLocation } from "./packs.ts";
export { HashPointers } from "./pointers.ts";

const HASH = /^sha256:[a-f0-9]{64}$/;

/**
 * Shared content-addressed object store plus the one graph walk every
 * reachability, snapshot, and delta question is phrased in. Durable objects
 * are appended to a journal and later packed (see `Packs`); scratch objects
 * are immutable loose files sharded by hash; a `proposed` map lets callers reason about
 * a candidate graph before any of its objects are durable.
 */
export class ObjectStore {
  /** Verified immutable bytes by hash; content addressing makes a hit exact. */
  private readonly cache = new Map<ObjectHash, Uint8Array>();
  private cachedBytes = 0;
  private readonly cacheLimit: number;

  /** Cumulative read-side counters for diagnostics; callers diff snapshots. */
  readonly readCounters: ObjectReadCounters = { reads: 0, files: 0, bytes: 0, milliseconds: 0 };

  /** `cacheBytes` above zero keeps that many bytes of hash-verified objects in
   * memory. Only for stores whose files are never rewritten in place. */
  constructor(private readonly root: string, options: { cacheBytes?: number } = {}) {
    this.cacheLimit = Math.max(0, options.cacheBytes ?? 0);
    this.packs = new Packs(root);
  }

  /** Objects packed out of their loose files, and the journal durable
   * writes append to (see `Packs`). Reads and presence checks fall back to
   * them. */
  readonly packs: Packs;

  path(hash: ObjectHash): string {
    if (!HASH.test(hash)) throw new Error(`Invalid object hash: ${hash}`);
    return join(this.root, hash.slice(7, 9), hash.slice(9));
  }

  /** Exact stored bytes; throws when the object is absent or corrupt. */
  async read(hash: ObjectHash): Promise<Uint8Array> {
    this.readCounters.reads++;
    const cached = this.cache.get(hash);
    if (cached) {
      // Refresh recency so the working set survives eviction.
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const started = performance.now();
    const bytes = await this.readStored(hash);
    this.readCounters.files++;
    this.readCounters.bytes += bytes.byteLength;
    this.readCounters.milliseconds += performance.now() - started;
    if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    this.remember(hash, bytes);
    return bytes;
  }

  /** Loose bytes, else packed bytes; ENOENT when neither holds `hash`. A
   * packing pass indexes an object before removing its loose file, so a
   * loose miss followed by an index miss means the object is absent. */
  private async readStored(hash: ObjectHash): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.path(hash)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const packed = await this.packs.read(hash);
      if (packed) return packed;
      throw error;
    }
  }

  private remember(hash: ObjectHash, bytes: Uint8Array): void {
    if (!this.cacheLimit || bytes.byteLength > this.cacheLimit / 8 || this.cache.has(hash)) return;
    this.cache.set(hash, bytes);
    this.cachedBytes += bytes.byteLength;
    for (const [oldest, old] of this.cache) {
      if (this.cachedBytes <= this.cacheLimit) break;
      this.cache.delete(oldest);
      this.cachedBytes -= old.byteLength;
    }
  }

  /** Bytes from the proposal or the store, or null when neither has them. */
  async find(hash: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<Uint8Array | null> {
    const candidate = proposed.get(hash);
    if (candidate) return candidate;
    try {
      return await this.read(hash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Bytes from the proposal or the store; throws when neither has them. */
  async load(hash: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<Uint8Array> {
    return proposed.get(hash) ?? await this.read(hash);
  }

  /**
   * Walk one graph depth-first from `root`, visiting every object once.
   * `visit` returns false to stop early; a missing object ends the walk and
   * is reported as `complete: false`.
   */
  private async walk(
    root: ObjectHash,
    proposed: ReadonlyMap<ObjectHash, Uint8Array>,
    visit: (hash: ObjectHash, bytes: Uint8Array) => boolean | void,
    seen = new Set<ObjectHash>(),
  ): Promise<{ complete: boolean; stopped: boolean }> {
    const pending: Array<{ hash: ObjectHash; kind: ProtocolObjectKind }> = [{ hash: root, kind: "directory" }];
    while (pending.length) {
      const { hash, kind } = pending.pop()!;
      // The same bytes may be a file in one accepted root and a directory in
      // another. A verified file does not establish the directory descendants.
      const key = `${kind}:${hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = await this.find(hash, proposed);
      if (!bytes) return { complete: false, stopped: false };
      if (visit(hash, bytes) === false) return { complete: true, stopped: true };
      pending.push(...protocolObjectReferences(kind, bytes));
    }
    return { complete: true, stopped: false };
  }

  /** Whether `target` is reachable from `root` through stored or proposed objects. */
  async contains(root: ObjectHash, target: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<boolean> {
    return this.containsAny([root], target, proposed);
  }

  /** Membership needs directory edges, not unrelated file bodies. Share the
   * visited frontier across retained roots so common subtrees are read once. */
  async containsAny(roots: Iterable<ObjectHash>, target: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<boolean> {
    const seen = new Set<ObjectHash>();
    for (const root of roots) {
      const pending: Array<{ hash: ObjectHash; kind: ProtocolObjectKind }> = [{ hash: root, kind: "directory" }];
      while (pending.length) {
        const { hash, kind } = pending.pop()!;
        if (hash === target) return true;
        if (seen.has(hash)) continue;
        seen.add(hash);
        const bytes = await this.find(hash, proposed);
        if (!bytes) continue;
        // Nested trees have their own authority boundary, so they are no edge.
        for (const edge of protocolObjectReferences(kind, bytes)) {
          if (edge.hash === target) return true;
          if (!isProtocolContentKind(edge.kind)) pending.push(edge);
        }
      }
    }
    return false;
  }

  /** Every object reachable from `root`, as a self-contained snapshot. */
  async completeSnapshot(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<TreeSnapshot> {
    const objects = new Map<ObjectHash, Uint8Array>();
    const { complete } = await this.walk(root, proposed, (hash, bytes) => { objects.set(hash, bytes); });
    if (!complete) throw new Error(`Snapshot is missing a reachable object under ${root}`);
    return { root, objects };
  }

  /** Confirm every object reachable from the given roots is present and
   * hash-consistent. With `freshen`, every one found in the store rather than
   * in `proposed` is then freshened: a caller about to commit a reference to
   * those objects uses this to keep them from a concurrent collector.
   *
   * `retained` names roots of retained accepted rows: complete, and kept by
   * the collector, so nothing they reach is read again or freshened. Only
   * their directories are read, to learn what they reach; a root that shares
   * most of a retained one costs what it changed, not its size. */
  async verifyReachable(roots: ObjectHash[], proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map(), options: { freshen?: boolean; retained?: readonly ObjectHash[] } = {}): Promise<void> {
    const seen = new Set<ObjectHash>(), stored = new Set<ObjectHash>();
    for (const root of options.retained ?? []) await this.reachedDirectories(root, seen);
    for (const root of roots) {
      const { complete } = await this.walk(root, proposed, (hash) => { if (!proposed.has(hash)) stored.add(hash); }, seen);
      if (!complete) throw new Error(`Retained history is missing an object under ${root}`);
    }
    if (options.freshen) await this.freshen(stored);
  }

  /** Mark what a retained root reaches in `seen` (as `walk` keys it), reading
   * only its directories: a reached file's bytes are never read. */
  private async reachedDirectories(root: ObjectHash, seen: Set<string>): Promise<void> {
    const pending: ObjectHash[] = [root];
    while (pending.length) {
      const hash = pending.pop()!, key = `directory:${hash}`;
      if (seen.has(key)) continue;
      const bytes = await this.find(hash);
      if (!bytes) continue; // not stored: the walk reads it, and fails, as usual
      seen.add(key);
      for (const edge of protocolObjectReferences("directory", bytes)) {
        if (edge.kind === "directory") pending.push(edge.hash);
        else if (isProtocolContentKind(edge.kind)) seen.add(`${edge.kind}:${edge.hash}`);
      }
    }
  }

  /**
   * Mark stored objects as just used, as a write of identical bytes does.
   * The object collector never deletes an unreferenced object used within
   * its grace period, so an object an update is about to name survives a
   * concurrent collection. Throws when an object is gone: the collector took
   * it first, and the caller must not commit a reference to it.
   */
  async freshen(hashes: Iterable<ObjectHash>): Promise<void> {
    // A packed or journaled object's index row carries its time, set for all
    // of them in one transaction; only the rest are loose files to touch.
    const unpacked = this.packs.freshen(new Set(hashes));
    const missing: ObjectHash[] = [];
    await mapLimit(unpacked, WRITE_CONCURRENCY, async (hash) => {
      if (!await touch(this.path(hash))) missing.push(hash);
    });
    if (missing.length) throw new Error(`Stored object vanished: ${missing[0]}`);
  }

  /**
   * Materialize one update element's object deltas against its basis graph.
   * Deltas address canonical object bytes, so a reconstructed result is
   * hash-checked and decoded exactly like a complete supplied object, then
   * added to `proposed`.
   *
   * `complete` holds the hashes this element also supplied as complete
   * objects. Within the element a result appears once, as one delta or one
   * complete object. `proposed` also holds what earlier elements of the same
   * request supplied, and an element may carry one of those again: a chain
   * that returns to an earlier state produces the same object twice.
   */
  async reconstructDeltas(
    baseRoot: ObjectHash,
    deltas: ObjectDelta[],
    proposed: Map<ObjectHash, Uint8Array>,
    complete: ReadonlySet<ObjectHash>,
  ): Promise<Array<{ hash: ObjectHash; bytes: Uint8Array }>> {
    const reconstructed: Array<{ hash: ObjectHash; bytes: Uint8Array }> = [];
    const results = new Set<ObjectHash>();
    for (const delta of deltas) {
      if (!HASH.test(delta.base) || !HASH.test(delta.result)) throw new Error("Invalid object delta hash");
      if (results.has(delta.result) || complete.has(delta.result)) {
        throw new Error(`Duplicate object delta result: ${delta.result}`);
      }
      results.add(delta.result);
      if (!delta.instructions.length) throw new Error("Object delta instructions must not be empty");
      if (!await this.contains(baseRoot, delta.base, proposed)) {
        throw new Error(`Object delta base is not reachable from basis: ${delta.base}`);
      }
      const base = await this.load(delta.base, proposed);
      if (hashObject(base) !== delta.base) throw new Error(`Object delta base hash mismatch: ${delta.base}`);
      const bytes = applyObjectDelta(base, delta);
      if (hashObject(bytes) !== delta.result) throw new Error(`Object delta result hash mismatch: ${delta.result}`);
      proposed.set(delta.result, bytes);
      reconstructed.push({ hash: delta.result, bytes });
    }
    return reconstructed;
  }

  /**
   * Move loose objects into one pack (see `prepareRecords`), then remove
   * their loose files. Each candidate's bytes are hash-checked first, and
   * every packed object is read back through the index and hash-checked
   * before any loose file goes, so a crash at any point leaves each object
   * readable loose, packed, or both. Only one pass may run at a time.
   */
  async pack(candidates: PackCandidate[], options: PackOptions = {}): Promise<{ packed: number; bytes: number; packBytes: number }> {
    for (const c of candidates) if (hashObject(c.bytes) !== c.hash) throw new Error(`Object hash mismatch: ${c.hash}`);
    // Candidates an interrupted pass already indexed are not written again,
    // but their loose files are still checked against the pack and removed.
    const id = await this.packs.write(prepareRecords(candidates, options));
    for (const c of candidates) {
      const back = await this.packs.read(c.hash);
      if (!back || hashObject(back) !== c.hash) throw new Error(`Packed object does not read back: ${c.hash}`);
    }
    let bytes = 0;
    for (const c of candidates) {
      await unlink(this.path(c.hash)).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      bytes += c.bytes.byteLength;
    }
    const packBytes = id === null ? 0 : (this.packs.index()!.query("SELECT bytes FROM packs WHERE id = ?").get(id) as { bytes: number }).bytes;
    return { packed: candidates.length, bytes, packBytes };
  }

  /**
   * Durably publish objects. New ones are appended to this store's journal
   * (see `Packs.append`): one write and one sync for the whole call, and no
   * file or directory to create. One already packed is freshened, as git
   * does, so the collector treats it as new; its bytes were hash-checked
   * when packed and are on every read. A loose copy of an object (staged, or
   * stored before journals) is left as it is: the journal holds the durable
   * copy, and the collector keeps whichever one is used.
   */
  async store(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    const unique = this.checked(objects);
    for (const [hash, bytes] of unique) this.remember(hash, bytes);
    const missing = new Set(this.packs.freshen(unique.keys()));
    if (!missing.size) return;
    const before = this.packs.syncs;
    this.writes.written += await this.packs.append([...missing].map((hash) => ({ hash, bytes: unique.get(hash)! })));
    this.writes.fsyncs += this.packs.syncs - before;
  }

  /** Index journal records a crash left unindexed. A host runs this once as
   * it starts, before it reads; the first `store` also runs it. */
  recover(): number {
    return this.packs.recover();
  }

  /** Publish complete scratch objects as loose files, atomically and without
   * any fsync, so without promising survival of a host crash. Only for
   * disposable worker staging and caches; accepted storage uses store. An
   * existing object is freshened, its bytes checked first. `repair` replaces
   * an existing file whose bytes do not match its hash (scratch data a crash
   * tore) instead of failing. */
  async stage(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>, options: { repair?: boolean } = {}): Promise<void> {
    await mapLimit(this.checked(objects), WRITE_CONCURRENCY, async ([hash, bytes]) => {
      const path = this.path(hash);
      if (await this.verifyExisting(path, hash, options.repair) && await touch(path)) return;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
        this.writes.written++;
        try {
          // A hard link publishes the complete inode without ever replacing
          // an immutable object that another writer may have published first.
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!await this.verifyExisting(path, hash)) throw new Error(`Stored object vanished: ${hash}`);
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    });
  }

  /** Cumulative write-side counters for diagnostics; callers diff snapshots. */
  readonly writes: ObjectWriteCounters = { objects: 0, written: 0, fsyncs: 0 };

  /** Objects deduplicated by hash, each checked against its hash. */
  private checked(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>): Map<ObjectHash, Uint8Array> {
    const unique = new Map<ObjectHash, Uint8Array>();
    for (const object of objects) {
      if (hashObject(object.bytes) !== object.hash) throw new Error(`Object hash mismatch: ${object.hash}`);
      unique.set(object.hash, object.bytes);
    }
    this.writes.objects += unique.size;
    return unique;
  }

  private async verifyExisting(path: string, hash: ObjectHash, repair = false): Promise<boolean> {
    let existing: Uint8Array;
    try {
      existing = new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (hashObject(existing) !== hash) {
      if (!repair) throw new Error(`Stored object hash mismatch: ${hash}`);
      await unlink(path).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      return false;
    }
    return true;
  }
}

export interface ObjectReadCounters {
  /** Read calls, including cache hits. */
  reads: number;
  /** Reads that went to the filesystem. */
  files: number;
  /** Bytes read from the filesystem. */
  bytes: number;
  /** Wall time spent in filesystem reads. */
  milliseconds: number;
}

export interface ObjectWriteCounters {
  /** Objects a durable or scratch publish considered, including repeats. */
  objects: number;
  /** New files written. */
  written: number;
  /** fsync calls issued. */
  fsyncs: number;
}

const WRITE_CONCURRENCY = 32;

/** Set a file's times to now; false when it does not exist. */
async function touch(path: string): Promise<boolean> {
  const now = new Date();
  try {
    await utimes(path, now, now);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function mapLimit<T>(items: Iterable<T>, limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (index < queue.length) await task(queue[index++]!);
  });
  await Promise.all(workers);
}

/** Whether `store` already holds `hash`, without reading or hashing it.
 * Presence only: whoever later reads the object still hash-checks it. */
export async function holdsObject(store: ObjectStore, hash: string): Promise<boolean> {
  try {
    await access(store.path(hash));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return store.packs.has(hash);
    throw error;
  }
}

/** The values `store` lacks, checked 64 at a time. */
export async function absentFrom<T extends { hash: string }>(store: ObjectStore, values: Iterable<T>): Promise<T[]> {
  const all = [...values], missing: T[] = [];
  for (let i = 0; i < all.length; i += 64) {
    const slice = all.slice(i, i + 64);
    const present = await Promise.all(slice.map((value) => holdsObject(store, value.hash)));
    missing.push(...slice.filter((_, index) => !present[index]));
  }
  return missing;
}
