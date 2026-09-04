import type { Database } from "bun:sqlite";

/** One accepted update in a tree's ordered observation log. */
export interface ObservationRecord {
  ordinal: number;
  cursor: string;
  tree: string;
  updateID?: string;
}

export interface ObservationReplay {
  /** False when the cursor is not retained in this tree's log. */
  retained: boolean;
  /** Highest ordinal covered by this replay, including an empty one. */
  through: number;
  records: ObservationRecord[];
}

interface ObservationRow {
  ordinal: number;
  cursor: string;
  tree_id: string;
  update_id: string | null;
}

function toRecord(row: ObservationRow): ObservationRecord {
  return {
    ordinal: row.ordinal,
    cursor: row.cursor,
    tree: row.tree_id,
    ...(row.update_id ? { updateID: row.update_id } : {}),
  };
}

/** Append-only per-tree observation log; the sole source of cursor order. */
export class ObservationLog {
  constructor(private readonly db: Database) {}

  static createSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        cursor TEXT NOT NULL UNIQUE,
        tree_id TEXT NOT NULL REFERENCES trees(id),
        kind TEXT NOT NULL,
        update_id TEXT REFERENCES accepted_updates(id),
        change_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS observations_tree_order ON observations(tree_id, ordinal)");
  }

  /** Append one accepted-update observation and reserve its decimal cursor. */
  appendAccepted(input: { tree: string; createdAt: number }): ObservationRecord {
    const inserted = this.db.run(
      "INSERT INTO observations (cursor, tree_id, kind, update_id, change_json, created_at) VALUES ('', ?, ?, ?, ?, ?)",
      [input.tree, "tree.update", null, null, input.createdAt],
    );
    const cursor = String(inserted.lastInsertRowid);
    this.db.run("UPDATE observations SET cursor = ? WHERE ordinal = ?", [cursor, Number(inserted.lastInsertRowid)]);
    return this.get(cursor)!;
  }

  /** Bind an accepted update to the observation that recorded it. */
  bindUpdate(cursor: string, updateID: string): void {
    this.db.run("UPDATE observations SET update_id = ? WHERE cursor = ?", [updateID, cursor]);
  }

  get(cursor: string): ObservationRecord | null {
    const row = this.db.query("SELECT * FROM observations WHERE cursor = ?").get(cursor) as ObservationRow | null;
    return row ? toRecord(row) : null;
  }

  latestCursor(tree?: string): string | null {
    const row = (tree
      ? this.db.query("SELECT cursor FROM observations WHERE tree_id = ? AND update_id IS NOT NULL ORDER BY ordinal DESC LIMIT 1").get(tree)
      : this.db.query("SELECT cursor FROM observations WHERE update_id IS NOT NULL ORDER BY ordinal DESC LIMIT 1").get()) as { cursor: string } | null;
    return row?.cursor ?? null;
  }

  /**
   * Accepted updates strictly after `cursor` for one tree. A cursor belonging
   * to a legacy status observation remains a valid anchor, but those old rows
   * are never replayed.
   */
  after(tree: string, cursor: string | null): ObservationReplay {
    if (cursor === null) {
      const latest = this.db.query("SELECT MAX(ordinal) AS ordinal FROM observations WHERE tree_id = ? AND update_id IS NOT NULL").get(tree) as { ordinal: number | null };
      return { retained: true, through: latest.ordinal ?? 0, records: [] };
    }
    const anchor = this.db.query("SELECT ordinal FROM observations WHERE cursor = ? AND tree_id = ?").get(cursor, tree) as { ordinal: number } | null;
    if (!anchor) return { retained: false, through: 0, records: [] };
    const records = (this.db.query(
      "SELECT * FROM observations WHERE tree_id = ? AND ordinal > ? AND update_id IS NOT NULL ORDER BY ordinal",
    ).all(tree, anchor.ordinal) as ObservationRow[]).map(toRecord);
    return { retained: true, through: records.at(-1)?.ordinal ?? anchor.ordinal, records };
  }
}
