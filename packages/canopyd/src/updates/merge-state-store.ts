import { Database } from "bun:sqlite";
import type { InspectedDecision, CandidateUpdate } from "@overstory/protocol";
import type { IntentEvaluation } from "@overstory/merge-protocol";
import { updateOrdinal } from "./observations.ts";
/** One accepted update's merge state. `state` and `authored` are the retained
 * graph roots: the audit recomputes their closure, so no row stores one. */
export interface MergeStateRecord {
  state: string;
  authored: string;
  decisions: Array<{ key: string; inspection: InspectedDecision }>;
  evidence:
    | IntentEvaluation["evidence"]
    | null;
  /** The request as authored: the only stored copy of its candidate and trace. */
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
 accepted_id INTEGER PRIMARY KEY REFERENCES accepted_updates(ordinal) ON DELETE RESTRICT,
 record_json TEXT NOT NULL)`);
  }
  get(id: string): MergeStateRecord | null {
    const row = this.db
      .query(
        "SELECT record_json FROM accepted_merge_states WHERE accepted_id=?"
      )
      .get(updateOrdinal(id)) as { record_json: string } | null;
    return row ? JSON.parse(row.record_json) : null;
  }
  insert(id: string, record: MergeStateRecord) {
    if (!this.db.inTransaction)
      throw new Error("Merge state requires accepted transaction");
    this.db.run("INSERT INTO accepted_merge_states VALUES (?,?)", [
      updateOrdinal(id),
      JSON.stringify(record),
    ]);
  }
  /** Audit one retained record at a time, bounded to the initial high-water mark. */
  *entries(): Generator<{accepted: string; record: MergeStateRecord}> {
    const last = this.db.query("SELECT MAX(accepted_id) AS n FROM accepted_merge_states").get() as {n: number | null};
    for (const row of this.db.query("SELECT accepted_id, record_json FROM accepted_merge_states WHERE accepted_id <= ? ORDER BY accepted_id").iterate(last.n ?? 0) as Iterable<{accepted_id: number; record_json: string}>) {
      yield {accepted: String(row.accepted_id), record: JSON.parse(row.record_json)};
    }
  }

}
