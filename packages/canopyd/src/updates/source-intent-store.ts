import { ConflictStore } from "./conflict-store.ts";
import { Database } from "bun:sqlite";
import { validateUpdateRequestIntent, type SourceTraceFrame } from "@overstory/protocol";
import type { SourceEditEvidence } from "./source-edits.ts";

export interface SourceIntent {
  change: string;
  /** The authored frame chain, exactly as the change carried it. */
  trace: SourceTraceFrame[];
  evidence: SourceEditEvidence[];
}
export interface StoredSourceIntent extends SourceIntent {
  tree: string;
  acceptedUpdate: string;
  basisRoot: string;
  candidateRoot: string;
}

/** Private retention of authored intent. Never translates snapshot correspondence
 * into asserted operations. AcceptedUpdateStore owns the enclosing transaction.
 * The tree, change identity, basis and candidate are the owning accepted
 * update's own columns; this table adds only the trace and its evidence.
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

  /** Called only after insertion of the owning accepted record, in its transaction.
   * Evidence must come from the source executor; this checks structural binding,
   * not source reachability or byte correspondence (those need object reads).
   */
  insert(record: SourceIntent & { acceptedUpdate: string }): void {
    if (!this.db.inTransaction) throw new Error("Source intent requires an accepted-update transaction");
    const owner = this.db.query("SELECT base_root, candidate_root, request_digest, change_id FROM accepted_updates WHERE id = ?")
      .get(record.acceptedUpdate) as { base_root: string | null; candidate_root: string | null; request_digest: string | null; change_id: string | null } | null;
    if (!owner || owner.change_id !== record.change || !owner.base_root || !owner.candidate_root || !owner.request_digest) {
      throw new Error("Source intent does not match its accepted update");
    }
    validateUpdateRequestIntent({ base: record.acceptedUpdate, updates: [{
      change: record.change, candidate: owner.candidate_root, trace: record.trace,
      resolves: new ConflictStore(this.db).get(record.acceptedUpdate)?.resolutions ?? [], objects: [], deltas: [],
    }] });
    // The wire proves the chain is internally consistent and ends at the
    // candidate; only the store knows the basis the chain must start from.
    if (record.trace.length && record.trace[0]!.before !== owner.base_root) {
      throw new Error("Source trace does not start at the recorded basis");
    }
    const operations = record.trace.flatMap((frame) => frame.operations);
    if (record.evidence.length !== operations.length || operations.some((operation, index) =>
      operation.kind !== "editSource" || record.evidence[index]?.operation !== operation.key || record.evidence[index]?.text !== operation.text)) {
      throw new Error("Source evidence does not match authored operations");
    }
    // Deliberately no upsert. Reusing a change identity must never replace its
    // old intent; exact retries use the retained accepted request receipt.
    this.db.run("INSERT INTO authored_changes (accepted_id, trace_json, evidence_json) VALUES (?, ?, ?)",
      [record.acceptedUpdate, JSON.stringify(record.trace), JSON.stringify(record.evidence)]);
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
