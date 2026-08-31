import { Database } from "bun:sqlite";
import {
  decodeTransitionPayloadJSON,
  encodeTransitionPayloadJSON,
  type AcceptedTransitionPayload,
  type AcceptedUpdate,
  type MergeSummary,
  type ObjectHash,
  type UpdateResult,
} from "@arbor/wire";

export interface StoredAcceptedResponse {
  status: number;
  result: UpdateResult;
}

export interface AcceptedUpdateInput {
  tree: string;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
  kind: AcceptedUpdate["kind"];
  acceptedAt: number;
  subject?: string | null;
  baseRoot?: ObjectHash;
  candidateRoot?: ObjectHash;
  remoteRoot?: ObjectHash;
  merge?: MergeSummary;
  requestDigest?: string;
  transition?: AcceptedTransitionPayload;
}

export interface AcceptedCommitInput extends AcceptedUpdateInput {
  expectedRoot: ObjectHash;
}

export class AcceptedUpdateStore {
  constructor(private readonly db: Database) {}

  static createSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS accepted_updates (
        id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL REFERENCES trees(id),
        sequence INTEGER NOT NULL,
        root TEXT NOT NULL,
        previous_root TEXT,
        kind TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        subject TEXT,
        base_root TEXT,
        candidate_root TEXT,
        remote_root TEXT,
        merge_summary TEXT,
        request_digest TEXT,
        transition_json TEXT
      )
    `);
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_tree_order ON accepted_updates(tree_id, sequence)");
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_request
      ON accepted_updates(tree_id, subject, request_digest)
      WHERE request_digest IS NOT NULL
    `);
  }

  private row(value: unknown): AcceptedUpdate | null {
    if (!value) return null;
    const record = value as {
      id: string;
      tree_id: string;
      sequence: number;
      root: ObjectHash;
      previous_root: ObjectHash | null;
      kind: AcceptedUpdate["kind"];
      accepted_at: number;
      subject: string | null;
      base_root: ObjectHash | null;
      candidate_root: ObjectHash | null;
      remote_root: ObjectHash | null;
      merge_summary: string | null;
    };
    return {
      id: record.id,
      tree: record.tree_id,
      sequence: record.sequence,
      root: record.root,
      previousRoot: record.previous_root,
      kind: record.kind,
      acceptedAt: record.accepted_at,
      subject: record.subject,
      ...(record.base_root ? { baseRoot: record.base_root } : {}),
      ...(record.candidate_root ? { candidateRoot: record.candidate_root } : {}),
      ...(record.remote_root ? { remoteRoot: record.remote_root } : {}),
      ...(record.merge_summary ? { merge: JSON.parse(record.merge_summary) as MergeSummary } : {}),
    };
  }

  current(tree: string): AcceptedUpdate | null {
    return this.row(this.db.query(
      "SELECT * FROM accepted_updates WHERE tree_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(tree));
  }

  get(id: string): AcceptedUpdate | null {
    return this.row(this.db.query("SELECT * FROM accepted_updates WHERE id = ?").get(id));
  }

  list(tree: string): AcceptedUpdate[] {
    return (this.db.query(
      "SELECT * FROM accepted_updates WHERE tree_id = ? ORDER BY sequence",
    ).all(tree) as unknown[]).map((row) => this.row(row)!);
  }

  acceptedRequest(tree: string, subject: string, digest: string): StoredAcceptedResponse | null {
    const accepted = this.row(this.db.query(`
      SELECT * FROM accepted_updates
      WHERE tree_id = ? AND subject = ? AND request_digest = ?
    `).get(tree, subject, digest));
    if (!accepted) return null;
    if (accepted.kind === "merged" && accepted.merge) {
      return { status: 201, result: { outcome: "merged", update: accepted, merge: accepted.merge, requestDigest: digest as ObjectHash, observedThrough: accepted.id } };
    }
    return { status: 201, result: { outcome: "accepted", update: accepted, requestDigest: digest as ObjectHash, observedThrough: accepted.id } };
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

  insert(id: string, input: AcceptedUpdateInput): AcceptedUpdate {
    const sequence = (this.db.query(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM accepted_updates WHERE tree_id = ?",
    ).get(input.tree) as { sequence: number }).sequence;
    this.db.run(`
      INSERT INTO accepted_updates
        (id, tree_id, sequence, root, previous_root, kind, accepted_at, subject, base_root, candidate_root, remote_root, merge_summary, request_digest, transition_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      input.tree,
      sequence,
      input.root,
      input.previousRoot,
      input.kind,
      input.acceptedAt,
      input.subject ?? null,
      input.baseRoot ?? null,
      input.candidateRoot ?? null,
      input.remoteRoot ?? null,
      input.merge ? JSON.stringify(input.merge) : null,
      input.requestDigest ?? null,
      input.transition ? JSON.stringify(encodeTransitionPayloadJSON(input.transition)) : null,
    ]);
    return this.get(id)!;
  }

  commit(id: string, input: AcceptedCommitInput, withinTransaction?: () => void): AcceptedUpdate | null {
    let accepted: AcceptedUpdate | null = null;
    this.db.transaction(() => {
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
      accepted = this.insert(id, input);
    })();
    return accepted;
  }
}
