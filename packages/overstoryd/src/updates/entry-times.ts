import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { bundleEntries, type EntryTimes, type ObjectHash, type TreeReader } from "@ovst/protocol";
import { entryChanges, type EntryChanges } from "./entry-metadata.ts";

/**
 * Entry times (tree operations §1.1.2a): when each `(path, object)` pair a
 * tree has held first appeared there, so any retained root's entries can be
 * dated by lookup, without replaying history.
 *
 * The index is a rebuildable cache beside the host database, like the
 * provenance index: everything in it follows from accepted history (each
 * accepted update's diff from its predecessor), so it is written after the
 * acceptance commits, never in its transaction, and an index that is lost or
 * behind catches up from the log. Commits are WAL with `synchronous = NORMAL`
 * and batched, so indexing adds no fsync to an edit (Railway's disk is slow).
 *
 * One exception to "follows from history": a tree's first retained update
 * (history before migration 016 was squashed into it) dates its entries from
 * the older records the host kept, `document_versions` and `entry_metadata`,
 * where they are earlier.
 */

/** Bump to rebuild every host's index from history on its next start. */
const FORMAT = "1";
/** Accepted updates indexed per transaction. */
const BATCH = 400;
/** A read waits for a catch-up this close to the head instead of refusing. */
const WAIT_WITHIN = 200;
/** How long the indexer runs before it lets requests in. */
const SLICE_MS = 15;

export class EntryTimesBehind extends Error {
  constructor(readonly tree: string) {
    super(`Entry times of ${tree} are still being indexed`);
  }
}

interface Row {
  ordinal: number;
  root: ObjectHash;
  accepted_at: number;
  previous_root: ObjectHash | null;
}

export class EntryTimeIndex {
  private readonly db: Database;
  private readonly runs = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private disposed = false;
  /** Pairs the index lacked when a read asked for them; logged once each. */
  private readonly reportedMissing = new Set<string>();

  constructor(
    readonly path: string,
    private readonly host: Database,
    private readonly reader: () => TreeReader,
  ) {
    this.db = EntryTimeIndex.openCache(path);
  }

  private static openCache(path: string): Database {
    const open = () => {
      const db = new Database(path, { create: true });
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const format = (db.query("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | null)?.value;
      if (format !== undefined && format !== FORMAT) {
        db.run("DROP TABLE IF EXISTS times");
        db.run("DROP TABLE IF EXISTS progress");
      }
      db.run(`CREATE TABLE IF NOT EXISTS times (
        tree TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (tree, path, hash)) WITHOUT ROWID`);
      db.run("CREATE TABLE IF NOT EXISTS progress (tree TEXT PRIMARY KEY, through INTEGER NOT NULL)");
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('format', ?)", [FORMAT]);
      db.query("SELECT COUNT(*) FROM progress").get();
      return db;
    };
    try {
      return open();
    } catch (error) {
      // A cache that will not open is rebuilt from history.
      console.warn(`Entry time index at ${path} is unreadable, rebuilding: ${error instanceof Error ? error.message : String(error)}`);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      return open();
    }
  }

  /** The last accepted update of `tree` the index holds, 0 for none. */
  through(tree: string): number {
    return (this.db.query("SELECT through FROM progress WHERE tree = ?").get(tree) as { through: number } | null)?.through ?? 0;
  }

  /** Index every tree's accepted updates up to its head, one tree at a time. */
  async catchUpAll(): Promise<void> {
    const trees = (this.host.query("SELECT DISTINCT tree_id FROM accepted_updates").all() as Array<{ tree_id: string }>).map((row) => row.tree_id);
    for (const tree of trees) {
      if (this.disposed) return;
      try { await this.catchUp(tree); }
      catch (error) { if (!this.disposed) console.warn(`Entry time index of ${tree} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** A tree accepted an update: index it soon, off the request path. */
  notify(tree: string): void {
    void this.catchUp(tree).catch((error) => {
      if (!this.disposed) console.warn(`Entry time index of ${tree} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Index `tree` through its head. Concurrent calls share one run; a call
   * during a run makes it go round again, so it reaches the newest head. */
  catchUp(tree: string): Promise<void> {
    const running = this.runs.get(tree);
    if (running) {
      this.again.add(tree);
      return running;
    }
    const run = (async () => {
      do {
        this.again.delete(tree);
        await this.index(tree);
      } while (this.again.has(tree) && !this.disposed);
    })().finally(() => this.runs.delete(tree));
    this.runs.set(tree, run);
    return run;
  }

  private async index(tree: string): Promise<void> {
    const select = this.host.query(`
      SELECT u.ordinal, u.root, u.accepted_at, p.root AS previous_root
      FROM accepted_updates u LEFT JOIN accepted_updates p ON p.ordinal = u.previous_ordinal
      WHERE u.tree_id = ? AND u.ordinal > ? ORDER BY u.ordinal LIMIT ?`);
    const upsert = this.db.prepare(`
      INSERT INTO times (tree, path, hash, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (tree, path, hash) DO UPDATE SET at = min(at, excluded.at)`);
    const known = this.db.prepare("SELECT at FROM times WHERE tree = ? AND path = ? AND hash = ?");
    const progress = this.db.prepare("INSERT OR REPLACE INTO progress (tree, through) VALUES (?, ?)");
    let through = this.through(tree);
    let sliceStarted = performance.now();
    const started = sliceStarted;
    let indexed = 0;
    while (!this.disposed) {
      const rows = select.all(tree, through, BATCH) as Row[];
      if (!rows.length) break;
      // One reader per batch: consecutive roots share its decoded directories,
      // and a long backfill does not hold every directory it ever read.
      const reader = this.reader();
      const written: Array<{ ordinal: number; acceptedAt: number; changes: EntryChanges; seeds?: Map<string, number> }> = [];
      for (const row of rows) {
        // Directory reads are async; the writes below are one transaction.
        const changes = await entryChanges(row.previous_root, row.root, reader, { documents: false });
        written.push({
          ordinal: row.ordinal,
          acceptedAt: row.accepted_at,
          changes,
          ...(row.previous_root === null ? { seeds: await this.seeds(tree, row.root, reader) } : {}),
        });
        if (performance.now() - sliceStarted > SLICE_MS) {
          await new Promise((resolve) => setImmediate(resolve));
          sliceStarted = performance.now();
          if (this.disposed) return;
        }
      }
      this.db.transaction(() => {
        for (const { ordinal, acceptedAt, changes, seeds } of written) {
          for (const change of changes.set) {
            let at = acceptedAt;
            const seed = seeds?.get(`${change.path}\0${change.hash}`);
            if (seed !== undefined && seed < at) at = seed;
            // A kind change alone (file to page, or back) is not new content.
            if (change.converted) {
              const before = known.get(tree, change.path, change.converted) as { at: number } | null;
              if (before && before.at < at) at = before.at;
            }
            upsert.run(tree, change.path, change.hash, at);
          }
          progress.run(tree, ordinal);
        }
      })();
      through = rows.at(-1)!.ordinal;
      indexed += rows.length;
    }
    // A catch-up after a start or a lost index, not one edit's.
    if (indexed > 50) console.info(`Entry time index: ${indexed} updates of ${tree} indexed in ${Math.round(performance.now() - started)} ms`);
  }

  /**
   * Earlier times for a first retained root's entries, from what the host
   * kept of the history migration 016 squashed: a document version of that
   * object at that path, or, when the path holds the same object at the head,
   * the time `entry_metadata` gives it there.
   */
  private async seeds(tree: string, root: ObjectHash, reader: TreeReader): Promise<Map<string, number>> {
    const seeds = new Map<string, number>();
    const lower = (key: string, at: number) => {
      const was = seeds.get(key);
      if (was === undefined || at < was) seeds.set(key, at);
    };
    const versions = this.host.query(`
      SELECT entry_path, content_hash, MIN(accepted_at) AS at FROM document_versions
      WHERE tree_id = ? GROUP BY entry_path, content_hash`).all(tree) as Array<{ entry_path: string; content_hash: string; at: number }>;
    for (const version of versions) lower(`${version.entry_path}\0${version.content_hash}`, version.at);
    const head = (this.host.query("SELECT ref FROM trees WHERE id = ?").get(tree) as { ref: ObjectHash } | null)?.ref;
    if (head) {
      const metadata = new Map((this.host.query("SELECT path, modified_at FROM entry_metadata WHERE tree_id = ?").all(tree) as Array<{ path: string; modified_at: number }>)
        .map((row) => [row.path, row.modified_at]));
      if (metadata.size) {
        const first = new Map((await entryChanges(null, root, reader, { documents: false })).set.map((change) => [change.path, change.hash]));
        for (const change of (await entryChanges(null, head, reader, { documents: false })).set) {
          const at = metadata.get(change.path);
          if (at !== undefined && first.get(change.path) === change.hash) lower(`${change.path}\0${change.hash}`, at);
        }
      }
    }
    return seeds;
  }

  /**
   * The times of every file and page entry of every directory in `objects`
   * reachable from `root` through directories `objects` holds, keyed by
   * entry path. The index must hold `root`'s first accepted update: a read
   * close behind waits for it, one far behind is refused (`EntryTimesBehind`).
   */
  async times(tree: string, root: ObjectHash, objects: Map<ObjectHash, Uint8Array>): Promise<EntryTimes> {
    const first = this.host.query("SELECT MIN(ordinal) AS ordinal, MIN(accepted_at) AS at FROM accepted_updates WHERE tree_id = ? AND root = ?")
      .get(tree, root) as { ordinal: number | null; at: number | null };
    if (first.ordinal === null) throw new Error(`Root ${root} is not a retained root of ${tree}`);
    if (this.through(tree) < first.ordinal) {
      const head = (this.host.query("SELECT MAX(ordinal) AS ordinal FROM accepted_updates WHERE tree_id = ?").get(tree) as { ordinal: number }).ordinal;
      if (head - this.through(tree) > WAIT_WITHIN && !this.runs.has(tree)) this.notify(tree);
      if (head - this.through(tree) > WAIT_WITHIN) throw new EntryTimesBehind(tree);
      await this.catchUp(tree);
      if (this.through(tree) < first.ordinal) throw new EntryTimesBehind(tree);
    }
    const lookup = this.db.prepare("SELECT at FROM times WHERE tree = ? AND path = ? AND hash = ?");
    const times: EntryTimes = {};
    for (const [path, hash] of bundleEntries(root, objects)) {
      const row = lookup.get(tree, path, hash) as { at: number } | null;
      if (row) { times[path] = row.at; continue; }
      // Every pair of an indexed root is in the index; a gap is a bug, dated
      // by the root itself rather than failing the read.
      const key = `${tree}\0${path}\0${hash}`;
      if (!this.reportedMissing.has(key)) {
        this.reportedMissing.add(key);
        console.warn(`Entry time index of ${tree} lacks ${path} at ${hash}`);
      }
      times[path] = first.at!;
    }
    return times;
  }

  /** Rows and trees held, for diagnostics and the rehearsal. */
  stats(): { rows: number; trees: number } {
    return {
      rows: (this.db.query("SELECT COUNT(*) AS n FROM times").get() as { n: number }).n,
      trees: (this.db.query("SELECT COUNT(*) AS n FROM progress").get() as { n: number }).n,
    };
  }

  async close(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.runs.values()]);
    this.db.close();
  }
}
