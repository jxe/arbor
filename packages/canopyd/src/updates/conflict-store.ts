import { Database } from "bun:sqlite";
import type { ResolutionDeclaration, InspectedAlternative, WireDirectoryEntry } from "@overstory/protocol";

export type EntryValue = Exclude<InspectedAlternative["value"], { text: string }>;
/** The value a legacy whole-entry alternative names for a directory entry. */
export function entryValue(entry?: WireDirectoryEntry): EntryValue {
  return entry?.file ? { file: entry.file } : entry?.directory ? { directory: entry.directory } : entry?.tree ? { tree: entry.tree } : { absent: true };
}
export interface EntryAlternative { id: string; revision: string; value: EntryValue; contributions: InspectedAlternative["contributions"] }
export type EntryDecision = { id: string; selected: string; alternatives: EntryAlternative[] } &
  ({ root: true; name?: never; parent?: never } | { root?: never; name: string; parent?: string[] });
/** Missing parent is the historical root-entry encoding. */
export function decisionPath(decision: EntryDecision): string { return decision.root ? "/" : `/${[...(decision.parent ?? []), decision.name].join("/")}`; }
/** Coupling is derivable from existing physical locations; no stored graph edge
 * or schema change is needed. Related decisions must be inspected together. */
export function decisionDependencies(decision: EntryDecision, decisions: EntryDecision[]): string[] {
  const path = decisionPath(decision);
  return decisions.filter(other => other.id !== decision.id &&
    (path === "/" || decisionPath(other) === "/" || decisionPath(other).startsWith(`${path}/`) || path.startsWith(`${decisionPath(other)}/`)))
    .map(other => other.id).sort();
}
export interface ConflictState { decisions: EntryDecision[]; resolutions: ResolutionDeclaration[] }

/** Whole-entry decisions of accepted updates written before every acceptance
 * recorded a merge state. Read-only: nothing writes these rows any more.
 * Legacy rows only; deleted by migration 016 (plans/canopyd/015). */
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
  /** Every retained state of one tree, found through its accepted updates' tree index. */
  forTree(tree: string): Array<{ accepted: string; state: ConflictState }> {
    return (this.db.query(`
      SELECT c.accepted_id, c.state_json FROM accepted_updates u JOIN accepted_conflicts c ON c.accepted_id = u.id
      WHERE u.tree_id = ? ORDER BY u.ordinal
    `).all(tree) as Array<{ accepted_id: string; state_json: string }>).map(row => ({ accepted: row.accepted_id, state: JSON.parse(row.state_json) }));
  }
}
