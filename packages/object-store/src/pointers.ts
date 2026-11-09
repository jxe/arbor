import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HASH = /^sha256:[a-f0-9]{64}$/;

/**
 * A rebuildable table from one object hash to another, such as an entry's
 * provenance index root. It is a cache, so it is never synced: a write is a
 * row appended to SQLite's write-ahead log, with no file created and no
 * fsync, which on a slow volume is what a file per key cost. A crash may lose
 * recent rows; readers then find none and recompute.
 *
 * Several processes may open the same file (overstoryd writes, the merge
 * sidecar and the collector read).
 */
export class HashPointers {
  private readonly db: Database;
  private readonly getRow;
  private readonly putRow;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA busy_timeout = 10000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = OFF");
    this.db.run("CREATE TABLE IF NOT EXISTS pointers (key TEXT PRIMARY KEY, hash TEXT NOT NULL) WITHOUT ROWID");
    this.getRow = this.db.query<{ hash: string }, [string]>("SELECT hash FROM pointers WHERE key = ?");
    this.putRow = this.db.query<unknown, [string, string]>("INSERT OR REPLACE INTO pointers (key, hash) VALUES (?, ?)");
  }

  /** The hash `key` points to; null when absent. */
  get(key: string): string | null {
    const hash = this.getRow.get(key)?.hash;
    return hash && HASH.test(hash) ? hash : null;
  }

  /** Point each key at its hash, in one transaction. */
  set(pairs: Iterable<readonly [key: string, hash: string]>): void {
    this.db.transaction(() => {
      for (const [key, hash] of pairs) {
        if (!HASH.test(hash)) throw new Error(`Invalid pointer hash: ${hash}`);
        this.putRow.run(key, hash);
      }
    })();
  }

  close(): void {
    this.db.close();
  }
}
