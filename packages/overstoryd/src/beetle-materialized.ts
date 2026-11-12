// The host's SQLite copy of one collection (Apps 015): its rows in the schema's database
// layout, at `<dataRoot>/beetle/materialized/<tree>/<path>/_store.sqlite3`, caught up to
// the tree's accepted head before a view reads it. The file is a cache: never backed up
// or audited, written without waiting on the disk, and rebuilt from accepted rows when it
// is missing, unreadable or from another schema. Views read it through Beetle's
// SQLiteStore, so they read only the rows they ask for.

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@ovst/beetle";
import { setupSql, type RowsByTable, type Table } from "@ovst/usl";

const FILE = "_store.sqlite3";
/** The copy's own record, which no view reads. */
const META = "__beetle_materialized";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A row value as SQLite stores it: flags as 0/1, value arrays as JSON text. */
function stored(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export class Materialization {
  private constructor(
    readonly database: Database,
    /** The collection directory's hash the rows are from. */
    public directory: string,
    /** The hash of the schema.beetle the layout is from. */
    readonly schema: string,
  ) {}

  /** The copy left in `folder`, when it opens and says what it holds. */
  static reopen(folder: string): Materialization | null {
    let database: Database | undefined;
    try {
      database = new Database(join(folder, FILE), { create: false, strict: true });
      const meta = Object.fromEntries((database.query(`select key, value from ${META}`).all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
      if (!meta.directory || !meta.schema) throw new Error("no record");
      configure(database);
      return new Materialization(database, meta.directory, meta.schema);
    } catch {
      database?.close();
      return null;
    }
  }

  /** A new copy of `rows` in `folder`, replacing whatever was there. */
  static build(folder: string, layout: readonly Table[], rows: RowsByTable, directory: string, schema: string): Materialization {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const database = new Database(join(folder, FILE), { create: true, strict: true });
    configure(database);
    database.exec(setupSql([...layout], "sqlite"));
    database.exec(`create table ${META} (key text primary key, value text not null)`);
    const m = new Materialization(database, directory, schema);
    database.transaction(() => {
      for (const table of layout) {
        const insert = m.insert(table);
        for (const row of rows[table.name] ?? []) insert(row);
      }
      m.record(directory);
    })();
    return m;
  }

  private insert(table: Table): (row: Record<string, unknown>) => void {
    const columns = table.columns.map((c) => c.name);
    const statement = this.database.prepare(`insert into ${quote(table.name)} (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})`);
    return (row) => statement.run(...columns.map((c) => stored(row[c])) as never[]);
  }

  private record(directory: string): void {
    const set = this.database.prepare(`insert into ${META} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`);
    set.run("directory", directory);
    set.run("schema", this.schema);
    this.directory = directory;
  }

  /** Bring the copy from `before` to `after`, row by row, in one transaction. */
  apply(layout: readonly Table[], before: RowsByTable, after: RowsByTable, directory: string): void {
    this.database.transaction(() => {
      this.database.exec("pragma defer_foreign_keys = on");
      for (const table of layout) {
        const key = (row: Record<string, unknown>) => canonical(table.primaryKey.map((k) => row[k] ?? null));
        const left = new Map((before[table.name] ?? []).map((row) => [key(row), row]));
        const right = new Map((after[table.name] ?? []).map((row) => [key(row), row]));
        const where = table.primaryKey.map((k) => `${quote(k)} is ?`).join(" and ");
        const columns = table.columns.map((c) => c.name);
        const remove = this.database.prepare(`delete from ${quote(table.name)} where ${where}`);
        const update = this.database.prepare(`update ${quote(table.name)} set ${columns.map((c) => `${quote(c)} = ?`).join(", ")} where ${where}`);
        const insert = this.insert(table);
        const keyValues = (row: Record<string, unknown>) => table.primaryKey.map((k) => stored(row[k])) as never[];
        for (const [k, row] of left) if (!right.has(k)) remove.run(...keyValues(row));
        for (const [k, row] of right) {
          const prior = left.get(k);
          if (!prior) insert(row);
          else if (canonical(prior) !== canonical(row)) update.run(...columns.map((c) => stored(row[c])) as never[], ...keyValues(row));
        }
      }
      this.record(directory);
    })();
  }

  close(): void {
    this.database.close();
  }
}

function configure(database: Database): void {
  database.exec("pragma journal_mode = wal");
  // A cache: a commit doesn't wait on the disk, and a lost one is rebuilt.
  database.exec("pragma synchronous = normal");
  database.exec("pragma foreign_keys = on");
}
