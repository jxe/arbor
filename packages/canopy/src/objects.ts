import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyObjectDelta,
  decodeWireObject,
  hashObject,
  wireEntryObjectHashes,
  type ObjectDelta,
  type ObjectHash,
  type TreeSnapshot,
} from "@arbor/wire";

const HASH = /^sha256:[a-f0-9]{64}$/;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Canopy's content-addressed object store plus the one graph walk every
 * reachability, snapshot, and delta question is phrased in. Objects are
 * immutable files sharded by hash; a `proposed` map lets callers reason about
 * a candidate graph before any of its objects are durable.
 */
export class ObjectStore {
  constructor(private readonly root: string) {}

  path(hash: ObjectHash): string {
    if (!HASH.test(hash)) throw new Error(`Invalid object hash: ${hash}`);
    return join(this.root, hash.slice(7, 9), hash.slice(9));
  }

  /** Exact stored bytes; throws when the object is absent or corrupt. */
  async read(hash: ObjectHash): Promise<Uint8Array> {
    const bytes = new Uint8Array(await readFile(this.path(hash)));
    if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
    return bytes;
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
  ): Promise<{ complete: boolean; stopped: boolean }> {
    const pending = [root];
    const seen = new Set<ObjectHash>();
    while (pending.length) {
      const hash = pending.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const bytes = await this.find(hash, proposed);
      if (!bytes) return { complete: false, stopped: false };
      if (visit(hash, bytes) === false) return { complete: true, stopped: true };
      const object = decodeWireObject(bytes);
      if (object.type === "directory") {
        for (const entry of object.entries) pending.push(...wireEntryObjectHashes(entry));
      }
    }
    return { complete: true, stopped: false };
  }

  /** Whether `target` is reachable from `root` through stored or proposed objects. */
  async contains(root: ObjectHash, target: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<boolean> {
    const { stopped } = await this.walk(root, proposed, (hash) => hash !== target);
    return stopped;
  }

  /** Every object reachable from `root`, as a self-contained snapshot. */
  async completeSnapshot(root: ObjectHash, proposed: ReadonlyMap<ObjectHash, Uint8Array> = new Map()): Promise<TreeSnapshot> {
    const objects = new Map<ObjectHash, Uint8Array>();
    const { complete } = await this.walk(root, proposed, (hash, bytes) => { objects.set(hash, bytes); });
    if (!complete) throw new Error(`Snapshot is missing a reachable object under ${root}`);
    return { root, objects };
  }

  /** Confirm every object reachable from the given roots is present and hash-consistent. */
  async verifyReachable(roots: ObjectHash[]): Promise<void> {
    const seen = new Set<ObjectHash>();
    for (const root of roots) {
      const { complete } = await this.walk(root, new Map(), (hash) => { seen.add(hash); });
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
      decodeWireObject(bytes);
      proposed.set(delta.result, bytes);
      reconstructed.push({ hash: delta.result, bytes });
    }
    return reconstructed;
  }

  /** Durably publish objects; an object already present must be byte-identical. */
  async store(objects: Iterable<{ hash: ObjectHash; bytes: Uint8Array }>): Promise<void> {
    for (const object of objects) {
      if (hashObject(object.bytes) !== object.hash) throw new Error(`Object hash mismatch: ${object.hash}`);
      const path = this.path(object.hash);
      const directory = dirname(path);
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(object.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // A hard link publishes the fully flushed inode without ever replacing
          // an immutable object that another writer may have published first.
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = new Uint8Array(await readFile(path));
          if (hashObject(existing) !== object.hash) {
            throw new Error(`Stored object hash mismatch: ${object.hash}`);
          }
        }
        await unlink(temporary);
        await syncDirectory(directory);
        // The two-hex-character shard may itself have been created for this
        // object, so flush its entry in the stable objects directory too.
        await syncDirectory(dirname(directory));
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
  }
}
