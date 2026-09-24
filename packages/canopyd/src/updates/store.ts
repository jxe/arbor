import { MergeStateStore, type MergeStateRecord } from "./merge-state-store.ts";
import { Database } from "bun:sqlite";
import type { AcceptedUpdate, ObjectHash, UpdateResult } from "@overstory/protocol";
import { EntryMetadataStore, type EntryChanges } from "./entry-metadata.ts";
import { updateOrdinal } from "./observations.ts";
export { updateOrdinal } from "./observations.ts";

export interface StoredAcceptedResponse {
  status: number;
  result: UpdateResult;
}

export interface AcceptedUpdateInput {
  tree: string;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
  acceptedAt: number;
  subject?: string | null;
  requestDigest?: string;
  change?: string;
  /** Every accepted update records its merge state; its decisions are the
   * update's open conflicts. */
  mergeState: MergeStateRecord;
  /** File entries this update wrote or removed (`entryChanges(previousRoot, root)`),
   * computed before the transaction because object reads are async. */
  entryChanges: EntryChanges;
}

interface AcceptedCommitInput extends AcceptedUpdateInput {
  expectedUpdate: string;
}

const UPDATE_SELECT = `
  SELECT u.ordinal, u.tree_id, u.root, u.previous_ordinal, p.root AS previous_root, u.conflicted, u.accepted_at, u.subject
  FROM accepted_updates u LEFT JOIN accepted_updates p ON p.ordinal = u.previous_ordinal`;

/**
 * Each tree's accepted history. `ordinal` is the row's server-wide position,
 * its wire id (`String(ordinal)`) and its observation cursor (see
 * `ObservationLog`). `trees.ref` is the materialized head, moved only together
 * with a new row here. `previous_ordinal` names the predecessor, whose root is
 * read by joining it; a tree's first retained update has none (migration 016
 * kept only each tree's head).
 */
export class AcceptedUpdateStore {
  constructor(private readonly db: Database) {}

  /** The table alone, under another name while an offline migration rebuilds it. */
  static createTable(db: Database, name = "accepted_updates"): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS ${name} (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id TEXT NOT NULL REFERENCES trees(id),
        root TEXT NOT NULL,
        previous_ordinal INTEGER REFERENCES accepted_updates(ordinal),
        conflicted INTEGER NOT NULL DEFAULT 0,
        accepted_at INTEGER NOT NULL,
        subject TEXT,
        request_digest TEXT,
        change_id TEXT
      )
    `);
  }

  static createSchema(db: Database): void {
    AcceptedUpdateStore.createTable(db);
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_request
      ON accepted_updates(tree_id, subject, request_digest)
      WHERE request_digest IS NOT NULL
    `);
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
    // `ordinal` is the rowid, so the tree index alone serves `(tree_id, ordinal)` order.
    db.run("CREATE INDEX IF NOT EXISTS accepted_updates_tree ON accepted_updates(tree_id)");
    db.run("CREATE INDEX IF NOT EXISTS accepted_updates_root ON accepted_updates(tree_id, root)");
    MergeStateStore.createSchema(db);
    EntryMetadataStore.createSchema(db);
  }

  private row(value: unknown): AcceptedUpdate | null {
    if (!value) return null;
    const record = value as {
      ordinal: number;
      tree_id: string;
      root: ObjectHash;
      previous_ordinal: number | null;
      previous_root: ObjectHash | null;
      conflicted: number;
      accepted_at: number;
      subject: string | null;
    };
    return {
      id: String(record.ordinal),
      tree: record.tree_id,
      root: record.root,
      previous: record.previous_ordinal === null ? null : { id: String(record.previous_ordinal), root: record.previous_root! },
      conflicted: Boolean(record.conflicted),
      acceptedAt: record.accepted_at,
      subject: record.subject,
    };
  }

  current(tree: string): AcceptedUpdate | null {
    return this.row(this.db.query(`${UPDATE_SELECT} WHERE u.tree_id = ? ORDER BY u.ordinal DESC LIMIT 1`).get(tree));
  }

  get(id: string): AcceptedUpdate | null {
    const ordinal = updateOrdinal(id);
    return ordinal === null ? null : this.row(this.db.query(`${UPDATE_SELECT} WHERE u.ordinal = ?`).get(ordinal));
  }

  list(tree: string): AcceptedUpdate[] {
    return (this.db.query(`${UPDATE_SELECT} WHERE u.tree_id = ? ORDER BY u.ordinal`).all(tree) as unknown[])
      .map((row) => this.row(row)!);
  }

  /** Whether this exact root belongs to any retained accepted update of the tree. */
  hasRoot(tree: string, root: ObjectHash): boolean {
    return this.db.query(
      "SELECT 1 FROM accepted_updates WHERE tree_id = ? AND root = ? LIMIT 1",
    ).get(tree, root) !== null;
  }

  acceptedRequest(tree: string, subject: string, digest: string): StoredAcceptedResponse | null {
    const accepted = this.row(this.db.query(`${UPDATE_SELECT}
      WHERE u.tree_id = ? AND u.subject = ? AND u.request_digest = ?
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
    const row = this.db.query("SELECT ordinal FROM accepted_updates WHERE tree_id = ? AND change_id = ?").get(tree, change) as { ordinal: number } | null;
    return row ? String(row.ordinal) : null;
  }

  changeForAccepted(update: string): string | null {
    const row = this.db.query("SELECT change_id FROM accepted_updates WHERE ordinal = ?").get(updateOrdinal(update)) as { change_id: string | null } | null;
    return row?.change_id ?? null;
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
      if (!previous || previous.tree !== current.tree) return null;
      current = previous;
    }
    return current ? chain.reverse() : null;
  }

  matchingRequestDigest(update: string, subject: string): ObjectHash | null {
    const row = this.db.query(`
      SELECT request_digest FROM accepted_updates
      WHERE ordinal = ? AND subject = ? AND request_digest IS NOT NULL
    `).get(updateOrdinal(update), subject) as { request_digest: ObjectHash } | null;
    return row?.request_digest ?? null;
  }

  /** Record an accepted update without moving `trees.ref`: a tree's first update, whose `trees` row the caller inserted at this root. */
  insert(input: AcceptedUpdateInput): AcceptedUpdate {
    return this.db.transaction(() => this.insertWithinTransaction(input))();
  }

  /** The accepted update's id is the decimal ordinal its row takes; AUTOINCREMENT never reuses one. */
  private insertWithinTransaction(input: AcceptedUpdateInput): AcceptedUpdate {
    const prior = this.current(input.tree);
    if (input.previousRoot !== (prior?.root ?? null)) throw new Error("Accepted predecessor does not match current state");
    const inserted = this.db.run(`
      INSERT INTO accepted_updates (tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.tree,
      input.root,
      prior ? Number(prior.id) : null,
      input.mergeState.decisions.length > 0 ? 1 : 0,
      input.acceptedAt,
      input.subject ?? null,
      input.requestDigest ?? null,
      input.change ?? null,
    ]);
    const id = String(inserted.lastInsertRowid);
    new EntryMetadataStore(this.db).apply(input.tree, id, input.acceptedAt, input.entryChanges);
    new MergeStateStore(this.db).insert(id, input.mergeState);
    return this.get(id)!;
  }

  /**
   * Move the tree's ref from `previousRoot` to `root` and record the accepted
   * update, inside the caller's transaction. Null when the ref has moved.
   */
  advance(input: AcceptedUpdateInput): AcceptedUpdate | null {
    if (!this.db.inTransaction) throw new Error("Advancing a ref requires a transaction");
    const moved = this.db.run("UPDATE trees SET ref = ?, updated_at = ? WHERE id = ? AND ref = ?", [
      input.root,
      input.acceptedAt,
      input.tree,
      input.previousRoot,
    ]);
    return moved.changes === 1 ? this.insertWithinTransaction(input) : null;
  }

  /** Advance only if `expectedUpdate` is still the tree's current accepted update. */
  commit(input: AcceptedCommitInput, withinTransaction?: () => void): AcceptedUpdate | null {
    return this.db.transaction(() => {
      const current = this.current(input.tree);
      if (current?.id !== input.expectedUpdate || current.root !== input.previousRoot) return null;
      withinTransaction?.();
      const accepted = this.advance(input);
      // The ref is the current row's root; disagreement is corruption, not a race.
      if (!accepted) throw new Error("Tree ref does not match its current accepted update");
      return accepted;
    })();
  }
}
