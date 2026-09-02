import { readFile, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { toTreePath } from "@arbor/core/path";
export interface SearchIndexResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
}
import { legacyPageIDCandidate, nodeDisplayName, nodePathFromPhysical, resolveLogicalURL } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { discoverWorkspace, type WorkspaceDiscovery } from "@arbor/fs";
const INDEXED_EXTENSIONS = new Set(["md", "csv", "jsonl", "json", "ts", "tsx", "txt"]);

interface IndexRecord {
  path: string;
  mtime: number;
  size: number;
  title: string;
  body: string;
  links: IndexedLink[];
}

export interface BacklinkIndexResult {
  path: string;
  title: string;
  context: string;
}

interface IndexedLink {
  targetPath: string | null;
  targetPageID: string | null;
  targetTreeID: string | null;
  context: string;
}

function indexedLinks(sourcePath: string, body: string): IndexedLink[] {
  const links: IndexedLink[] = [];
  const pattern = /(?<!!)\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*)?\)/g;
  for (const match of body.matchAll(pattern)) {
    const href = match[1] ?? match[2];
    if (!href) continue;
    const resolved = resolveLogicalURL(sourcePath, href);
    let targetPath: string | null = null;
    let targetPageID: string | null = null;
    let targetTreeID: string | null = null;
    if (resolved?.kind === "local") {
      targetPath = resolved.path;
      targetPageID = legacyPageIDCandidate(resolved);
    } else if (resolved?.kind === "fragment") {
      targetPageID = legacyPageIDCandidate(resolved);
    } else if (resolved?.kind === "arbor" && "treeID" in resolved.authority) {
      targetPath = resolved.path;
      targetPageID = legacyPageIDCandidate(resolved);
      targetTreeID = resolved.authority.treeID;
    } else {
      continue;
    }
    const start = match.index ?? 0;
    const lineStart = body.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = body.indexOf("\n", start);
    links.push({
      targetPath,
      targetPageID,
      targetTreeID,
      context: body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim(),
    });
  }
  return links;
}

export class WorkspaceIndex {
  private database: Database;
  constructor(private root: string, databasePath: string) {
    this.database = new Database(databasePath, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    const oldFiles = this.database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'").get() as { sql: string } | null;
    const oldLinks = this.database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'links'").get() as { sql: string } | null;
    if (oldFiles && (!oldFiles.sql.includes("title TEXT") || !oldLinks?.sql.includes("target_tree_id"))) {
      this.database.exec("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS links; DROP TABLE files;");
    }
    this.database.exec("CREATE TABLE IF NOT EXISTS files(path TEXT UNIQUE NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);");
    this.database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, title, body, content='files', content_rowid='rowid', tokenize='unicode61');");
    this.database.exec("CREATE TABLE IF NOT EXISTS links(source_path TEXT NOT NULL, target_path TEXT, target_page_id TEXT, target_tree_id TEXT, context TEXT NOT NULL);");
    this.database.exec("CREATE INDEX IF NOT EXISTS links_target_path ON links(target_path);");
    this.database.exec("CREATE INDEX IF NOT EXISTS links_target_page_id ON links(target_page_id);");
    this.database.exec("CREATE INDEX IF NOT EXISTS links_target_tree_id ON links(target_tree_id);");
  }

  async rebuild(discovery?: WorkspaceDiscovery): Promise<void> {
    const existing = this.database.query("SELECT path, mtime, size FROM files").all() as Array<{ path: string; mtime: number; size: number }>;
    const current = new Map(existing.map((item) => [item.path, item]));
    const snapshot = discovery ?? await discoverWorkspace(this.root);
    const absoluteFiles = new Set(snapshot.files.map((file) => file.absolutePath));
    const prepared: Array<{ path: string; record: IndexRecord | null }> = [];
    for (const file of snapshot.files) {
      if (
        file.name === "_index.md"
        && dirname(file.absolutePath) !== this.root
        && absoluteFiles.has(`${dirname(file.absolutePath)}.md`)
      ) continue;
      const extension = file.absolutePath.split(".").pop()?.toLowerCase();
      if (!INDEXED_EXTENSIONS.has(extension ?? "")) continue;
      const treePath = nodePathFromPhysical(file.treePath);
      const info = statSync(file.absolutePath);
      const previous = current.get(treePath);
      prepared.push({
        path: treePath,
        record: previous?.mtime === info.mtimeMs && previous.size === info.size
          ? null
          : this.prepareRecordSync(file.absolutePath, treePath, info.mtimeMs, info.size),
      });
    }
    const seen = new Set(prepared.map((item) => item.path));
    const removeFile = this.database.prepare("DELETE FROM files WHERE path = ?");
    const removeLinks = this.database.prepare("DELETE FROM links WHERE source_path = ?");
    const upsertFile = this.database.prepare("INSERT INTO files(path, mtime, size, title, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,title=excluded.title,body=excluded.body");
    let changed = false;
    this.database.transaction(() => {
      for (const item of existing) {
        if (!seen.has(item.path)) {
          removeLinks.run(item.path);
          removeFile.run(item.path);
          changed = true;
        }
      }
      for (const item of prepared) {
        if (!item.record) continue;
        upsertFile.run(item.path, item.record.mtime, item.record.size, item.record.title, item.record.body);
        this.replaceLinks(item.path, item.record.links);
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

  search(query: string, limit = 30, offset = 0): SearchIndexResult[] {
    const escaped = query.trim().split(/\s+/).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" ");
    if (!escaped) return [];
    const rows = this.database.query(
      "SELECT path, title, snippet(docs, 2, '<mark>', '</mark>', '…', 24) AS excerpt, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ? OFFSET ?",
    ).all(escaped, limit, offset) as Array<{ path: string; title: string; excerpt: string; rank: number }>;
    return rows.map((row) => ({ path: row.path, title: row.title, excerpt: row.excerpt, score: -row.rank }));
  }

  backlinks(
    targetPath: string,
    targetPageID: string | undefined,
    targetTreeID: string,
    includeLocal: boolean,
    limit = 30,
    offset = 0,
  ): BacklinkIndexResult[] {
    const rows = this.database.query(
      `SELECT l.source_path AS path, f.title AS title, MIN(l.context) AS context
       FROM links l
       JOIN files f ON f.path = l.source_path
       WHERE ((? = 1 AND l.target_tree_id IS NULL AND l.target_path = ?)
         OR (l.target_tree_id = ? AND l.target_path = ?)
         OR (? IS NOT NULL AND l.target_tree_id = ? AND l.target_page_id = ?))
       GROUP BY l.source_path, f.title
       ORDER BY l.source_path
       LIMIT ? OFFSET ?`,
    ).all(
      includeLocal ? 1 : 0,
      targetPath,
      targetTreeID,
      targetPath,
      targetPageID ?? null,
      targetTreeID,
      targetPageID ?? null,
      limit,
      offset,
    ) as BacklinkIndexResult[];
    return rows;
  }

  close(): void { this.database.close(); }

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
      this.replaceLinks(treePath, record.links);
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
      this.database.prepare("DELETE FROM links WHERE source_path = ?").run(treePath);
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
    return {
      path: treePath,
      mtime,
      size,
      title,
      body,
      links: extension === "md" ? indexedLinks(treePath, source) : [],
    };
  }

  private replaceLinks(sourcePath: string, links: IndexedLink[]): void {
    this.database.prepare("DELETE FROM links WHERE source_path = ?").run(sourcePath);
    const insert = this.database.prepare(
      "INSERT INTO links(source_path, target_path, target_page_id, target_tree_id, context) VALUES (?, ?, ?, ?, ?)",
    );
    for (const link of links) {
      insert.run(sourcePath, link.targetPath, link.targetPageID, link.targetTreeID, link.context);
    }
  }
}
