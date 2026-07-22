import { readFile, stat } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SearchResult } from "@arbor/core";
import { nodeDisplayName, nodePathFromPhysical, toTreePath } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";

const IGNORED = new Set([".git", "node_modules", "Trash", ".arbor"]);
const INDEXED_EXTENSIONS = new Set(["md", "csv", "jsonl", "json", "ts", "tsx", "txt"]);

interface IndexRecord {
  path: string;
  mtime: number;
  size: number;
  title: string;
  body: string;
}

export class WorkspaceIndex {
  private database: Database;
  constructor(private root: string, databasePath: string) {
    this.database = new Database(databasePath, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    const oldFiles = this.database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'").get() as { sql: string } | null;
    if (oldFiles && !oldFiles.sql.includes("title TEXT")) this.database.exec("DROP TABLE IF EXISTS docs; DROP TABLE files;");
    this.database.exec("CREATE TABLE IF NOT EXISTS files(path TEXT UNIQUE NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);");
    this.database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, title, body, content='files', content_rowid='rowid', tokenize='unicode61');");
  }

  async rebuild(): Promise<void> {
    const existing = this.database.query("SELECT path, mtime, size FROM files").all() as Array<{ path: string; mtime: number; size: number }>;
    const current = new Map(existing.map((item) => [item.path, item]));
    const files = this.discoverFiles();
    const prepared = files.map((absolute) => {
      const treePath = nodePathFromPhysical(toTreePath(this.root, absolute));
      const extension = absolute.split(".").pop()?.toLowerCase();
      if (!INDEXED_EXTENSIONS.has(extension ?? "")) return { path: treePath, record: null };
      const info = statSync(absolute);
      const previous = current.get(treePath);
      if (previous?.mtime === info.mtimeMs && previous.size === info.size) return { path: treePath, record: null };
      return { path: treePath, record: this.prepareRecordSync(absolute, treePath, info.mtimeMs, info.size) };
    });
    const seen = new Set(prepared.map((item) => item.path));
    const removeFile = this.database.prepare("DELETE FROM files WHERE path = ?");
    const upsertFile = this.database.prepare("INSERT INTO files(path, mtime, size, title, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,title=excluded.title,body=excluded.body");
    let changed = false;
    this.database.transaction(() => {
      for (const item of existing) {
        if (!seen.has(item.path)) { removeFile.run(item.path); changed = true; }
      }
      for (const item of prepared) {
        if (!item.record) continue;
        upsertFile.run(item.path, item.record.mtime, item.record.size, item.record.title, item.record.body);
        changed = true;
      }
      if (changed) this.database.exec("INSERT INTO docs(docs) VALUES('rebuild')");
    })();
  }

  async updateAbsolute(path: string): Promise<void> {
    const treePath = nodePathFromPhysical(toTreePath(this.root, path));
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      await this.indexFile(path, treePath, info.mtimeMs, info.size);
    } catch {
      this.deleteIndexedPath(treePath);
    }
  }

  search(query: string, limit = 30): SearchResult[] {
    const escaped = query.trim().split(/\s+/).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" ");
    if (!escaped) return [];
    const rows = this.database.query(
      "SELECT path, title, snippet(docs, 2, '<mark>', '</mark>', '…', 24) AS excerpt, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?",
    ).all(escaped, limit) as Array<{ path: string; title: string; excerpt: string; rank: number }>;
    return rows.map((row) => ({ path: row.path, title: row.title, excerpt: row.excerpt, score: -row.rank }));
  }

  close(): void { this.database.close(); }

  private discoverFiles(): string[] {
    const files: string[] = [];
    const directories = [this.root];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (IGNORED.has(entry.name) || entry.name.startsWith("._") || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) directories.push(absolute);
        else if (entry.isFile()) files.push(absolute);
      }
    }
    return files;
  }

  private prepareRecordSync(absolute: string, treePath: string, mtime: number, size: number): IndexRecord | null {
    const extension = absolute.split(".").pop()?.toLowerCase();
    if (!INDEXED_EXTENSIONS.has(extension ?? "")) return null;
    let source: string;
    try { source = readFileSync(absolute, "utf8"); } catch { return null; }
    return this.recordFromSource(absolute, treePath, extension, source, mtime, size);
  }

  private async indexFile(absolute: string, treePath: string, mtime: number, size: number): Promise<void> {
    const record = await this.prepareRecord(absolute, treePath, mtime, size);
    if (!record) return;
    const transaction = this.database.transaction(() => {
      const previous = this.database.query("SELECT rowid, path, title, body FROM files WHERE path = ?").get(treePath) as { rowid: number; path: string; title: string; body: string } | null;
      if (previous) this.database.prepare("INSERT INTO docs(docs, rowid, path, title, body) VALUES ('delete', ?, ?, ?, ?)").run(previous.rowid, previous.path, previous.title, previous.body);
      this.database.prepare("INSERT INTO files(path, mtime, size, title, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,title=excluded.title,body=excluded.body").run(treePath, mtime, size, record.title, record.body);
      const current = this.database.query("SELECT rowid FROM files WHERE path = ?").get(treePath) as { rowid: number };
      this.database.prepare("INSERT INTO docs(rowid, path, title, body) VALUES (?, ?, ?, ?)").run(current.rowid, treePath, record.title, record.body);
    });
    transaction();
  }

  private deleteIndexedPath(treePath: string): void {
    const transaction = this.database.transaction(() => {
      const previous = this.database.query("SELECT rowid, path, title, body FROM files WHERE path = ?").get(treePath) as { rowid: number; path: string; title: string; body: string } | null;
      if (!previous) return;
      this.database.prepare("INSERT INTO docs(docs, rowid, path, title, body) VALUES ('delete', ?, ?, ?, ?)").run(previous.rowid, previous.path, previous.title, previous.body);
      this.database.prepare("DELETE FROM files WHERE path = ?").run(treePath);
    });
    transaction();
  }

  private async prepareRecord(absolute: string, treePath: string, mtime: number, size: number): Promise<IndexRecord | null> {
    const extension = absolute.split(".").pop()?.toLowerCase();
    if (!INDEXED_EXTENSIONS.has(extension ?? "")) return null;
    let source: string;
    try { source = await readFile(absolute, "utf8"); } catch { return null; }
    return this.recordFromSource(absolute, treePath, extension, source, mtime, size);
  }

  private recordFromSource(absolute: string, treePath: string, extension: string | undefined, source: string, mtime: number, size: number): IndexRecord {
    let body = source;
    let title = nodeDisplayName(treePath);
    if (extension === "md") {
      try {
        const document = parseMarkdown(source);
        body = `${JSON.stringify(document.frontmatter)}\n${document.bodySource}`;
        title = String(document.frontmatter.title ?? title);
      } catch {}
    }
    return { path: treePath, mtime, size, title, body };
  }
}
