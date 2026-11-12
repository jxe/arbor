// The host's SQLite copy of one collection (Apps 015): its rows in the schema's database
// layout, at `<dataRoot>/beetle/materialized/<tree>/<path>/_store.sqlite3`, caught up to
// the tree's accepted head before a view reads it. The file is a cache: never backed up
// or audited, written without waiting on the disk, and rebuilt from accepted rows when it
// is missing, unreadable or from another schema. Views read it through Beetle's
// SQLiteStore, so they read only the rows they ask for.

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical, type StoreSchema } from "@ovst/beetle";
import { rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";

/** A collection's changed logical rows by model: each one before (absent if new) and after (absent if deleted). */
export type LogicalChanges = Record<string, { before: LogicalTables[string]; after: LogicalTables[string] }>;

const FILE = "_store.sqlite3";
/** The copy's own record, which no view reads. */
const META = "__beetle_materialized";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A row value as SQLite stores it: flags as 0/1, value arrays as JSON text. */
const storedValue = (value: unknown): unknown => stored(value);
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

  /**
   * Bring the copy forward by a collection's changed logical rows alone, in one
   * transaction. Each changed row rewrites what it owns in the database layout: its own
   * row (whose position columns its holder writes), its join rows, and the positions of
   * the rows it holds in order. Every other row is the same before and after.
   */
  applyChanges(schema: StoreSchema, changes: LogicalChanges, directory: string): void {
    const own = (model: string, row: LogicalTables[string][number]) => rowsFromLogical(schema.result, schema.layout, { [model]: [row] } as LogicalTables);
    const db = this.database;
    const where = (columns: readonly string[]) => columns.map((c) => `${quote(c)} is ?`).join(" and ");
    const values = (row: Record<string, unknown>, columns: readonly string[]) => columns.map((c) => stored(row[c])) as never[];
    db.transaction(() => {
      db.exec("pragma defer_foreign_keys = on");
      const tableOf = (model: string) => {
        const name = schema.tableOf(model);
        const table = name ? schema.byName.get(name) : undefined;
        if (!table) throw new Error(`${model} has no table`);
        return table;
      };
      const keyOf = (row: LogicalTables[string][number]) => JSON.stringify(row.key);
      // Deleted rows first; what refers to them goes with them as their foreign keys say.
      for (const [model, { before, after }] of Object.entries(changes)) {
        const table = tableOf(model);
        const kept = new Set(after.map(keyOf));
        const remove = db.prepare(`delete from ${quote(table.name)} where ${where(table.primaryKey)}`);
        for (const row of before) if (!kept.has(keyOf(row))) remove.run(...values(own(model, row)[table.name]![0]!, table.primaryKey));
      }
      // Then each row as it is now, its join rows, and the order of the rows it holds.
      const positions: Array<() => void> = [];
      for (const [model, { before, after }] of Object.entries(changes)) {
        const table = tableOf(model);
        const prior = new Map(before.map((row) => [keyOf(row), row]));
        const held = new Set(table.columns.filter((c) => c.type === "position").map((c) => c.name));
        const columns = table.columns.map((c) => c.name);
        const settable = columns.filter((c) => !table.primaryKey.includes(c) && !held.has(c));
        const upsert = db.prepare(
          `insert into ${quote(table.name)} (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})` +
          ` on conflict (${table.primaryKey.map(quote).join(", ")}) do ${settable.length ? `update set ${settable.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}` : "nothing"}`,
        );
        for (const row of after) {
          const rows = own(model, row);
          const stored = rows[table.name]![0]!;
          upsert.run(...columns.map((c) => (held.has(c) && (stored[c] ?? null) === null ? 0 : storedValue(stored[c]))) as never[]);
          for (const r of schema.relationships) {
            if (r.source !== table.name) continue;
            if (r.through) {
              if (!(r.name in row.fields) && !(r.name in (prior.get(keyOf(row))?.fields ?? {}))) continue;
              const join = schema.byName.get(r.through.relation)!;
              const sourceColumns = r.through.source.map((p) => p.through);
              const sourceValues = r.through.source.map((p) => stored[p.source] ?? null);
              db.prepare(`delete from ${quote(join.name)} where ${where(sourceColumns)}`).run(...sourceValues.map(storedValue) as never[]);
              const insert = this.insert(join);
              for (const j of rows[join.name] ?? []) if (sourceColumns.every((c, i) => canonical(j[c] ?? null) === canonical(sourceValues[i]))) insert(j);
            } else if (r.direct && r.cardinality === "many") {
              const position = schema.positionOf(r);
              const members = row.fields[r.name];
              if (position?.table !== "target" || !Array.isArray(members)) continue;
              const target = schema.byName.get(r.target)!;
              const update = db.prepare(`update ${quote(target.name)} set ${quote(position.column)} = ? where ${where(target.primaryKey)}`);
              const member = schema.modelOfTable(target.name);
              members.forEach((key, i) => {
                const keyRow = own(member, { key, fields: {}, created: 0, modified: 0 } as never)[target.name]![0]!;
                positions.push(() => update.run(i as never, ...values(keyRow, target.primaryKey)));
              });
            }
          }
        }
      }
      for (const set of positions) set();
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
