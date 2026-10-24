// The relational layout of a checked schema: the tables, columns and keys a
// database needs to implement it. Dialect-neutral; sql.ts writes it out and
// the verify backends compare databases and files against it.
//
// - A model with data rows is a table named after the model. Person is a
//   Story account and fixed models live in the schema, so neither has one; a
//   reference to Person is the account's profile id, and a reference to a
//   fixed model is the row's name.
// - A table's primary key is the model's key. A key field that refers to
//   another model expands to that model's key columns: one column named after
//   the field when the target has a one-column key, else `field_part` each.
// - A 1:1 or 1:n connection is a column (or columns) on the single side; an
//   n:m connection is a join table named `Model_field` after its first end.
// - `ordered` on a many end adds a `field_position` column where the
//   connection is stored.
// - Every table has `created` and `modified`. In data files they are optional:
//   a row has them once an edit that stated its time wrote them.
// - `@table("…")` and `@column("…")` rename what is stored, so a schema can
//   describe a database it didn't create.
// - In data files, an n:m connection with a `@fold` end is an array on that
//   end's rows instead of a file of its own. Databases always use a join table.
// - Database tables index the columns rows are looked up by: references not
//   leading the primary key (profile ids included) and each `@index`.

import type { CheckResult, ResolvedEnd, ResolvedModel, RowValue } from "./check.ts";

export type ColumnType = "text" | "int" | "number" | "bool" | "date" | "timestamp" | "position";

export interface Column {
  name: string;
  type: ColumnType;
  /** Value arrays are stored in one column. */
  array: boolean;
  nullable: boolean;
  /** For a reference to a fixed model: the allowed row names. */
  allowed?: string[];
  /** For a reference to Person: the column holds a profile id. */
  profile?: boolean;
  /** For a folded connection: each item names a row of `table` by its key columns (one value, or an object of them). */
  references?: { table: string; columns: Column[] };
}

export interface ForeignKey {
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete: "cascade" | "set null" | "restrict";
}

/** The columns that hold one field of a model's rows. */
export interface StoredField {
  name: string;
  columns: string[];
  /** For a reference: the model it names a row of, by that model's key columns in order. */
  target?: string;
}

/** One side of a join table: the rows of `model` whose `field` holds the connection. */
export interface JoinEnd {
  model: string;
  field: string;
  /** The columns naming the `model` row. */
  columns: string[];
  /** For an `ordered` end: the column that orders `field`'s members. */
  position?: string;
  /** `@fold`: in data files, `field` holds the connection as an array. */
  fold: boolean;
}

export interface Table {
  name: string;
  /** The model this table stores, or the connection a join table stores (`Game.authors`). */
  stores: string;
  columns: Column[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: ForeignKey[];
  /** Columns to look rows up by, beyond the primary key: references, and `@index`. */
  indexes: string[][];
  /** For a model's table: which columns hold each field. Other columns (timestamps, positions) hold themselves. */
  fields: StoredField[];
  /** For a join table: its two sides. */
  ends?: [JoinEnd, JoinEnd];
  /** `seed` rows, inserted when missing. */
  seed: Record<string, RowValue>[];
}

const VALUE_COLUMN: Record<string, ColumnType> = {
  Text: "text",
  Markdown: "text",
  Int: "int",
  Number: "number",
  Bool: "bool",
  Date: "date",
};

export class LayoutError extends Error {
  constructor(
    message: string,
    /** The model or connection (`Model.field`) the problem is in. */
    readonly where?: string,
  ) {
    super(message);
  }
}

export interface LayoutOptions {
  /** `files` folds `@fold` connections into arrays; `database` (the default) keeps every n:m in a join table. */
  store?: "database" | "files";
}

export function layoutOf(result: CheckResult, options: LayoutOptions = {}): Table[] {
  if (result.diagnostics.length > 0) throw new LayoutError("The schema has errors; check it first");
  const models = new Map(result.models.map((m) => [m.name, m]));
  const hasTable = (name: string) => name !== "Person" && models.get(name)?.rows !== "fixed";
  const tableName = (model: string) => models.get(model)?.table ?? model;
  const columnName = (field: { name: string; column?: string }) => field.column ?? field.name;

  // The columns that identify a row of `model`, as they appear in its own table.
  const keyColumns = (model: ResolvedModel, seen: string[] = []): Column[] => {
    if (seen.includes(model.name)) throw new LayoutError(`${[...seen, model.name].join(" → ")} key each other`);
    return model.key.flatMap((k) => {
      if (k === "id") return [{ name: "id", type: "text", array: false, nullable: false } satisfies Column];
      const field = model.fields.find((f) => f.name === k)!;
      if (VALUE_COLUMN[field.type]) return [{ name: columnName(field), type: VALUE_COLUMN[field.type]!, array: false, nullable: false }];
      return referenceColumns(field.type, columnName(field), false, [...seen, model.name]);
    });
  };

  // The columns in another table that point at a row of `target`.
  const referenceColumns = (target: string, name: string, nullable: boolean, seen: string[] = []): Column[] => {
    if (target === "Person") return [{ name, type: "text", array: false, nullable, profile: true }];
    const model = models.get(target)!;
    if (model.rows === "fixed") {
      return [{ name, type: "text", array: false, nullable, allowed: model.schemaRows.map((r) => r.name) }];
    }
    const keys = keyColumns(model, seen);
    return keys.map((c) => ({ ...c, name: keys.length === 1 ? name : `${name}_${c.name}`, nullable }));
  };

  const foreignKey = (target: string, columns: Column[], onDelete: ForeignKey["onDelete"]): ForeignKey[] =>
    hasTable(target)
      ? [{ columns: columns.map((c) => c.name), table: tableName(target), refColumns: keyColumns(models.get(target)!).map((c) => c.name), onDelete }]
      : [];

  const tables = new Map<string, Table>();
  for (const model of result.models) {
    if (!hasTable(model.name)) continue;
    const key = keyColumns(model);
    const table: Table = {
      name: tableName(model.name),
      stores: model.name,
      columns: [...key],
      primaryKey: key.map((c) => c.name),
      uniques: [],
      foreignKeys: [],
      indexes: [],
      fields: [],
      seed: [],
    };
    const add = (columns: Column[]) => table.columns.push(...columns);
    // Key fields that are references need foreign keys too.
    for (const k of model.key) {
      const field = model.fields.find((f) => f.name === k);
      if (!field) {
        table.fields.push({ name: k, columns: [k] });
      } else if (VALUE_COLUMN[field.type]) {
        table.fields.push({ name: k, columns: [columnName(field)] });
      } else {
        const cols = referenceColumns(field.type, columnName(field), false);
        table.fields.push({ name: k, columns: cols.map((c) => c.name), target: field.type });
        table.foreignKeys.push(...foreignKey(field.type, cols, model.ends.length > 0 ? "cascade" : "restrict"));
      }
    }
    for (const field of model.fields) {
      if (model.key.includes(field.name)) continue;
      if (VALUE_COLUMN[field.type]) {
        add([{ name: columnName(field), type: VALUE_COLUMN[field.type]!, array: field.arity === "many", nullable: field.arity === "optional" }]);
        table.fields.push({ name: field.name, columns: [columnName(field)] });
        if (field.unique) table.uniques.push([columnName(field)]);
      } else if (field.origin === "end") {
        // A connection model with its own id: its ends are plain required references.
        const cols = referenceColumns(field.type, columnName(field), false);
        add(cols);
        table.fields.push({ name: field.name, columns: cols.map((c) => c.name), target: field.type });
        table.foreignKeys.push(...foreignKey(field.type, cols, "cascade"));
      }
    }
    // Ordered ends of a connection model order its rows within each end's row.
    for (const end of model.ends) {
      if (end.ordered) add([{ name: `${end.field}_position`, type: "position", array: false, nullable: false }]);
    }
    add([
      { name: "created", type: "timestamp", array: false, nullable: false },
      { name: "modified", type: "timestamp", array: false, nullable: false },
    ]);
    if (model.rows === "seed") {
      const byField = new Map(model.fields.map((f) => [f.name, columnName(f)]));
      table.seed = model.schemaRows.map((row) => ({
        id: row.name,
        ...Object.fromEntries(Object.entries(row.values).map(([k, v]) => [byField.get(k) ?? k, v])),
      }));
    }
    tables.set(model.name, table);
  }

  for (const connection of result.connections) {
    const { a, b, storage } = connection;
    if (storage.kind === "column") {
      const holder = storage.on === a.model && storage.field === a.field ? a : b;
      const other = holder === a ? b : a;
      const table = tables.get(holder.model)!;
      // A connection that is part of the key (`model Tag (list, id)`) already has its columns.
      if (models.get(holder.model)!.key.includes(holder.field)) continue;
      const cols = referenceColumns(other.model, holder.column ?? holder.field, holder.arity === "optional");
      table.columns.splice(table.columns.length - 2, 0, ...cols);
      table.fields.push({ name: holder.field, columns: cols.map((c) => c.name), target: other.model });
      if (other.ordered) {
        table.columns.splice(table.columns.length - 2, 0, {
          name: `${other.field}_position`,
          type: "position",
          array: false,
          nullable: holder.arity === "optional",
        });
      }
      if (other.arity !== "many") table.uniques.push(cols.map((c) => c.name));
      table.foreignKeys.push(...foreignKey(other.model, cols, holder.arity === "optional" ? "set null" : "restrict"));
    } else if (storage.kind === "array" && options.store === "files" && (a.fold || b.fold)) {
      const holder = a.fold ? a : b;
      const other = holder === a ? b : a;
      const name = holder.column ?? holder.field;
      const table = tables.get(holder.model)!;
      let column: Column;
      if (hasTable(other.model)) {
        const keys = keyColumns(models.get(other.model)!);
        const type = keys.length === 1 ? keys[0]!.type : "text";
        column = { name, type, array: true, nullable: false, references: { table: tableName(other.model), columns: keys } };
      } else {
        column = { ...referenceColumns(other.model, name, false)[0]!, array: true };
      }
      table.columns.splice(table.columns.length - 2, 0, column);
      table.fields.push({ name: holder.field, columns: [name], target: other.model });
    } else if (storage.kind === "array") {
      tables.set(`${a.model}.${a.field}`, joinTable(a, b));
    }
  }

  for (const table of tables.values()) {
    if (options.store === "files") {
      // Data files have no indexes. Their rows keep `created` and `modified`
      // when an edit stated its time (spec 10 §4.1), so both are optional.
      table.columns = table.columns.map((c) => c.type === "timestamp" ? { ...c, nullable: true } : c);
      continue;
    }
    const model = models.get(table.stores);
    const indexes: string[][] = [];
    const leadsKey = (columns: string[]) => columns.every((c, i) => table.primaryKey[i] === c);
    // References are looked up from the rows they name: foreign keys, and profile ids, whose table isn't here.
    for (const fk of table.foreignKeys) if (!leadsKey(fk.columns)) indexes.push(fk.columns);
    for (const column of table.columns) {
      if (column.profile && !column.array && !leadsKey([column.name])) indexes.push([column.name]);
    }
    for (const fields of model?.indexes ?? []) {
      indexes.push(
        fields.flatMap((f) => {
          if ((["created", "modified"] as string[]).includes(f)) return [f];
          const stored = table.fields.find((s) => s.name === f);
          if (!stored) throw new LayoutError(`\`@index\` names \`${f}\`, which \`${table.name}\` doesn't store; index the model that holds it`, model!.name);
          return stored.columns;
        }),
      );
    }
    // An index also serves lookups by its leading columns, so drop one that another starts with.
    const startsWith = (long: string[], short: string[]) => short.every((c, i) => long[i] === c);
    table.indexes = indexes.filter(
      (columns, i) => !indexes.some((other, j) => startsWith(other, columns) && (other.length > columns.length || j < i)),
    );
  }

  for (const [where, table] of tables) {
    const seen = new Set<string>();
    for (const c of table.columns) {
      if (seen.has(c.name)) throw new LayoutError(`Table \`${table.name}\` would have two columns named \`${c.name}\`; rename one with @column`, where);
      seen.add(c.name);
    }
  }

  function joinTable(a: ResolvedEnd, b: ResolvedEnd): Table {
    const nameA = lowerFirst(a.model);
    const nameB = a.model === b.model ? a.field : lowerFirst(b.model);
    const colsA = referenceColumns(a.model, nameA, false);
    const colsB = referenceColumns(b.model, nameB, false);
    const positions: Column[] = [a, b]
      .filter((e) => e.ordered)
      .map((e) => ({ name: `${e.field}_position`, type: "position", array: false, nullable: false }));
    return {
      name: `${tableName(a.model)}_${a.field}`,
      stores: `${a.model}.${a.field}`,
      columns: [
        ...colsA,
        ...colsB,
        ...positions,
        { name: "created", type: "timestamp", array: false, nullable: false },
        { name: "modified", type: "timestamp", array: false, nullable: false },
      ],
      primaryKey: [...colsA, ...colsB].map((c) => c.name),
      uniques: [],
      foreignKeys: [...foreignKey(a.model, colsA, "cascade"), ...foreignKey(b.model, colsB, "cascade")],
      indexes: [],
      fields: [],
      ends: [
        { model: a.model, field: a.field, columns: colsA.map((c) => c.name), fold: a.fold, ...(a.ordered ? { position: `${a.field}_position` } : {}) },
        { model: b.model, field: b.field, columns: colsB.map((c) => c.name), fold: b.fold, ...(b.ordered ? { position: `${b.field}_position` } : {}) },
      ],
      seed: [],
    };
  }

  return [...tables.values()];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

