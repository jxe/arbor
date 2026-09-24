import {MergeStateStore,type MergeStateRecord} from "./merge-state-store.ts";
import { ConflictStore, type ConflictState } from "./conflict-store.ts";
import type { MergeSummary } from "./reconcile.ts";
import { Database } from "bun:sqlite";
import {
  decodeTransitionPayloadJSON,
  encodeTransitionPayloadJSON,
  type AcceptedTransitionPayload,
  type AcceptedUpdate,
  type ObjectHash,
  type UpdateResult,
} from "@overstory/protocol";
import { SourceIntentStore, type SourceIntent } from "./source-intent-store.ts";
import { ObservationLog } from "./observations.ts";
import { EntryMetadataStore, type EntryChanges } from "./entry-metadata.ts";

export interface StoredAcceptedResponse {
  status: number;
  result: UpdateResult;
}

export interface AcceptedUpdateInput {
  tree: string;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
  conflicted?: boolean;
  kind: "initial" | "accepted" | "merged" | "restored";
  acceptedAt: number;
  subject?: string | null;
  /** Reconciliation provenance retained privately; never part of the wire `AcceptedUpdate`. */
  baseRoot?: ObjectHash;
  candidateRoot?: ObjectHash;
  remoteRoot?: ObjectHash;
  merge?: MergeSummary;
  requestDigest?: string;
  transition?: AcceptedTransitionPayload;
  change?: string;
  sourceIntent?: SourceIntent;
  conflicts?: ConflictState;
  mergeState?:MergeStateRecord;
  /** File entries this update wrote or removed (`entryChanges(previousRoot, root)`),
   * computed before the transaction because object reads are async. */
  entryChanges: EntryChanges;
}

interface AcceptedCommitInput extends AcceptedUpdateInput {
  expectedRoot: ObjectHash;
  expectedUpdate: string;
}

const UPDATE_COLUMNS = "id, tree_id, root, previous_root, previous_id, conflicted, accepted_at, subject";

export class AcceptedUpdateStore {
  private readonly observations: ObservationLog;

  constructor(private readonly db: Database) {
    this.observations = new ObservationLog(db);
  }

  static createSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS accepted_updates (
        id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL REFERENCES trees(id),
        root TEXT NOT NULL,
        previous_root TEXT,
        previous_id TEXT,
        conflicted INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        subject TEXT,
        base_root TEXT,
        candidate_root TEXT,
        remote_root TEXT,
        merge_summary TEXT,
        request_digest TEXT,
        transition_json TEXT,
        change_id TEXT
      )
    `);
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_request
      ON accepted_updates(tree_id, subject, request_digest)
      WHERE request_digest IS NOT NULL
    `);
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
    ObservationLog.createSchema(db);
    SourceIntentStore.createSchema(db);
    ConflictStore.createSchema(db);
    MergeStateStore.createSchema(db);
    EntryMetadataStore.createSchema(db);
  }

  private row(value: unknown): AcceptedUpdate | null {
    if (!value) return null;
    const record = value as {
      id: string;
      tree_id: string;
      root: ObjectHash;
      previous_root: ObjectHash | null;
      previous_id: string | null;
      conflicted: number;
      kind: "initial" | "accepted" | "merged" | "restored";
      accepted_at: number;
      subject: string | null;
      merge_summary: string | null;
    };
    return {
      id: record.id,
      tree: record.tree_id,
      root: record.root,
      previous: record.previous_id === null ? null : { id: record.previous_id, root: record.previous_root! },
      conflicted: Boolean(record.conflicted),
      acceptedAt: record.accepted_at,
      subject: record.subject,
    };
  }

  current(tree: string): AcceptedUpdate | null {
    return this.row(this.db.query(
      `SELECT ${UPDATE_COLUMNS} FROM accepted_updates WHERE tree_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(tree));
  }

  get(id: string): AcceptedUpdate | null {
    return this.row(this.db.query(`SELECT ${UPDATE_COLUMNS} FROM accepted_updates WHERE id = ?`).get(id));
  }

  list(tree: string): AcceptedUpdate[] {
    return (this.db.query(
      `SELECT ${UPDATE_COLUMNS} FROM accepted_updates WHERE tree_id = ? ORDER BY rowid`,
    ).all(tree) as unknown[]).map((row) => this.row(row)!);
  }

  /** Distinct roots of the tree's retained accepted updates, most recently accepted first. */
  roots(tree: string): ObjectHash[] {
    return (this.db.query(
      "SELECT root FROM accepted_updates WHERE tree_id = ? GROUP BY root ORDER BY MAX(rowid) DESC",
    ).all(tree) as Array<{ root: ObjectHash }>).map(({ root }) => root);
  }

  /** Whether this exact root belongs to any retained accepted update of the tree. */
  hasRoot(tree: string, root: ObjectHash): boolean {
    return this.db.query(
      "SELECT 1 FROM accepted_updates WHERE tree_id = ? AND root = ? LIMIT 1",
    ).get(tree, root) !== null;
  }

  acceptedRequest(tree: string, subject: string, digest: string): StoredAcceptedResponse | null {
    const accepted = this.row(this.db.query(`
      SELECT ${UPDATE_COLUMNS} FROM accepted_updates
      WHERE tree_id = ? AND subject = ? AND request_digest = ?
    `).get(tree, subject, digest));
    if (!accepted) return null;
    return {
      status: 201,
      result: {
        outcome: "accepted",
        update: accepted,
        requestDigest: digest as ObjectHash,
      },
    };
  }

  acceptedChange(tree: string, change: string): string | null {
    const row = this.db.query("SELECT id FROM accepted_updates WHERE tree_id = ? AND change_id = ?").get(tree, change) as { id: string } | null;
    return row?.id ?? null;
  }

  changeForAccepted(update: string): string | null {
    const row = this.db.query("SELECT change_id FROM accepted_updates WHERE id = ?").get(update) as { change_id: string | null } | null;
    return row?.change_id ?? null;
  }

  mergeSummary(update: string): MergeSummary | null {
    const row = this.db.query("SELECT merge_summary FROM accepted_updates WHERE id = ?").get(update) as { merge_summary: string | null } | null;
    return row?.merge_summary ? JSON.parse(row.merge_summary) : null;
  }

  /** Follow accepted identities, never root equality. Missing history is not evidence. */
  ancestry(basis: string, head: string, limit = 64): AcceptedUpdate[] | null {
    const chain: AcceptedUpdate[] = [];
    let current = this.get(head);
    const seen = new Set<string>();
    while (current && current.id !== basis) {
      if (chain.length >= limit || seen.has(current.id)) return null;
      seen.add(current.id);
      chain.push(current);
      const previous = current.previous ? this.get(current.previous.id) : null;
      if (!previous || previous.tree !== current.tree || previous.root !== current.previous!.root) return null;
      current = previous;
    }
    return current ? chain.reverse() : null;
  }

  matchingRequestDigest(update: string, subject: string): ObjectHash | null {
    const row = this.db.query(`
      SELECT request_digest FROM accepted_updates
      WHERE id = ? AND subject = ? AND request_digest IS NOT NULL
    `).get(update, subject) as { request_digest: ObjectHash } | null;
    return row?.request_digest ?? null;
  }

  transition(id: string): AcceptedTransitionPayload | null {
    const row = this.db.query("SELECT transition_json FROM accepted_updates WHERE id = ?").get(id) as { transition_json: string | null } | null;
    return row?.transition_json ? decodeTransitionPayloadJSON(JSON.parse(row.transition_json)) : null;
  }

  /** Record one accepted update and its `tree.update` observation atomically. */
  insert(input: AcceptedUpdateInput): AcceptedUpdate {
    return this.db.transaction(() => this.insertWithinTransaction(input))();
  }

  /** The accepted update's id is the ordinal of the `tree.update` observation that records it. */
  private insertWithinTransaction(input: AcceptedUpdateInput): AcceptedUpdate {
    const prior = this.current(input.tree);
    if (input.previousRoot !== (prior?.root ?? null)) throw new Error("Accepted predecessor does not match current state");
    const conflicts = new ConflictStore(this.db);
    const priorState = prior ? conflicts.get(prior.id) : null;
    if (!input.mergeState && !input.conflicts && priorState?.decisions.length && input.root !== prior!.root) throw new Error("Conflict attribution is required before changing the projection");
    const state = input.conflicts ?? (priorState ? { decisions: priorState.decisions, resolutions: [] } : null);
    const observation = this.observations.appendAccepted({ tree: input.tree, createdAt: input.acceptedAt });
    const id = observation.cursor;
    this.db.run(`
      INSERT INTO accepted_updates
        (id, tree_id, root, previous_root, previous_id, conflicted, kind, accepted_at, subject, base_root, candidate_root, remote_root, merge_summary, request_digest, transition_json, change_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      input.tree,
      input.root,
      input.previousRoot,
      prior?.id ?? null,
      (input.mergeState ? input.mergeState.decisions.length > 0 : state ? state.decisions.length > 0 : input.conflicted ?? prior?.conflicted ?? false) ? 1 : 0,
      input.kind,
      input.acceptedAt,
      input.subject ?? null,
      input.baseRoot ?? null,
      input.candidateRoot ?? null,
      input.remoteRoot ?? null,
      input.merge ? JSON.stringify(input.merge) : null,
      input.requestDigest ?? null,
      input.transition ? JSON.stringify(encodeTransitionPayloadJSON(input.transition)) : null,
      input.change ?? input.sourceIntent?.change ?? null,
    ]);
    this.observations.bindUpdate(id, id);
    new EntryMetadataStore(this.db).apply(input.tree, id, input.acceptedAt, input.entryChanges);
    if (state && !input.mergeState) conflicts.insert(id, state);
    if(input.mergeState)new MergeStateStore(this.db).insert(id,input.mergeState);
    if (input.sourceIntent) {
      if (!input.baseRoot || !input.candidateRoot) throw new Error("Source intent requires authored basis and candidate roots");
      new SourceIntentStore(this.db).insert({ ...input.sourceIntent, tree: input.tree,
        acceptedUpdate: id, basisRoot: input.baseRoot, candidateRoot: input.candidateRoot });
    }
    return this.get(id)!;
  }

  commit(input: AcceptedCommitInput, withinTransaction?: () => void): AcceptedUpdate | null {
    let accepted: AcceptedUpdate | null = null;
    this.db.transaction(() => {
      if (this.current(input.tree)?.id !== input.expectedUpdate) return;
      const result = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
        input.root,
        input.acceptedAt,
        input.tree,
        input.expectedRoot,
      ]);
      if (result.changes !== 1) return;
      this.db.run("INSERT INTO reflog (tree_id, ref, previous_ref, changed_at) VALUES (?, ?, ?, ?)", [
        input.tree,
        input.root,
        input.expectedRoot,
        input.acceptedAt,
      ]);
      withinTransaction?.();
      accepted = this.insertWithinTransaction(input);
    })();
    return accepted;
  }
}
