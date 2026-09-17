import { Database } from "bun:sqlite";
import type { ResolutionDeclaration, InspectedAlternative } from "@arbor/wire";

export type EntryValue = Exclude<InspectedAlternative["value"], { text: string }>;
export interface EntryAlternative { id: string; revision: string; value: EntryValue; contributions: InspectedAlternative["contributions"] }
export interface EntryDecision { id: string; name: string; parent?: string[]; selected: string; alternatives: EntryAlternative[] }
/** Missing parent is the historical root-entry encoding. */
export function decisionPath(decision: EntryDecision): string { return `/${[...(decision.parent ?? []), decision.name].join("/")}`; }
export interface ConflictState { decisions: EntryDecision[]; resolutions: ResolutionDeclaration[] }

/** Accepted-state snapshots of decisions. No cache or separate mutable head. */
export class ConflictStore {
  constructor(private readonly db: Database) {}
  static createSchema(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS accepted_conflicts (
      accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT,
      state_json TEXT NOT NULL
    )`);
  }
  get(accepted: string): ConflictState | null {
    const row = this.db.query("SELECT state_json FROM accepted_conflicts WHERE accepted_id = ?").get(accepted) as { state_json: string } | null;
    return row ? JSON.parse(row.state_json) : null;
  }
  insert(accepted: string, state: ConflictState): void {
    if (!this.db.inTransaction) throw new Error("Conflict state requires an accepted-update transaction");
    this.db.run("INSERT INTO accepted_conflicts VALUES (?, ?)", [accepted, JSON.stringify(state)]);
  }
  /** Object-retention roots with explicit kinds; file bytes are never sniffed as directories. */
  objectDependencies(): Array<{ kind: "file" | "directory"; hash: string }> {
    const objects = new Map<string, { kind: "file" | "directory"; hash: string }>();
    for (const { state } of this.all()) for (const decision of state.decisions) for (const { value } of decision.alternatives) {
      if ("file" in value) objects.set(`file:${value.file}`, { kind: "file", hash: value.file });
      if ("directory" in value) objects.set(`directory:${value.directory}`, { kind: "directory", hash: value.directory });
    }
    return [...objects.values()];
  }
  all(): Array<{ accepted: string; state: ConflictState }> {
    return (this.db.query("SELECT * FROM accepted_conflicts").all() as Array<{ accepted_id: string; state_json: string }>).map(row => ({ accepted: row.accepted_id, state: JSON.parse(row.state_json) }));
  }
}
