// Row operations replayed on a collection's logical tables (spec 10 §4.1).

import {
  compareUTF8,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  logicalRowKey,
  ROW_TIME,
  stableJSONString,
  type CollectionRowReplay,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type RowOperation,
} from "@ovst/protocol";
import type { LogicalField, LogicalModel, LogicalTables } from "@ovst/usl";
import { encodeDirectoryCollection, loadDirectoryCollection, ProtocolCollectionError } from "./directory-collection.ts";
import type { LogicalSchema } from "./logical.ts";

function invalid(message: string): never {
  throw new Error(`Invalid row operation: ${message}`);
}

const json = (value: unknown) => stableJSONString(value ?? null);
const same = (left: unknown, right: unknown) => json(left) === json(right);
/** A row time in the logical form's precision: RFC 3339 UTC with milliseconds. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A set's members sorted by canonical JSON, each once. */
export function canonicalSet(values: readonly JSONValue[]): JSONValue[] {
  const byText = new Map(values.map((v) => [JSON.stringify(v), v]));
  return [...byText.keys()].sort(compareUTF8).map((k) => byText.get(k)!);
}

/** A many-valued field's value in canonical form: a set sorted, absent when empty. */
export function canonicalMany(field: Pick<LogicalField, "ordered">, values: readonly JSONValue[]): JSONValue[] | undefined {
  if (!values.length) return undefined;
  return field.ordered ? [...values] : canonicalSet(values);
}

type Rows = Map<string, LogicalRow | null>;

function fieldOf(model: LogicalModel, name: string): LogicalField {
  if (model.key.includes(name)) invalid("a key field is never set");
  if (name === "created" || name === "modified") invalid(`${name} is set only by an operation's time`);
  const field = model.fields.find((f) => f.name === name);
  if (!field) invalid(`${model.name} holds no field ${name}`);
  return field;
}

function setField(row: LogicalRow, field: LogicalField, value: JSONValue | undefined) {
  const next = value === undefined || value === null ? undefined
    : field.arity === "many" && Array.isArray(value) ? canonicalMany(field, value) : value;
  if (next === undefined) delete row.fields[field.name];
  else row.fields[field.name] = next;
}

/** Apply one operation to a model's rows by stable key, stamping its time. */
function applyRowOperation(model: LogicalModel, rows: Rows, operation: RowOperation) {
  const current = rows.get(operation.row);
  if (operation.kind === "rowDelete") {
    if (!current) invalid("row is absent");
    rows.set(operation.row, null);
    return;
  }
  const at = operation.at;
  if (at === undefined) invalid("an operation that changes a row carries its time");
  if (!ROW_TIME.test(at) || !TIME.test(at)) invalid("at is an RFC 3339 UTC time with milliseconds");
  if (operation.kind === "rowCreate") {
    if (current) invalid("row already exists");
    const key: LogicalRow["key"] = model.keyFields.map((f) => {
      const value = operation.values[f.name];
      if (value === undefined || value === null) invalid(`values have no key field ${f.name}`);
      return [f.name, value];
    });
    if (logicalRowKey({ key }) !== operation.row) invalid("values do not have the row's key");
    const row: LogicalRow = { key, fields: {}, created: at, modified: at };
    for (const [name, value] of Object.entries(operation.values)) {
      if (model.key.includes(name)) continue;
      setField(row, fieldOf(model, name), value);
    }
    rows.set(operation.row, row);
    return;
  }
  if (!current) invalid("row is absent");
  const field = fieldOf(model, operation.field);
  const row: LogicalRow = { ...current, fields: { ...current.fields }, modified: at };
  if (operation.kind === "rowSet") {
    if (!same(row.fields[field.name], operation.before)) invalid(`${field.name} does not have the value seen`);
    if (same(operation.before, operation.value)) invalid("rowSet changes nothing");
    setField(row, field, operation.value);
  } else {
    if (field.arity !== "many") invalid(`${field.name} is not many-valued`);
    const list = (row.fields[field.name] ?? []) as JSONValue[];
    const index = list.findIndex((item) => same(item, operation.member));
    if (operation.kind === "rowConnect") {
      if (index >= 0) invalid("member is already present");
      setField(row, field, [...list, operation.member]);
    } else {
      if (index < 0) invalid("member is absent");
      const rest = list.filter((_, i) => i !== index);
      if (operation.kind === "rowDisconnect") setField(row, field, rest);
      else if (operation.kind === "rowMove") {
        if (!field.ordered) invalid(`${field.name} is a set, so its members don't move`);
        const anchor = operation.after;
        const after = anchor === null ? -1 : rest.findIndex((item) => same(item, anchor));
        if (anchor !== null && after < 0) invalid("anchor member is absent");
        rest.splice(after + 1, 0, list[index]!);
        if (rest.every((item, i) => same(item, list[i]))) invalid("rowMove changes nothing");
        setField(row, field, rest);
      }
    }
  }
  rows.set(operation.row, row);
}

/**
 * A collection's tables after operations, in order. Each operation names a
 * model and a row by stable key, and its `at` stamps the row's times.
 * Exposed for merge, which applies one side's operations to another side's
 * rows. Throws for an operation its rows can't take.
 */
export function applyRowOperations(schema: LogicalSchema, tables: LogicalTables, operations: readonly RowOperation[]): LogicalTables {
  const byModel = new Map<string, Rows>();
  for (const operation of operations) {
    const model = schema.models.find((m) => m.name === operation.table);
    if (!model) invalid(`${operation.table} is not a model of this collection`);
    let rows = byModel.get(model.name);
    if (!rows) byModel.set(model.name, rows = new Map((tables[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow])));
    applyRowOperation(model, rows, operation);
  }
  const result: LogicalTables = { ...tables };
  for (const [model, rows] of byModel) {
    result[model] = [...rows.values()].filter((row): row is LogicalRow => row !== null).sort((a, b) => compareUTF8(logicalRowKey(a), logicalRowKey(b)));
  }
  return result;
}

/** The collection schema package's row replay (spec 10 §4.1): apply the
 * operations to the directory's logical tables, validate the result and
 * encode its tables. */
export const replayCollectionRows: CollectionRowReplay = async (directoryHash, operations, read) => {
  const directory = decodeProtocolDirectory(await read(directoryHash));
  let collection;
  try {
    collection = await loadDirectoryCollection(directory, read);
  } catch (error) {
    if (error instanceof ProtocolCollectionError) invalid(error.message);
    throw error;
  }
  if (!collection) invalid("the directory has no collection");
  const tables = applyRowOperations(collection.schema, collection.tables, operations);
  let encoded;
  try {
    encoded = await encodeDirectoryCollection(directory, tables, read);
  } catch (error) {
    if (error instanceof ProtocolCollectionError) invalid(error.message);
    throw error;
  }
  const generated = new Map<ObjectHash, Uint8Array>(encoded.objects);
  const bytes = encodeProtocolDirectory(encoded.directory);
  const hash = hashObject(bytes);
  generated.set(hash, bytes);
  return { directory: hash, generated };
};
