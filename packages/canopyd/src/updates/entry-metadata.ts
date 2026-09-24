import { Database } from "bun:sqlite";
import type { ObjectHash } from "@overstory/protocol";
import { treeReader, walkTreeDiff, type Load, type TreeReader } from "./tree-diff.ts";

/**
 * Descriptive metadata of a tree's file entries, kept beside the hashes and
 * never inside them (canopyd 013), plus the document-version index that
 * canopyd 007's history routes read. Both are filled from one walk over
 * consecutive accepted roots, inside the accepted update's transaction.
 */

/** One file entry the accepted update wrote. Markdown entries carry their
 * document identity for the version index. */
interface EntryChange {
  path: string;
  hash: ObjectHash;
  document?: { key: string };
}

export interface EntryChanges {
  set: EntryChange[];
  removed: string[];
}

const decoder = new TextDecoder();

/** `id:<PageID>` when the frontmatter names exactly one `id:`, the same rule as
 * the native `WorkingTreeSemantics.pageID(in:)`; otherwise `path:<entry path>`. */
export function documentKey(path: string, source: string): string {
  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  if (source.startsWith(`---${newline}`)) {
    const start = 3 + newline.length, closing = source.indexOf(`${newline}---`, start);
    if (closing >= 0) {
      const values: string[] = [];
      for (const match of source.slice(start, closing).matchAll(/^id:[ \t]*(.*?)[ \t]*\r?$/gm)) {
        let value = match[1]!.trim();
        if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))))
          value = value.slice(1, -1);
        if (value) values.push(value);
      }
      if (values.length === 1) return `id:${values[0]}`;
    }
  }
  return `path:${path}`;
}

/**
 * The file entries that differ between two accepted roots: every file whose
 * object is new or changed (a move is a change at its new path), and every
 * file path that is gone. Nested tree boundaries belong to their own tree and
 * are skipped. `before` is null for a tree's first update.
 */
export async function entryChanges(
  before: ObjectHash | null,
  after: ObjectHash,
  load: Load | TreeReader,
): Promise<EntryChanges> {
  const reader = treeReader(load);
  const changes: EntryChanges = { set: [], removed: [] };
  await walkTreeDiff(before, after, reader, {
    entry: async ({ path, before: old, after: next }) => {
      if (old?.file && old.file === next?.file) return false;
      if (old?.file) changes.removed.push(path);
      if (next?.file) {
        const change: EntryChange = { path, hash: next.file };
        if (path.endsWith(".md")) change.document = { key: documentKey(path, decoder.decode(await reader.bytes(next.file))) };
        changes.set.push(change);
      }
      // An added or removed directory contributes every file beneath it.
      return true;
    },
  });
  // A path both removed and set (a file replaced in place) is only set.
  const written = new Set(changes.set.map((c) => c.path));
  changes.removed = changes.removed.filter((path) => !written.has(path));
  return changes;
}

interface DocumentVersion {
  stableKey: string;
  update: string;
  entryPath: string;
  contentHash: ObjectHash;
  acceptedAt: number;
}

export class EntryMetadataStore {
  constructor(private readonly db: Database) {}

  static createSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS entry_metadata (
        tree_id TEXT NOT NULL REFERENCES trees(id),
        path TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        update_id TEXT NOT NULL,
        data_json TEXT,
        PRIMARY KEY (tree_id, path)
      ) WITHOUT ROWID
    `);
    // Insertion order (rowid) is accepted order: the newest version of a
    // document is its largest rowid, independent of clock ties.
    db.run(`
      CREATE TABLE IF NOT EXISTS document_versions (
        tree_id TEXT NOT NULL REFERENCES trees(id),
        stable_key TEXT NOT NULL,
        update_id TEXT NOT NULL REFERENCES accepted_updates(id),
        entry_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        UNIQUE (tree_id, stable_key, update_id, entry_path)
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS document_versions_key ON document_versions(tree_id, stable_key)");
  }

  /** Apply one accepted update's entry changes. Runs inside its transaction. */
  apply(tree: string, update: string, acceptedAt: number, changes: EntryChanges): void {
    const remove = this.db.prepare("DELETE FROM entry_metadata WHERE tree_id = ? AND path = ?");
    for (const path of changes.removed) remove.run(tree, path);
    const upsert = this.db.prepare(`
      INSERT INTO entry_metadata (tree_id, path, modified_at, update_id, data_json) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT (tree_id, path) DO UPDATE SET modified_at = excluded.modified_at, update_id = excluded.update_id
    `);
    const latest = this.db.prepare(`
      SELECT content_hash FROM document_versions WHERE tree_id = ? AND stable_key = ? ORDER BY rowid DESC LIMIT 1
    `);
    const version = this.db.prepare(`
      INSERT OR IGNORE INTO document_versions (tree_id, stable_key, update_id, entry_path, content_hash, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const change of changes.set) {
      upsert.run(tree, change.path, acceptedAt, update);
      if (!change.document) continue;
      // A move without a content change is not a new version.
      const previous = latest.get(tree, change.document.key) as { content_hash: string } | null;
      if (previous?.content_hash !== change.hash)
        version.run(tree, change.document.key, update, change.path, change.hash, acceptedAt);
    }
  }

  /** The tree's file entries and when each last changed, keyed by entry path. */
  entries(tree: string): Map<string, { modifiedAt: number; update: string }> {
    const rows = this.db.query("SELECT path, modified_at, update_id FROM entry_metadata WHERE tree_id = ?").all(tree) as
      Array<{ path: string; modified_at: number; update_id: string }>;
    return new Map(rows.map((row) => [row.path, { modifiedAt: row.modified_at, update: row.update_id }]));
  }

  /** Newest first. */
  documentVersions(tree: string, stableKey: string): DocumentVersion[] {
    const rows = this.db.query(`
      SELECT stable_key, update_id, entry_path, content_hash, accepted_at FROM document_versions
      WHERE tree_id = ? AND stable_key = ? ORDER BY rowid DESC
    `).all(tree, stableKey) as Array<{ stable_key: string; update_id: string; entry_path: string; content_hash: string; accepted_at: number }>;
    return rows.map((row) => ({ stableKey: row.stable_key, update: row.update_id, entryPath: row.entry_path,
      contentHash: row.content_hash as ObjectHash, acceptedAt: row.accepted_at }));
  }
}
