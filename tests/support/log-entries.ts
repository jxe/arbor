import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { decodeLogEntry, type LogEntry } from "@overstory/merge-protocol";
import { Encoding, PACK_INDEX } from "@overstory/object-store";

/** Read one log entry from a data root's object store, loose or packed. */
export function readLogEntry(dataRoot: string, hash: string): LogEntry {
  return decodeLogEntry(readObjectSync(join(dataRoot, "objects"), hash));
}

/** An object's bytes, loose or packed (canopyd 001), read synchronously. */
function readObjectSync(objects: string, hash: string): Uint8Array {
  const loose = join(objects, hash.slice(7, 9), hash.slice(9));
  if (existsSync(loose)) return new Uint8Array(readFileSync(loose));
  const index = join(objects, "packs", PACK_INDEX);
  if (!existsSync(index)) throw new Error(`Object is not stored: ${hash}`);
  const db = new Database(index, { readonly: true });
  try {
    const row = db.query("SELECT p.name, o.offset, o.length, o.encoding, o.start, o.size FROM packed_objects o JOIN packs p ON p.id = o.pack WHERE o.hash = ?")
      .get(Buffer.from(hash.slice(7), "hex")) as { name: string; offset: number; length: number; encoding: Encoding; start: number; size: number } | null;
    if (!row) throw new Error(`Object is not stored: ${hash}`);
    const record = readFileSync(join(objects, "packs", row.name)).subarray(row.offset, row.offset + row.length);
    if (row.encoding === Encoding.Raw) return new Uint8Array(record);
    if (row.encoding === Encoding.Zstd) return new Uint8Array(zstdDecompressSync(record));
    return new Uint8Array(zstdDecompressSync(record)).slice(row.start, row.start + row.size);
  } finally {
    db.close();
  }
}

/** Each accepted update of a tree with the log entry it recorded, in order. */
export function acceptedEntries(dataRoot: string, tree?: string): Array<{ id: string; change: string | null; hash: string; entry: LogEntry }> {
  const db = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
  try {
    const rows = db.query(`SELECT ordinal, change_id, entry FROM accepted_updates ${tree ? "WHERE tree_id = ?" : ""} ORDER BY ordinal`)
      .all(...(tree ? [tree] : [])) as Array<{ ordinal: number; change_id: string | null; entry: string }>;
    return rows.map((row) => ({ id: String(row.ordinal), change: row.change_id, hash: row.entry, entry: readLogEntry(dataRoot, row.entry) }));
  } finally {
    db.close();
  }
}
