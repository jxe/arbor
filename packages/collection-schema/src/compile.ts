import { revisionOf, type Hash } from "@ovst/protocol";
import { compileUsl, layoutOf, type Column } from "@ovst/usl";
import { COLLECTION_SCHEMA_LIMITS, CollectionSchemaError, schemaFailure } from "./diagnostics.ts";

/** Runtime check graph, built from the schema's files layout. */
export type Check =
  | { kind: "text" }
  /** A `Person` value: a profile id, or a `contact:<key>` placeholder. */
  | { kind: "person" }
  | { kind: "date" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "number" }
  /** An open map admits undeclared string keys with any JSON value; a row map is open except in a database's tables. */
  | { kind: "map"; members: CheckMember[]; byName: ReadonlyMap<string, CheckMember>; open: boolean }
  | { kind: "array"; element: Check }
  /** A reference to a fixed model: one of its row names. */
  | { kind: "choice"; values: ReadonlySet<string> };

export interface CheckMember {
  name: string;
  /** May be absent. */
  optional: boolean;
  /** May be null, which means the same as absent. */
  nullable: boolean;
  check: Check;
}

export type ChildNameRule =
  | { from: "primaryKey" }
  | { from: "property"; property: string };

export interface CsvColumn {
  name: string;
  optional: boolean;
  nullable: boolean;
  /** What a cell converts to: a scalar, or JSON for an array. */
  scalar: "text" | "number" | "boolean" | "json";
}

/** A compiled, immutable collection schema. Everything here derives from the exact source bytes. */
export interface CollectionSchema {
  /** SHA-256 of the exact source bytes: the descriptor's `schemaFingerprint`. */
  readonly revision: Hash;
  readonly source: string;
  /** The collection's model. */
  readonly model: string;
  /** The row's columns in layout order: the key, value fields, then connections. */
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly childName: ChildNameRule;
  readonly row: Extract<Check, { kind: "map" }>;
  readonly csvColumns: readonly CsvColumn[];
  /** How each column's value merges (spec 10 §7): absent means as one value. */
  readonly merge: ReadonlyMap<string, "many" | "ordered" | "markdown">;
  /** Proportional to the compiled check graph, so caches weigh entries by it. */
  readonly weight: number;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode exact schema bytes. The fingerprint is always of these bytes, never of a parsed form. */
export function decodeSchemaSource(bytes: Uint8Array): string {
  if (bytes.byteLength > COLLECTION_SCHEMA_LIMITS["source-bytes"]) {
    throw schemaFailure("schema-too-large", `schema.usl exceeds ${COLLECTION_SCHEMA_LIMITS["source-bytes"]} bytes`, undefined, "source-bytes");
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw schemaFailure("invalid-utf8", "schema.usl is not well-formed UTF-8");
  }
}

const CHECKS: Record<Column["type"], Check> = {
  text: { kind: "text" },
  date: { kind: "date" },
  timestamp: { kind: "date" },
  int: { kind: "int" },
  number: { kind: "number" },
  position: { kind: "number" },
  bool: { kind: "bool" },
};

/** The check for one stored value of `column` (an array column's items, when `item`). */
function columnCheck(column: Column, item = false): Check {
  if (column.array && !item) return { kind: "array", element: columnCheck(column, true) };
  if (item && column.references && column.references.columns.length > 1) {
    const members = column.references.columns.map((key) => ({ name: key.name, optional: false, nullable: false, check: columnCheck({ ...key, array: false, nullable: false }) }));
    return { kind: "map", members, byName: new Map(members.map((m) => [m.name, m])), open: false };
  }
  if (item && column.references) return columnCheck({ ...column.references.columns[0]!, array: false, nullable: false });
  if (column.allowed) return { kind: "choice", values: new Set(column.allowed) };
  if (column.profile) return { kind: "person" };
  return CHECKS[column.type];
}

const SCALAR: Record<Column["type"], CsvColumn["scalar"]> = {
  text: "text", date: "text", timestamp: "text", int: "number", number: "number", position: "number", bool: "boolean",
};

/** Which of the schema's layouts a collection stores: data files, where
 * `@fold` keeps connections on rows, or a database, with join tables. */
export type CollectionLayout = "files" | "database";

/** Every table a collection's `schema.usl` stores, in one of its layouts. */
export interface CollectionSchemaSet {
  readonly revision: Hash;
  readonly source: string;
  /** In the schema's layout order. */
  readonly tables: readonly CollectionSchema[];
  readonly weight: number;
}

/**
 * Compile a collection's `schema.usl` (spec 06 §2.4) into one schema per
 * table it stores in data files: each model with data rows (fixed models and
 * Person aside), and each connection without `@fold`. Throws
 * {@link CollectionSchemaError}.
 */
export function compileCollectionSchemas(input: Uint8Array | string, layout: CollectionLayout = "files"): CollectionSchemaSet {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const source = decodeSchemaSource(bytes);
  const result = compileUsl(source);
  if (result.diagnostics.length > 0) {
    throw new CollectionSchemaError(result.diagnostics.map((d) => ({
      code: d.code, message: d.message, location: { line: d.line, column: d.column },
    })));
  }
  const stored = layoutOf(result, { store: layout });
  if (!stored.length) throw schemaFailure("collection-tables", "A collection's schema.usl declares a model with data rows; this one has none");
  const revision = revisionOf(bytes) as Hash;
  const tables = stored.map((table): CollectionSchema => {
    const model = result.models.find((m) => m.name === table.stores);
    const members: CheckMember[] = table.columns.map((column) => ({
      name: column.name,
      // An empty value array is the same as an absent one.
      optional: column.nullable || column.array,
      nullable: column.nullable,
      check: columnCheck(column),
    }));
    const pathField = model?.path ? model.fields.find((f) => f.name === model.path) : undefined;
    return {
      revision,
      source,
      model: table.name,
      columns: table.columns.map((column) => column.name),
      primaryKey: [...table.primaryKey],
      childName: pathField ? { from: "property", property: pathField.column ?? pathField.name } : { from: "primaryKey" },
      // Overstory convention (spec 06 §2.4): undeclared row members are kept,
      // except in a database's tables, which have no column for them.
      row: { kind: "map", members, byName: new Map(members.map((m) => [m.name, m])), open: layout === "files" },
      csvColumns: table.columns.map((column) => ({
        name: column.name,
        optional: column.nullable || column.array,
        nullable: false,
        scalar: column.array ? "json" : SCALAR[column.type],
      })),
      merge: new Map((model?.fields ?? []).flatMap((field): Array<[string, "many" | "ordered" | "markdown"]> => {
        const column = field.column ?? field.name;
        if (!table.columns.some((c) => c.name === column)) return [];
        if (field.arity === "many") return [[column, field.ordered ? "ordered" : "many"]];
        return field.type === "Markdown" ? [[column, "markdown"]] : [];
      })),
      weight: 1 + members.length + Math.ceil(bytes.byteLength / 64),
    };
  });
  return { revision, source, tables, weight: tables.reduce((n, t) => n + t.weight, 0) };
}

/**
 * Compile the `schema.usl` of a single-table collection, stored as
 * `_store.*`: it must store exactly one table. Throws
 * {@link CollectionSchemaError}.
 */
export function compileCollectionSchema(input: Uint8Array | string): CollectionSchema {
  return singleTable(compileCollectionSchemas(input));
}

export function singleTable(set: CollectionSchemaSet): CollectionSchema {
  if (set.tables.length !== 1) {
    throw schemaFailure(
      "collection-tables",
      `A single-file collection's schema.usl stores one table; this one stores ${set.tables.map((t) => t.model).join(", ")}, so keep one file per table (\`<Table>.jsonl\`)`,
    );
  }
  return set.tables[0]!;
}
