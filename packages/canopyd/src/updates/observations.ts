import type { Database } from "bun:sqlite";

/** One accepted update at its position in a tree's observation order. */
export interface ObservationRecord {
  ordinal: number;
  cursor: string;
  tree: string;
  updateID: string;
}

interface ObservationRow {
  ordinal: number;
  tree_id: string;
  id: string;
}

const COLUMNS = "ordinal, tree_id, id";

function toRecord(row: ObservationRow): ObservationRecord {
  return { ordinal: row.ordinal, cursor: String(row.ordinal), tree: row.tree_id, updateID: row.id };
}

/** The ordinal a cursor names, or null for anything that is not a positive decimal ordinal. */
function ordinalOf(cursor: string): number | null {
  if (!/^[1-9][0-9]*$/.test(cursor)) return null;
  const ordinal = Number(cursor);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

/**
 * Cursor order over accepted updates, the sole source of watch order. An
 * accepted update's cursor is its decimal `accepted_updates.ordinal`, a
 * server-wide AUTOINCREMENT position that is never reused; the update's `id`
 * is its separate wire identity. A cursor that names no retained accepted
 * update of the tree is not retained.
 */
export class ObservationLog {
  constructor(private readonly db: Database) {}

  get(cursor: string): ObservationRecord | null {
    const ordinal = ordinalOf(cursor);
    if (ordinal === null) return null;
    const row = this.db.query(`SELECT ${COLUMNS} FROM accepted_updates WHERE ordinal = ?`).get(ordinal) as ObservationRow | null;
    return row ? toRecord(row) : null;
  }

  forUpdate(update: string): ObservationRecord | null {
    const row = this.db.query(`SELECT ${COLUMNS} FROM accepted_updates WHERE id = ?`).get(update) as ObservationRow | null;
    return row ? toRecord(row) : null;
  }

  latestCursor(tree?: string): string | null {
    const row = (tree
      ? this.db.query("SELECT MAX(ordinal) AS ordinal FROM accepted_updates WHERE tree_id = ?").get(tree)
      : this.db.query("SELECT MAX(ordinal) AS ordinal FROM accepted_updates").get()) as { ordinal: number | null };
    return row.ordinal === null ? null : String(row.ordinal);
  }

  /** Starting position only; the durable history is the watch's backlog queue. */
  position(tree: string, cursor: string | null): { retained: boolean; through: number } {
    if (cursor === null) {
      const row = this.db.query("SELECT MAX(ordinal) AS ordinal FROM accepted_updates WHERE tree_id = ?").get(tree) as { ordinal: number | null };
      return { retained: true, through: row.ordinal ?? 0 };
    }
    const record = this.get(cursor);
    return record?.tree === tree ? { retained: true, through: record.ordinal } : { retained: false, through: 0 };
  }

  /** Accepted state at an observation boundary. */
  atOrBefore(tree: string, through: number): ObservationRecord | null {
    const row = this.db.query(`SELECT ${COLUMNS} FROM accepted_updates WHERE tree_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1`)
      .get(tree, through) as ObservationRow | null;
    return row ? toRecord(row) : null;
  }

  page(tree: string, after: number, limit = 64): ObservationRecord[] {
    return (this.db.query(`SELECT ${COLUMNS} FROM accepted_updates WHERE tree_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`)
      .all(tree, after, limit) as ObservationRow[]).map(toRecord);
  }
}
