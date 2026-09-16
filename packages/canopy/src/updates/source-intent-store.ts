import { ConflictStore } from "./conflict-store.ts";
import { Database } from "bun:sqlite";
import { validateUpdateRequestIntent, type SourceOperation } from "@arbor/wire";
import type { SourceEditEvidence } from "./source-edits.ts";

export interface SourceIntent {
  change: string;
  operations: SourceOperation[];
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
 */
export class SourceIntentStore {
  constructor(private readonly db: Database) {}

  static createSchema(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS authored_changes (
      tree_id TEXT NOT NULL REFERENCES trees(id),
      change_id TEXT NOT NULL,
      accepted_id TEXT NOT NULL UNIQUE REFERENCES accepted_updates(id) ON DELETE RESTRICT,
      basis_root TEXT NOT NULL,
      candidate_root TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY (tree_id, change_id)
    )`);
  }

  /** Called only after insertion of the owning accepted record, in its transaction.
   * Evidence must come from the source executor; this checks structural binding,
   * not source reachability or byte correspondence (those need object reads).
   */
  insert(record: StoredSourceIntent): void {
    if (!this.db.inTransaction) throw new Error("Source intent requires an accepted-update transaction");
    const owner = this.db.query("SELECT tree_id, base_root, candidate_root, request_digest, change_id FROM accepted_updates WHERE id = ?")
      .get(record.acceptedUpdate) as { tree_id: string; base_root: string; candidate_root: string; request_digest: string | null; change_id: string | null } | null;
    if (!owner || owner.tree_id !== record.tree || owner.change_id !== record.change || owner.base_root !== record.basisRoot || owner.candidate_root !== record.candidateRoot || !owner.request_digest) {
      throw new Error("Source intent does not match its accepted update");
    }
    validateUpdateRequestIntent({ base: record.acceptedUpdate, updates: [{
      change: record.change, candidate: record.candidateRoot, operations: record.operations,
      resolves: new ConflictStore(this.db).get(record.acceptedUpdate)?.resolutions ?? [], objects: [], deltas: [],
    }] });
    if (record.evidence.length !== record.operations.length || record.operations.some((operation, index) =>
      operation.kind !== "editSource" || record.evidence[index]?.operation !== operation.key || record.evidence[index]?.text !== operation.text)) {
      throw new Error("Source evidence does not match authored operations");
    }
    // Deliberately no upsert. Reusing a change identity must never replace its
    // old intent; exact retries use the retained accepted request receipt.
    this.db.run(`INSERT INTO authored_changes
      (tree_id, change_id, accepted_id, basis_root, candidate_root, operations_json, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [record.tree, record.change, record.acceptedUpdate,
      record.basisRoot, record.candidateRoot, JSON.stringify(record.operations), JSON.stringify(record.evidence)]);
  }

  get(tree: string, change: string): StoredSourceIntent | null {
    const row = this.db.query("SELECT * FROM authored_changes WHERE tree_id = ? AND change_id = ?").get(tree, change) as {
      tree_id: string; change_id: string; accepted_id: string; basis_root: string; candidate_root: string;
      operations_json: string; evidence_json: string;
    } | null;
    return row ? { tree: row.tree_id, change: row.change_id, acceptedUpdate: row.accepted_id,
      basisRoot: row.basis_root, candidateRoot: row.candidate_root,
      operations: JSON.parse(row.operations_json), evidence: JSON.parse(row.evidence_json) } : null;
  }

  forAccepted(update: string): StoredSourceIntent | null {
    const row = this.db.query("SELECT tree_id, change_id FROM authored_changes WHERE accepted_id = ?").get(update) as { tree_id: string; change_id: string } | null;
    return row ? this.get(row.tree_id, row.change_id) : null;
  }

  /** Additional retention dependencies, including candidates never chosen as projections. */
  roots(): string[] {
    return (this.db.query("SELECT basis_root AS root FROM authored_changes UNION SELECT candidate_root AS root FROM authored_changes").all() as { root: string }[]).map(row => row.root);
  }
}
