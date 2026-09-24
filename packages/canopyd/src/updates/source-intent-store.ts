import { Database } from "bun:sqlite";
import type { SourceTraceFrame } from "@overstory/protocol";
import type { SourceEditEvidence } from "./source-edits.ts";

interface StoredSourceIntent {
  change: string;
  /** The authored frame chain, exactly as the change carried it. */
  trace: SourceTraceFrame[];
  evidence: SourceEditEvidence[];
  tree: string;
  acceptedUpdate: string;
  basisRoot: string;
  candidateRoot: string;
}

/** Read-only access to retained authored intent. Nothing writes new rows; the
 * rows that exist still attribute past changes and pin their basis and
 * candidate roots. Never translates snapshot correspondence into asserted
 * operations. The tree, change identity, basis and candidate are the owning
 * accepted update's own columns; this table adds only the trace and its evidence.
 * Legacy rows only; deleted by migration 016 (plans/canopyd/015).
 */
export class SourceIntentStore {
  constructor(private readonly db: Database) {}

  static createSchema(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS authored_changes (
      accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT,
      trace_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    )`);
  }

  private one(where: string, ...values: string[]): StoredSourceIntent | null {
    const row = this.db.query(`
      SELECT u.tree_id, u.change_id, a.accepted_id, u.base_root, u.candidate_root, a.trace_json, a.evidence_json
      FROM authored_changes a JOIN accepted_updates u ON u.id = a.accepted_id
      WHERE ${where}
    `).get(...values) as {
      tree_id: string; change_id: string; accepted_id: string; base_root: string; candidate_root: string;
      trace_json: string; evidence_json: string;
    } | null;
    return row ? { tree: row.tree_id, change: row.change_id, acceptedUpdate: row.accepted_id,
      basisRoot: row.base_root, candidateRoot: row.candidate_root,
      trace: JSON.parse(row.trace_json), evidence: JSON.parse(row.evidence_json) } : null;
  }

  get(tree: string, change: string): StoredSourceIntent | null {
    return this.one("u.tree_id = ? AND u.change_id = ?", tree, change);
  }

  forAccepted(update: string): StoredSourceIntent | null {
    return this.one("a.accepted_id = ?", update);
  }

  /** Additional retention dependencies, including candidates never chosen as projections. */
  roots(): string[] {
    return (this.db.query(`
      SELECT u.base_root AS root FROM authored_changes a JOIN accepted_updates u ON u.id = a.accepted_id
      UNION SELECT u.candidate_root AS root FROM authored_changes a JOIN accepted_updates u ON u.id = a.accepted_id
    `).all() as { root: string }[]).map(row => row.root);
  }
}
