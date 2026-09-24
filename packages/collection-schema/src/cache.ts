import { revisionOf } from "@overstory/protocol";
import { compileCollectionSchema, type CollectionSchema } from "./compile.ts";

/**
 * A content-addressed, bounded cache of compiled schemas. Entries are keyed
 * by the SHA-256 of the exact source bytes, so an entry can never describe
 * other bytes. A failed compilation throws and is never cached.
 */
export class CollectionSchemaCache {
  private readonly entries = new Map<string, CollectionSchema>();
  private weight = 0;

  /**
   * `maxWeight` bounds the summed syntax nodes of cached schemas; one
   * profile-maximal schema weighs 32,768, so the default holds eight of those
   * or many ordinary ones.
   */
  constructor(
    private readonly maxEntries = 64,
    private readonly maxWeight = 262_144,
  ) {}

  compile(input: Uint8Array | string): CollectionSchema {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const key = revisionOf(bytes);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const schema = compileCollectionSchema(bytes);
    this.entries.set(key, schema);
    this.weight += schema.weight;
    while (this.entries.size > this.maxEntries || (this.weight > this.maxWeight && this.entries.size > 1)) {
      const [oldest, entry] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.weight -= entry.weight;
    }
    return schema;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }
}

/** The process-wide cache used when a caller does not supply its own. */
export const sharedCollectionSchemaCache = new CollectionSchemaCache();
