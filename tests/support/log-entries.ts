import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeLogEntry, type LogEntry } from "@overstory/merge-protocol";

/** Read one log entry from a data root's object store. */
export function readLogEntry(dataRoot: string, hash: string): LogEntry {
  return decodeLogEntry(new Uint8Array(readFileSync(join(dataRoot, "objects", hash.slice(7, 9), hash.slice(9)))));
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
