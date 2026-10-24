import { compileLogicalSchema, encodeCollection, loadDirectoryCollection } from "@ovst/collection-schema";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type LogicalRow, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";
import type { LogicalTables } from "@ovst/usl";

export interface CollectionTree {
  root: ObjectHash;
  /** The collection directory at `/items`. */
  collection: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
}

/** The time test rows are stamped with unless they say otherwise. */
export const T0 = "2026-10-24T09:00:00.000Z";

/** A logical row keyed by `id`. */
export function idRow(id: string, fields: LogicalRow["fields"] = {}, created = T0, modified = created): LogicalRow {
  return { key: [["id", id]], fields, created, modified };
}

/** A collection directory holding `schema.usl` and `tables`, with its objects added to `objects`. */
export function collectionDirectory(schemaSource: string, tables: LogicalTables, objects: Map<ObjectHash, Uint8Array>, extra: ProtocolDirectoryEntry[] = []): ObjectHash {
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const schemaBytes = new TextEncoder().encode(schemaSource);
  const encoded = encodeCollection(compileLogicalSchema(schemaBytes), tables);
  for (const bytes of encoded.objects.values()) put(bytes);
  const entries = [{ name: "schema.usl", file: put(schemaBytes) }, ...extra].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(encodeProtocolDirectory({ type: "directory", entries, collection: encoded.reference }));
}

/** A tree holding one collection folder, `/items`, beside a page. */
export function collectionTree(schemaSource: string, tables: LogicalTables, objects = new Map<ObjectHash, Uint8Array>()): CollectionTree {
  const collection = collectionDirectory(schemaSource, tables, objects);
  const page = new TextEncoder().encode("# Notes\n");
  objects.set(hashObject(page), page);
  const root = encodeProtocolDirectory({ type: "directory", entries: [{ name: "items", directory: collection }, { name: "notes.md", file: hashObject(page) }] });
  objects.set(hashObject(root), root);
  return { root: hashObject(root), collection, objects };
}

/** The rows of `/items` in `root`. */
export async function collectionRows(root: ObjectHash, objects: ReadonlyMap<ObjectHash, Uint8Array>, folder = "items"): Promise<LogicalTables> {
  const load = async (hash: ObjectHash) => objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
  const top = decodeProtocolDirectory(objects.get(root)!);
  const items = decodeProtocolDirectory(objects.get(top.entries.find((e) => e.name === folder)!.directory!)!);
  return (await loadDirectoryCollection(items, load))!.tables;
}
