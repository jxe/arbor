import { Database } from "bun:sqlite";
import type { InspectedDecision, CandidateUpdate } from "@arbor/wire";
import type { IntentResponse } from "../../../merge/src/intent-model.ts";
export interface MergeStateRecord {
  state: string;
  authored: string;
  decisions: Array<{ key: string; inspection: InspectedDecision }>;
  /** Legacy rows contain a flattened closure. New rows retain graph roots. */
  dependencies?: string[];
  retention?: { version: 1; roots: string[] };
  evidence:
    | Extract<IntentResponse, { outcome: "evaluated" }>["evidence"]
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
    db.run(`CREATE TABLE accepted_merge_states (
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
  /** Audit one retained record at a time, bounded to the initial high-water mark. */
  *entries(): Generator<{accepted: string; record: MergeStateRecord}> {
    const last = this.db.query("SELECT MAX(rowid) AS n FROM accepted_merge_states").get() as {n: number | null};
    for (const row of this.db.query("SELECT accepted_id, record_json FROM accepted_merge_states WHERE rowid <= ? ORDER BY rowid").iterate(last.n ?? 0) as Iterable<{accepted_id: string; record_json: string}>) {
      yield {accepted: row.accepted_id, record: JSON.parse(row.record_json)};
    }
  }
  all(): Array<{ accepted: string; record: MergeStateRecord }> {
    return (
      this.db.query("SELECT * FROM accepted_merge_states").all() as Array<{
        accepted_id: string;
        record_json: string;
      }>
    ).map((r) => ({
      accepted: r.accepted_id,
      record: JSON.parse(r.record_json),
    }));
  }
}
