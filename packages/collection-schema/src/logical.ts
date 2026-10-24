// A collection's logical tables (spec 06 §2): compiling a schema to the
// models whose rows the tree holds, validating rows against them (§2.5), and
// encoding and loading the `collection` reference that holds them (§2.1).

import {
  canonicalCBORHash,
  collectionLogicalHash,
  compareUTF8,
  decodeCollectionReference,
  encodeLogicalTable,
  loadLogicalTable,
  logicalRowKey,
  revisionOf,
  type CollectionReference,
  type Hash,
  type LogicalRow,
} from "@ovst/protocol";
import { compileUsl, isPersonValue, logicalModels, modelLayer, type CheckResult, type LogicalField, type LogicalModel, type LogicalTables } from "@ovst/usl";
import { COLLECTION_SCHEMA_LIMITS, CollectionSchemaError, pointer, type ValueDiagnostic } from "./diagnostics.ts";
import { decodeSchemaSource } from "./compile.ts";

/** A compiled schema's logical side: the models whose rows the tree holds. */
export interface LogicalSchema {
  /** SHA-256 of the exact source bytes. */
  readonly revision: Hash;
  readonly source: string;
  readonly result: CheckResult;
  /** In UTF-8 order of name: the order of the reference's tables. */
  readonly models: readonly LogicalModel[];
  /** The model fingerprint (spec 11 §9): the canonical CBOR hash of the model layer. */
  readonly fingerprint: Hash;
  /** Proportional to the schema's size, so caches weigh entries by it. */
  readonly weight: number;
}

/** A diagnostic on one row of one model. */
export interface LogicalDiagnostic extends ValueDiagnostic {
  model: string;
  /** The row's stable key. */
  row: string;
}

export class LogicalCollectionError extends Error {
  constructor(readonly diagnostics: readonly LogicalDiagnostic[]) {
    const first = diagnostics[0];
    super(first ? `${first.model} ${first.row}${first.path}: ${first.code}: ${first.message}` : "Invalid collection rows");
    this.name = "LogicalCollectionError";
  }
}

/** Compile a collection's `schema.usl` to its logical models. Throws {@link CollectionSchemaError}. */
export function compileLogicalSchema(input: Uint8Array | string): LogicalSchema {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const source = decodeSchemaSource(bytes);
  const result = compileUsl(source);
  if (result.diagnostics.length > 0) {
    throw new CollectionSchemaError(result.diagnostics.map((d) => ({ code: d.code, message: d.message, location: { line: d.line, column: d.column } })));
  }
  return {
    revision: revisionOf(bytes) as Hash,
    source,
    result,
    models: logicalModels(result),
    fingerprint: canonicalCBORHash(modelLayer(result)),
    weight: 1 + result.models.reduce((n, m) => n + m.fields.length, 0) + Math.ceil(bytes.byteLength / 64),
  };
}

const MAX_DIAGNOSTICS = 32;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

class BudgetExceeded extends Error {
  constructor(readonly limit: "row-steps" | "collection-steps") { super(limit); }
}

type Value = LogicalRow["fields"][string];
const wellFormed = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed();
const canonicalText = (v: Value) => JSON.stringify(v);

class Validator {
  readonly diagnostics: LogicalDiagnostic[] = [];
  readonly models: Map<string, LogicalModel>;
  /** Each model's row keys, by the canonical JSON of the key value a reference holds. */
  readonly keys = new Map<string, Set<string>>();
  readonly enums = new Map<string, Set<string>>();
  rowSteps = 0;
  collectionSteps = COLLECTION_SCHEMA_LIMITS["collection-steps"];
  model = "";
  row = "";

  constructor(readonly schema: LogicalSchema, tables: LogicalTables) {
    this.models = new Map(schema.models.map((m) => [m.name, m]));
    for (const m of schema.result.models) if (m.rows === "fixed") this.enums.set(m.name, new Set(m.schemaRows.map((r) => r.name)));
    for (const model of schema.models) {
      this.keys.set(model.name, new Set((tables[model.name] ?? []).map((r) => canonicalText(referenceTo(model, r)))));
    }
  }

  step() {
    if (++this.rowSteps > COLLECTION_SCHEMA_LIMITS["row-steps"]) throw new BudgetExceeded("row-steps");
    if (--this.collectionSteps < 0) throw new BudgetExceeded("collection-steps");
  }

  report(code: string, path: string, message: string): false {
    if (this.diagnostics.length < MAX_DIAGNOSTICS) {
      this.diagnostics.push({ model: this.model, row: this.row, code: code as ValueDiagnostic["code"], path, message });
    }
    return false;
  }

  /** One value of `field` (one member, for a many-valued field). */
  one(field: LogicalField, value: Value, path: string): boolean {
    this.step();
    if (field.kind === "value") {
      switch (field.type) {
        case "Text":
        case "Markdown":
          if (typeof value !== "string") return this.report("type-mismatch", path, "Expected text");
          return wellFormed(value) || this.report("invalid-text", path, "Text contains an unpaired surrogate");
        case "Int":
          return (typeof value === "number" && Number.isSafeInteger(value)) || this.report("type-mismatch", path, "Expected an integer within ±(2^53 − 1)");
        case "Number":
          return (typeof value === "number" && Number.isFinite(value)) || this.report("type-mismatch", path, "Expected a finite number");
        case "Bool":
          return typeof value === "boolean" || this.report("type-mismatch", path, "Expected a boolean");
        case "Date":
          return (typeof value === "string" && (DATE.test(value) || DATE_TIME.test(value)) && !Number.isNaN(Date.parse(value)))
            || this.report("type-mismatch", path, "Expected YYYY-MM-DD or an RFC 3339 date-time in UTC");
      }
    }
    if (field.type === "Person") {
      return isPersonValue(value) || this.report("type-mismatch", path, "Expected a profile id or contact:<key>");
    }
    const choices = this.enums.get(field.type);
    if (choices) {
      return (typeof value === "string" && choices.has(value))
        || this.report("no-matching-choice", path, `Expected one of ${[...choices].map((v) => JSON.stringify(v)).join(", ")}`);
    }
    const target = this.models.get(field.type)!;
    if (!this.keyValue(target, value, path)) return false;
    return this.keys.get(target.name)!.has(canonicalText(value))
      || this.report("unknown-row", path, `No ${target.name} row has the key ${canonicalText(value)}`);
  }

  /** A reference's shape: the key field's value, or the key's pairs. */
  keyValue(target: LogicalModel, value: Value, path: string): boolean {
    if (target.keyFields.length === 1) return this.one(target.keyFields[0]!, value, path);
    if (!Array.isArray(value) || value.length !== target.keyFields.length) {
      return this.report("type-mismatch", path, `Expected the key pairs of a ${target.name} row`);
    }
    return target.keyFields.every((key, i) => {
      const pair = value[i];
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== key.name) return this.report("type-mismatch", pointer(path, i), `Expected the pair for ${key.name}`);
      return this.one(key, pair[1]!, pointer(pointer(path, i), 1));
    });
  }

  field(field: LogicalField, value: Value, path: string): boolean {
    if (field.arity !== "many") return this.one(field, value, path);
    if (!Array.isArray(value)) return this.report("type-mismatch", path, "Expected an array");
    if (value.length === 0) return this.report("type-mismatch", path, "An empty array is absent, not empty");
    let valid = true;
    for (const [i, member] of value.entries()) valid = this.one(field, member, pointer(path, i)) && valid;
    if (!valid) return false;
    const texts = value.map(canonicalText);
    if (field.ordered || field.kind === "members") {
      if (new Set(texts).size !== texts.length) return this.report("type-mismatch", path, "A member appears twice");
    }
    if (!field.ordered) {
      for (let i = 1; i < texts.length; i++) {
        if (compareUTF8(texts[i - 1]!, texts[i]!) >= 0) return this.report("type-mismatch", path, "A set is sorted by canonical JSON, each member once");
      }
    }
    return true;
  }

  row_(model: LogicalModel, row: LogicalRow) {
    this.model = model.name;
    this.row = logicalRowKey(row);
    this.rowSteps = 0;
    if (row.key.length !== model.keyFields.length) {
      this.report("type-mismatch", "/key", `Expected the key ${model.key.join(", ")}`);
    } else {
      model.keyFields.forEach((key, i) => {
        const pair = row.key[i]!;
        if (pair[0] !== key.name) this.report("type-mismatch", `/key/${i}/0`, `Expected the key field ${key.name}`);
        else this.one(key, pair[1], `/key/${i}/1`);
      });
    }
    const declared = new Map(model.fields.map((f) => [f.name, f]));
    for (const field of model.fields) {
      this.step();
      const path = pointer("/fields", field.name);
      if (!Object.hasOwn(row.fields, field.name)) {
        if (field.arity === "one") this.report("missing-member", path, `Missing required field ${JSON.stringify(field.name)}`);
        continue;
      }
      this.field(field, row.fields[field.name]!, path);
    }
    for (const name of Object.keys(row.fields)) {
      this.step();
      if (!declared.has(name)) this.report("unknown-member", pointer("/fields", name), `Field ${JSON.stringify(name)} is not declared`);
    }
  }
}

/** What a reference to `row` holds: its key field's value, or its key's pairs. */
function referenceTo(model: LogicalModel, row: Pick<LogicalRow, "key">): Value {
  return model.keyFields.length === 1 ? row.key[0]?.[1] ?? null : row.key;
}

/**
 * Validate logical tables against the schema (spec 06 §2.5): every row's
 * key, types and arity, required fields, references to existing rows and
 * enum values, and `unique` fields. Diagnostics follow model, row and field
 * order. Rows are expected in stable-key order with each key once.
 */
export function checkLogicalTables(schema: LogicalSchema, tables: LogicalTables): LogicalDiagnostic[] {
  const v = new Validator(schema, tables);
  const fail = (model: string, message: string) => [{ model, row: "", code: "unknown-member" as const, path: "", message }];
  for (const name of Object.keys(tables)) if (!v.models.has(name)) return fail(name, `The schema has no model ${name} with data rows`);
  try {
    for (const model of schema.models) {
      const rows = (tables[model.name] ?? []) as LogicalRow[];
      const unique = model.fields.filter((f) => f.unique).map((f) => ({ field: f, seen: new Map<string, string>() }));
      for (const row of rows) {
        v.row_(model, row);
        for (const { field, seen } of unique) {
          if (!Object.hasOwn(row.fields, field.name)) continue;
          const text = canonicalText(row.fields[field.name]!);
          const other = seen.get(text);
          if (other !== undefined) v.report("duplicate-value", pointer("/fields", field.name), `The row ${other} has the same ${field.name}`);
          else seen.set(text, v.row);
        }
        if (v.diagnostics.length >= MAX_DIAGNOSTICS) return v.diagnostics;
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    v.diagnostics.push({
      model: v.model,
      row: v.row,
      code: "budget-exceeded",
      path: "",
      limit: error.limit,
      message: error.limit === "row-steps" ? "Validating the row exceeds its step budget" : "Validating the collection exceeds its step budget",
    });
  }
  return v.diagnostics;
}

export interface EncodedCollection {
  reference: CollectionReference;
  /** The canonical CBOR hash of the reference. */
  logicalHash: Hash;
  /** Every table and rows object, by hash. */
  objects: Map<Hash, Uint8Array>;
}

/**
 * Encode valid tables as the tree holds them: one table per logical model,
 * empty ones included, in model order. Rows may come in any order. Throws
 * {@link LogicalCollectionError} for rows the schema rejects.
 */
export function encodeCollection(schema: LogicalSchema, tables: LogicalTables): EncodedCollection {
  const sorted: LogicalTables = {};
  for (const [name, rows] of Object.entries(tables)) sorted[name] = [...rows].sort((a, b) => compareUTF8(logicalRowKey(a), logicalRowKey(b)));
  const diagnostics = checkLogicalTables(schema, sorted);
  if (diagnostics.length > 0) throw new LogicalCollectionError(diagnostics);
  const objects = new Map<Hash, Uint8Array>();
  const encoded = schema.models.map((model) => {
    const table = encodeLogicalTable((sorted[model.name] ?? []) as LogicalRow[]);
    for (const [hash, bytes] of table.objects) objects.set(hash, bytes);
    return { model: model.name, table: table.hash };
  });
  const reference: CollectionReference = { version: 1, modelFingerprint: schema.fingerprint, tables: encoded };
  return { reference, logicalHash: collectionLogicalHash(reference), objects };
}

/**
 * Load and validate a `collection` reference against the folder's schema,
 * steps 1–4 of spec 06 §2.1, `schema` being the folder's compiled schema.usl. `load` returns an
 * object's verified bytes by hash. Throws a `TypeError` for a malformed
 * reference or object, and {@link LogicalCollectionError} for rows the
 * schema rejects.
 */
export async function loadCollection(
  schema: LogicalSchema,
  value: unknown,
  load: (hash: Hash) => Promise<Uint8Array>,
): Promise<{ reference: CollectionReference; logicalHash: Hash; tables: LogicalTables }> {
  const reference = decodeCollectionReference(value);
  if (reference.modelFingerprint !== schema.fingerprint) throw new TypeError("collection.modelFingerprint doesn't match the folder's schema.usl");
  const names = reference.tables.map((t) => t.model);
  const expected = schema.models.map((m) => m.name);
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    throw new TypeError(`collection.tables must name ${expected.join(", ") || "no models"}, in order`);
  }
  const tables: LogicalTables = {};
  for (const { model, table } of reference.tables) tables[model] = await loadLogicalTable(table, load);
  const diagnostics = checkLogicalTables(schema, tables);
  if (diagnostics.length > 0) throw new LogicalCollectionError(diagnostics);
  return { reference, logicalHash: collectionLogicalHash(reference), tables };
}
