import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareUTF8, type CollectionTablesDescriptor } from "@ovst/protocol";
import { collectionFileRows, type CollectionSchemaCache } from "@ovst/collection-schema";

const FORMATS = ["csv", "json", "jsonl"] as const;

/**
 * The descriptor of a folder that stores its schema's tables one file each,
 * `<Table>.csv`, `.json` or `.jsonl` (spec 06 §2.4), or null when it is not
 * one: every table needs a file, all in one format, and every row must
 * validate.
 */
export async function describeCollectionTables(
  directory: string,
  fileNames: readonly string[],
  schemas: CollectionSchemaCache,
): Promise<CollectionTablesDescriptor | null> {
  try {
    const set = schemas.compileTables(new Uint8Array(await readFile(join(directory, "schema.usl"))));
    const format = FORMATS.find((f) => fileNames.includes(`${set.tables[0]!.model}.${f}`));
    if (!format) return null;
    const tables = [];
    for (const schema of [...set.tables].sort((a, b) => compareUTF8(a.model, b.model))) {
      const source = `${schema.model}.${format}`;
      if (!fileNames.includes(source)) return null;
      const { childSetHash } = collectionFileRows(format, new Uint8Array(await readFile(join(directory, source))), schema);
      tables.push({ table: schema.model, source, childSetHash });
    }
    return { version: 1, type: "collection-tables", format, schemaSource: "schema.usl", schemaFingerprint: set.revision, tables };
  } catch {
    return null;
  }
}
