import { access, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyObjectDelta,
  decodeWireDirectory,
  hashObject,
  wireEntryObject,
  type ObjectDelta,
  type ObjectHash,
  type TreeSnapshot,
} from "@overstory/protocol";

const HASH = /^sha256:[a-f0-9]{64}$/;

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Shared content-addressed object store plus the one graph walk every
 * reachability, snapshot, and delta question is phrased in. Objects are
 * immutable files sharded by hash; a `proposed` map lets callers reason about
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
  }

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
    const bytes = new Uint8Array(await readFile(this.path(hash)));
    this.readCounters.files++;
    this.readCounters.bytes += bytes.byteLength;
    this.readCounters.milliseconds += performance.now() - started;
    if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    this.remember(hash, bytes);
    return bytes;
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
    const pending: Array<{ hash: ObjectHash; kind: "file" | "directory" }> = [{ hash: root, kind: "directory" }];
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
      if (kind === "directory") {
        for (const entry of decodeWireDirectory(bytes).entries) {
          const target = wireEntryObject(entry);
          if (target) pending.push(target);
        }
      }
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
      const pending = [root];
      while (pending.length) {
        const hash = pending.pop()!;
        if (hash === target) return true;
        if (seen.has(hash)) continue;
        seen.add(hash);
        const bytes = await this.find(hash, proposed);
        if (!bytes) continue;
        for (const entry of decodeWireDirectory(bytes).entries) {
          const edge = wireEntryObject(entry);
          if (!edge) continue; // Nested trees have their own authority boundary.
          if (edge.hash === target) return true;
          if (edge.kind === "directory") pending.push(edge.hash);
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

  /** Confirm every object reachable from the given roots is present and hash-consistent. */
  async verifyReachable(roots: ObjectHash[], proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<void> {
    const seen = new Set<ObjectHash>();
    for (const root of roots) {
      const { complete } = await this.walk(root, proposed, () => {}, seen);
      if (!complete) throw new Error(`Retained history is missing an object under ${root}`);
    }
  }

  /**
   * Materialize every submitted object delta against a retained base graph.
   * Deltas address canonical object bytes, so a reconstructed result is
   * hash-checked and decoded exactly like a complete supplied object, then
   * added to `proposed`.
   */
  async reconstructDeltas(
    baseRoot: ObjectHash,
    deltas: ObjectDelta[],
    proposed: Map<ObjectHash, Uint8Array>,
  ): Promise<Array<{ hash: ObjectHash; bytes: Uint8Array }>> {
    const reconstructed: Array<{ hash: ObjectHash; bytes: Uint8Array }> = [];
    const results = new Set<ObjectHash>();
    for (const delta of deltas) {
      if (!HASH.test(delta.base) || !HASH.test(delta.result)) throw new Error("Invalid object delta hash");
      if (results.has(delta.result) || proposed.has(delta.result)) {
        throw new Error(`Duplicate object delta result: ${delta.result}`);
      }
      results.add(delta.result);
      if (!delta.instructions.length) throw new Error("Object delta instructions must not be empty");
      if (!await this.contains(baseRoot, delta.base)) {
        throw new Error(`Object delta base is not reachable from retained base: ${delta.base}`);
      }
      const bytes = applyObjectDelta(await this.read(delta.base), delta);
      if (hashObject(bytes) !== delta.result) throw new Error(`Object delta result hash mismatch: ${delta.result}`);
      proposed.set(delta.result, bytes);
      reconstructed.push({ hash: delta.result, bytes });
    }
    return reconstructed;
  }

  /** Durably publish objects; an object already present must be byte-identical. */
  async store(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    await this.publish(objects, true);
  }

  /** Publish complete scratch objects atomically, without promising survival of
   * a host crash. Only for disposable worker staging; accepted storage uses store. */
  async stage(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    await this.publish(objects, false);
  }

  /** Cumulative write-side counters for diagnostics; callers diff snapshots. */
  readonly writes: ObjectWriteCounters = { objects: 0, written: 0, fsyncs: 0 };

  /** Hashes this process has already made durable, so a repeated durable
   * publish of the same object re-verifies bytes but issues no further fsync.
   * Bounded: forgetting an entry only costs one redundant sync. */
  private readonly durable = new Set<ObjectHash>();

  private async publish(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>, durable: boolean): Promise<void> {
    const unique = new Map<ObjectHash, Uint8Array>();
    for (const object of objects) {
      if (hashObject(object.bytes) !== object.hash) throw new Error(`Object hash mismatch: ${object.hash}`);
      unique.set(object.hash, object.bytes);
    }
    this.writes.objects += unique.size;
    if (durable) for (const [hash, bytes] of unique) this.remember(hash, bytes);
    // Directories whose entries changed or whose files were only staged
    // before; each is synced once after every file in it is complete.
    const directories = new Set<string>();
    await mapLimit(unique, WRITE_CONCURRENCY, async ([hash, bytes]) => {
      const path = this.path(hash);
      const directory = dirname(path);
      // Stored bytes are always re-checked; only the fsync is skipped once
      // this process has made the object durable.
      if (await this.verifyExisting(path, hash)) {
        // An existing object may have been published as scratch data. Complete
        // file and directory durability without rewriting identical bytes.
        if (durable && !this.durable.has(hash)) { await this.sync(path); directories.add(directory); }
        return;
      }
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(bytes);
          if (durable) { this.writes.fsyncs++; await file.sync(); }
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
          if (durable) await this.sync(path);
        }
        if (durable) directories.add(directory);
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    });
    if (!durable) return;
    // Bytes are on disk before any directory entry is synced, and every entry
    // is synced before this resolves, so a subsequent database commit only
    // names durable objects. Shards may themselves be new, so flush the root.
    await mapLimit(directories, WRITE_CONCURRENCY, (directory) => this.sync(directory));
    if (directories.size) await this.sync(this.root);
    for (const hash of unique.keys()) this.durable.add(hash);
    if (this.durable.size > DURABLE_MEMORY) {
      for (const hash of this.durable) {
        if (this.durable.size <= DURABLE_MEMORY / 2) break;
        this.durable.delete(hash);
      }
    }
  }

  private async verifyExisting(path: string, hash: ObjectHash): Promise<boolean> {
    let existing: Uint8Array;
    try {
      existing = new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (hashObject(existing) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    return true;
  }

  private async sync(path: string): Promise<void> {
    this.writes.fsyncs++;
    await syncPath(path);
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
const DURABLE_MEMORY = 200_000;

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
