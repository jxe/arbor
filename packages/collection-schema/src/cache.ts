import { revisionOf } from "@ovst/protocol";
import { compileCollectionSchemas, singleTable, type CollectionLayout, type CollectionSchema, type CollectionSchemaSet } from "./compile.ts";
import { compileLogicalSchema, type LogicalSchema } from "./logical.ts";

/**
 * A content-addressed, bounded cache of compiled schemas. Entries are keyed
 * by the SHA-256 of the exact source bytes, so an entry can never describe
 * other bytes. A failed compilation throws and is never cached.
 */
export class CollectionSchemaCache {
  private readonly entries = new Map<string, { weight: number }>();
  private weight = 0;

  /**
   * `maxWeight` bounds the summed weight of cached schemas (members plus
   * source size); a 1 MiB schema weighs about 16,000, so the default holds
   * many ordinary ones.
   */
  constructor(
    private readonly maxEntries = 64,
    private readonly maxWeight = 262_144,
  ) {}

  /** A single-table collection's schema. */
  compile(input: Uint8Array | string): CollectionSchema {
    return singleTable(this.compileTables(input));
  }

  /** Every table the schema stores in `layout`. */
  compileTables(input: Uint8Array | string, layout: CollectionLayout = "files"): CollectionSchemaSet {
    return this.cached(input, layout, (bytes) => compileCollectionSchemas(bytes, layout));
  }

  /** The models whose rows the tree holds (spec 06 §2.1). */
  compileLogical(input: Uint8Array | string): LogicalSchema {
    return this.cached(input, "logical", compileLogicalSchema);
  }

  private cached<T extends { weight: number }>(input: Uint8Array | string, kind: string, compile: (bytes: Uint8Array) => T): T {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const key = `${revisionOf(bytes)}:${kind}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached as T;
    }
    const schema = compile(bytes);
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
