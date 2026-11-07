import { hashObject, ProtocolHTTPError, type ProtocolClient } from "@ovst/protocol";

/**
 * Where objects come from (Clients 003, module 2): memory, a disk cache, a
 * placed folder, Story Sync, the host. Browser-safe; the on-disk store in
 * `./index.ts` is one source among others. The Swift twin is
 * `ObjectStore` / `ObjectSourceChain` in `OverstoryObjectStore`.
 */
export interface ObjectSource {
  /** The object's canonical bytes, or undefined when this source lacks it. */
  object(hash: string): Promise<Uint8Array | undefined>;
}

export class ObjectSourceMissing extends Error {
  constructor(readonly hash: string) {
    super(`Object ${hash} is unavailable`);
  }
}

/** What a chain reports about a source it passed over. */
export interface ObjectSourceSkip {
  hash: string;
  /** The source's position in the chain. */
  source: number;
  reason: "error" | "hash-mismatch";
  error?: unknown;
}

/**
 * Sources tried in order. Every answer is checked against its hash, and a
 * source that fails or answers wrong bytes is passed over, so the order is
 * only about speed. When no source holds the object and one of them failed,
 * the last failure is thrown rather than reported as a miss, so a caller
 * still tells "offline" from "absent".
 */
export class ObjectSourceChain implements ObjectSource {
  constructor(readonly sources: readonly ObjectSource[], private readonly skipped?: (skip: ObjectSourceSkip) => void) {}

  async object(hash: string): Promise<Uint8Array | undefined> {
    let failure: { error: unknown } | undefined;
    for (const [index, source] of this.sources.entries()) {
      let bytes: Uint8Array | undefined;
      try { bytes = await source.object(hash); } catch (error) {
        this.skipped?.({ hash, source: index, reason: "error", error });
        failure = { error };
        continue;
      }
      if (!bytes) continue;
      if (hashObject(bytes) === hash) return bytes;
      this.skipped?.({ hash, source: index, reason: "hash-mismatch" });
    }
    if (failure) throw failure.error;
    return undefined;
  }

  /** The object, or `ObjectSourceMissing` when no source holds it. */
  async require(hash: string): Promise<Uint8Array> {
    const bytes = await this.object(hash);
    if (!bytes) throw new ObjectSourceMissing(hash);
    return bytes;
  }
}

/** Objects already in hand: a projection, a replayed watch batch, a path read. */
export function memorySource(objects: ReadonlyMap<string, Uint8Array>): ObjectSource {
  return { object: async (hash) => objects.get(hash) };
}

/** The tree's host (or Story Sync on loopback) through the standard object route; a 404 is a miss. */
export function hostSource(client: Pick<ProtocolClient, "object">, tree: string): ObjectSource {
  return {
    object: async (hash) => {
      try { return await client.object(tree, hash); } catch (error) {
        if (error instanceof ProtocolHTTPError && error.status === 404) return undefined;
        throw error;
      }
    },
  };
}
