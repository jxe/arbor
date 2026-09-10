import { Database } from "bun:sqlite";
import type { BigIntStats } from "node:fs";

/**
 * The per-workspace object index: `objects` maps every absolute path the
 * snapshot walk encodes to the hash of its wire object, for files and
 * directories alike. The index is an optimization, never authority: a file
 * row counts only while the complete stat tuple (size, mtime, ctime, inode,
 * device) still matches, directory rows carry no validity tuple and are
 * trusted only by callers that verify the re-encoded object's hash
 * afterwards, the workspace revalidates every row with an uncached walk at
 * open, after watcher gaps, and on a slow timer, and every object served by
 * hash is verified before it leaves the daemon. A stale row can therefore
 * delay a push but never produce a wrong object.
 */
export class ObjectIndex {
  private database: Database;
  constructor(databasePath: string) {
    this.database = new Database(databasePath, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    // The daemon's editor path kept title/body/link tables here; only the
    // object rows remain.
    this.database.exec("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS files;");
    this.database.exec("CREATE TABLE IF NOT EXISTS objects(path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER, mtime_ns INTEGER, ctime_ns INTEGER, ino INTEGER, dev INTEGER, hash TEXT NOT NULL);");
    this.database.exec("CREATE INDEX IF NOT EXISTS objects_hash ON objects(hash);");
  }

  /** The cached file hash when the row's full stat tuple still matches. */
  objectRow(absolute: string, info: BigIntStats): { hash: string } | undefined {
    const row = this.database.query(
      "SELECT hash FROM objects WHERE path = ? AND kind = 'file' AND size = ? AND mtime_ns = ? AND ctime_ns = ? AND ino = ? AND dev = ?",
    ).get(absolute, info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev) as { hash: string } | null;
    return row ?? undefined;
  }

  rememberObject(absolute: string, kind: "file" | "directory", info: BigIntStats | undefined, hash: string): void {
    if (kind === "directory" || !info) {
      this.rememberDirectory(absolute, hash);
      return;
    }
    this.database.prepare(
      "INSERT INTO objects(path, kind, size, mtime_ns, ctime_ns, ino, dev, hash) VALUES (?, 'file', ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,ino=excluded.ino,dev=excluded.dev,hash=excluded.hash",
    ).run(absolute, info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev, hash);
  }

  rememberDirectory(absolute: string, hash: string): void {
    this.database.prepare(
      "INSERT INTO objects(path, kind, size, mtime_ns, ctime_ns, ino, dev, hash) VALUES (?, 'directory', NULL, NULL, NULL, NULL, NULL, ?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=NULL,mtime_ns=NULL,ctime_ns=NULL,ino=NULL,dev=NULL,hash=excluded.hash",
    ).run(absolute, hash);
  }

  forgetObject(absolute: string): void {
    this.database.prepare("DELETE FROM objects WHERE path = ?").run(absolute);
  }

  /** The stored hash for a path regardless of validity; used by revalidation. */
  storedObjectHash(absolute: string): { kind: "file" | "directory"; hash: string } | undefined {
    const row = this.database.query("SELECT kind, hash FROM objects WHERE path = ?").get(absolute) as { kind: "file" | "directory"; hash: string } | null;
    return row ?? undefined;
  }

  /** Every stored path of one kind; revalidation drops rows whose files vanished. */
  storedObjectPaths(kind: "file" | "directory"): string[] {
    return (this.database.query("SELECT path FROM objects WHERE kind = ?").all(kind) as Array<{ path: string }>).map((row) => row.path);
  }

  lookupHash(hash: string): { path: string; kind: "file" | "directory" } | undefined {
    const row = this.database.query("SELECT path, kind FROM objects WHERE hash = ? ORDER BY path LIMIT 1").get(hash) as { path: string; kind: "file" | "directory" } | null;
    return row ?? undefined;
  }

  close(): void { this.database.close(); }
}
