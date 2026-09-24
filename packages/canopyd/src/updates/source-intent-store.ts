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

/** Retained authored intent: the frames and evidence of a traced edit that
 * canopyd verified and accepted itself, without the merge worker (older rows
 * came from an earlier host-side executor). They attribute past changes, pin
 * their basis and candidate roots, and let the worker's state replay the edit.
 * Never translates snapshot correspondence into asserted operations. The tree,
 * change identity, basis and candidate are the owning accepted update's own
 * columns; this table adds only the trace and its evidence.
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

  /** Inside the accepted transaction that owns the row. */
  insert(accepted: string, trace: SourceTraceFrame[], evidence: SourceEditEvidence[]): void {
    if (!this.db.inTransaction) throw new Error("Authored intent requires accepted transaction");
    this.db.run("INSERT INTO authored_changes (accepted_id, trace_json, evidence_json) VALUES (?, ?, ?)", [
      accepted, JSON.stringify(trace), JSON.stringify(evidence),
    ]);
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
