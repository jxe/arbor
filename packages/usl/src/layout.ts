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
// - `@ordered` on a many end adds a `field_position` column where the
//   connection is stored.
// - Every table has `created` and `modified`.

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
}

export interface ForeignKey {
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete: "cascade" | "set null" | "restrict";
}

export interface Table {
  name: string;
  /** The model this table stores, or the connection a join table stores (`Game.authors`). */
  stores: string;
  columns: Column[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: ForeignKey[];
  /** `@@seed` rows, inserted when missing. */
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

export class LayoutError extends Error {}

export function layoutOf(result: CheckResult): Table[] {
  if (result.diagnostics.length > 0) throw new LayoutError("The schema has errors; check it first");
  const models = new Map(result.models.map((m) => [m.name, m]));
  const hasTable = (name: string) => name !== "Person" && models.get(name)?.rows !== "fixed";

  // The columns that identify a row of `model`, as they appear in its own table.
  const keyColumns = (model: ResolvedModel, seen: string[] = []): Column[] => {
    if (seen.includes(model.name)) throw new LayoutError(`${[...seen, model.name].join(" → ")} key each other`);
    return model.key.flatMap((k) => {
      if (k === "id") return [{ name: "id", type: "text", array: false, nullable: false } satisfies Column];
      const field = model.fields.find((f) => f.name === k)!;
      if (VALUE_COLUMN[field.type]) return [{ name: k, type: VALUE_COLUMN[field.type]!, array: false, nullable: false }];
      return referenceColumns(field.type, k, false, [...seen, model.name]);
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
      ? [{ columns: columns.map((c) => c.name), table: target, refColumns: keyColumns(models.get(target)!).map((c) => c.name), onDelete }]
      : [];

  const tables = new Map<string, Table>();
  for (const model of result.models) {
    if (!hasTable(model.name)) continue;
    const key = keyColumns(model);
    const table: Table = {
      name: model.name,
      stores: model.name,
      columns: [...key],
      primaryKey: key.map((c) => c.name),
      uniques: [],
      foreignKeys: [],
      seed: [],
    };
    const add = (columns: Column[]) => {
      for (const c of columns) if (!table.columns.some((t) => t.name === c.name)) table.columns.push(c);
    };
    // Key fields that are references need foreign keys too.
    for (const k of model.key) {
      const field = model.fields.find((f) => f.name === k);
      if (field && !VALUE_COLUMN[field.type]) {
        const cols = referenceColumns(field.type, k, false);
        table.foreignKeys.push(...foreignKey(field.type, cols, model.ends.length > 0 ? "cascade" : "restrict"));
      }
    }
    for (const field of model.fields) {
      if (model.key.includes(field.name)) continue;
      if (VALUE_COLUMN[field.type]) {
        add([{ name: field.name, type: VALUE_COLUMN[field.type]!, array: field.arity === "many", nullable: field.arity === "optional" }]);
        if (field.unique) table.uniques.push([field.name]);
      } else if (field.origin === "end") {
        // A connection model with its own id: its ends are plain required references.
        const cols = referenceColumns(field.type, field.name, false);
        add(cols);
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
      table.seed = model.schemaRows.map((row) => ({ id: row.name, ...row.values }));
    }
    tables.set(model.name, table);
  }

  for (const connection of result.connections) {
    const { a, b, storage } = connection;
    if (storage.kind === "column") {
      const holder = storage.on === a.model && storage.field === a.field ? a : b;
      const other = holder === a ? b : a;
      const table = tables.get(holder.model)!;
      // A connection that is part of the key (`@@id(list, id)`) already has its columns.
      if (models.get(holder.model)!.key.includes(holder.field)) continue;
      const cols = referenceColumns(other.model, holder.field, holder.arity === "optional");
      table.columns.splice(table.columns.length - 2, 0, ...cols);
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
    } else if (storage.kind === "array") {
      tables.set(`${a.model}_${a.field}`, joinTable(a, b));
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
      name: `${a.model}_${a.field}`,
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
      seed: [],
    };
  }

  return [...tables.values()];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

