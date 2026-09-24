import { Database } from "bun:sqlite";
import type { InspectedDecision, CandidateUpdate } from "@overstory/protocol";
import type { IntentEvaluation } from "@overstory/merge-protocol";
export interface MergeStateRecord {
  state: string;
  authored: string;
  decisions: Array<{ key: string; inspection: InspectedDecision }>;
  /** The retained graph roots: `state` and `authored`, deduplicated. The audit
   * recomputes the closure from them; no row stores a flattened closure. */
  retention: { version: 1; roots: string[] };
  evidence:
    | IntentEvaluation["evidence"]
    | null;
  request: Pick<
    CandidateUpdate,
    "change" | "candidate" | "trace" | "resolves"
  >;
}
/** An accepted row owns both its projection state and the original author's state. */
export class MergeStateStore {
  constructor(private readonly db: Database) {}
  static createSchema(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS accepted_merge_states (
 accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT,
 record_json TEXT NOT NULL)`);
  }
  get(id: string): MergeStateRecord | null {
    const row = this.db
      .query(
        "SELECT record_json FROM accepted_merge_states WHERE accepted_id=?"
      )
      .get(id) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) : null;
  }
  insert(id: string, record: MergeStateRecord) {
    if (!this.db.inTransaction)
      throw new Error("Merge state requires accepted transaction");
    this.db.run("INSERT INTO accepted_merge_states VALUES (?,?)", [
      id,
      JSON.stringify(record),
    ]);
  }
  /** Record the worker state of an update canopyd accepted without the
   * worker, once the worker has caught up with it. A concurrent catch-up of
   * the same update produced the same state; the first row stands. */
  insertCaughtUp(id: string, record: MergeStateRecord) {
    if (record.decisions.length) throw new Error("A fast-forwarded update has no decisions");
    this.db.run("INSERT OR IGNORE INTO accepted_merge_states VALUES (?,?)", [id, JSON.stringify(record)]);
  }
  /** Audit one retained record at a time, bounded to the initial high-water mark. */
  *entries(): Generator<{accepted: string; record: MergeStateRecord}> {
    const last = this.db.query("SELECT MAX(rowid) AS n FROM accepted_merge_states").get() as {n: number | null};
    for (const row of this.db.query("SELECT accepted_id, record_json FROM accepted_merge_states WHERE rowid <= ? ORDER BY rowid").iterate(last.n ?? 0) as Iterable<{accepted_id: string; record_json: string}>) {
      yield {accepted: row.accepted_id, record: JSON.parse(row.record_json)};
    }
  }

}
