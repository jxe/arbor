import { parse as parseCSV } from "csv-parse/sync";
import {
  compareUTF8,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  stableJSONString,
  stableKeyFromProperties,
  type CollectionRowReplay,
  type JSONValue,
  type ObjectHash,
  type RowMember,
  type RowOperation,
} from "@ovst/protocol";
import { sharedCollectionSchemaCache } from "./cache.ts";
import type { CollectionSchema } from "./compile.ts";
import { collectionFileRows, ProtocolCollectionFileError, type CollectionFileFormat } from "./collection-file.ts";
import { CsvEncodeError, encodeCsvRecord } from "./csv.ts";
import { CollectionSchemaError } from "./diagnostics.ts";

type Row = Record<string, JSONValue>;
/** A changed row: `null` deletes it. Rows are named by their source position key. */
export interface CollectionRowSplice {
  replaced: ReadonlyMap<string, Row | null>;
  appended: readonly Row[];
}

function invalid(message: string): never {
  throw new Error(`Invalid row operation: ${message}`);
}

/** A touched row's canonical member order: the schema's columns in layout
 * order, then undeclared members by UTF-8 name. Values are kept exactly. */
export function canonicalRow(schema: Pick<CollectionSchema, "columns">, properties: Readonly<Row>): Row {
  const declared = schema.columns.filter((name) => Object.hasOwn(properties, name));
  const extra = Object.keys(properties).filter((name) => !schema.columns.includes(name)).sort(compareUTF8);
  return Object.fromEntries([...declared, ...extra].map((name) => [name, properties[name]!]));
}

interface Line { number: number; start: number; contentEnd: number; end: number }

function physicalLines(source: string): Line[] {
  const result: Line[] = [];
  let start = 0, number = 1;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "\r" && source[index] !== "\n") continue;
    const contentEnd = index;
    if (source[index] === "\r" && source[index + 1] === "\n") index++;
    result.push({ number, start, contentEnd, end: index + 1 });
    start = index + 1;
    number++;
  }
  if (start < source.length) result.push({ number, start, contentEnd: source.length, end: source.length });
  return result;
}

function spliceJSONL(source: string, splice: CollectionRowSplice): string {
  let output = "", cursor = 0;
  for (const line of physicalLines(source)) {
    const key = `line:${line.number}`;
    if (!splice.replaced.has(key)) continue;
    output += source.slice(cursor, line.start);
    const row = splice.replaced.get(key)!;
    if (row) {
      const content = source.slice(line.start, line.contentEnd);
      const leading = content.match(/^\s*/)![0], trailing = content.match(/\s*$/)![0];
      output += `${leading}${JSON.stringify(row)}${trailing}${source.slice(line.contentEnd, line.end)}`;
    }
    cursor = line.end;
  }
  output += source.slice(cursor);
  if (splice.appended.length && output && !/[\r\n]$/.test(output)) output += "\n";
  for (const row of splice.appended) output += `${JSON.stringify(row)}\n`;
  return output;
}

function scanJSONString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === '"') return index + 1;
    index++;
  }
  throw new ProtocolCollectionFileError("source", "Unterminated JSON string");
}

function scanJSONValue(source: string, start: number): number {
  if (source[start] === '"') return scanJSONString(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start] === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < source.length && stack.length) {
      const character = source[index]!;
      if (character === '"') { index = scanJSONString(source, index); continue; }
      if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === stack.at(-1)) stack.pop();
      index++;
    }
    return index;
  }
  let index = start;
  while (index < source.length && !/[,\]\s]/.test(source[index]!)) index++;
  return index;
}

/** The top-level array's item spans, and where its brackets are. */
function jsonArray(source: string): { open: number; close: number; items: Array<{ start: number; end: number }> } {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  whitespace();
  const open = index;
  if (source[index] !== "[") throw new ProtocolCollectionFileError("source", "_store.json must contain one top-level array");
  index++;
  const items: Array<{ start: number; end: number }> = [];
  for (;;) {
    whitespace();
    if (source[index] === "]") break;
    const start = index, end = scanJSONValue(source, start);
    items.push({ start, end });
    index = end;
    whitespace();
    if (source[index] === ",") { index++; continue; }
    if (source[index] !== "]") throw new ProtocolCollectionFileError("source", "Invalid top-level JSON array");
  }
  return { open, close: index, items };
}

function spliceJSON(source: string, splice: CollectionRowSplice): string {
  const { open, close, items } = jsonArray(source);
  const removes = [...splice.replaced.values()].some((row) => row === null);
  if (!removes && !splice.appended.length) {
    let output = "", cursor = 0;
    items.forEach((item, index) => {
      const row = splice.replaced.get(`item:${index}`);
      if (row === undefined) return;
      output += source.slice(cursor, item.start) + JSON.stringify(row);
      cursor = item.end;
    });
    return output + source.slice(cursor);
  }
  // Removing or adding an item re-joins the array with the separator its
  // first two items use (or the default two-space layout).
  const texts: string[] = [];
  items.forEach((item, index) => {
    const row = splice.replaced.get(`item:${index}`);
    if (row === null) return;
    texts.push(row === undefined ? source.slice(item.start, item.end) : JSON.stringify(row));
  });
  texts.push(...splice.appended.map((row) => JSON.stringify(row)));
  const opening = items.length ? source.slice(open + 1, items[0]!.start) : "\n  ";
  const separator = items.length > 1 ? source.slice(items[0]!.end, items[1]!.start) : `,${opening}`;
  const closing = items.length ? source.slice(items.at(-1)!.end, close) : "\n";
  const body = texts.length ? `${opening}${texts.join(separator)}${closing}` : "";
  return `${source.slice(0, open)}[${body}${source.slice(close)}`;
}

interface RawRecord { record: string[]; raw: string }

function spliceCSV(source: string, schema: CollectionSchema, splice: CollectionRowSplice): string {
  const parsed = parseCSV(source, { bom: true, raw: true, info: true, relax_column_count: true, skip_empty_lines: true }) as unknown as RawRecord[];
  const header = parsed[0]?.record ?? [];
  const encode = (row: Row) => {
    try {
      return encodeCsvRecord(schema, header, row);
    } catch (error) {
      if (error instanceof CsvEncodeError) throw new ProtocolCollectionFileError("constraint", error.message);
      throw error;
    }
  };
  let output = "", cursor = 0;
  for (const [index, record] of parsed.entries()) {
    const start = source.indexOf(record.raw, cursor);
    if (start < 0) throw new ProtocolCollectionFileError("source", "Could not locate the exact CSV record source");
    const end = start + record.raw.length;
    const key = `row:${index + 1}`;
    if (index > 0 && splice.replaced.has(key)) {
      const row = splice.replaced.get(key)!;
      const ending = record.raw.match(/(\r\n|\n|\r)$/)?.[0] ?? "";
      output += source.slice(cursor, start) + (row ? `${encode(row)}${ending}` : "");
    } else output += source.slice(cursor, end);
    cursor = end;
  }
  output += source.slice(cursor);
  if (splice.appended.length && output && !/[\r\n]$/.test(output)) output += "\n";
  for (const row of splice.appended) output += `${encode(row)}\n`;
  return output;
}

/** Splice changed rows into exact collection-file text: untouched rows keep
 * their bytes, a changed row is re-encoded in place, a deleted one is removed
 * with its line ending, and new rows are appended in order. */
export function spliceCollectionFile(
  format: CollectionFileFormat,
  source: string,
  schema: CollectionSchema,
  splice: CollectionRowSplice,
): string {
  if (format === "jsonl") return spliceJSONL(source, splice);
  if (format === "json") return spliceJSON(source, splice);
  return spliceCSV(source, schema, splice);
}

const same = (left: JSONValue | undefined, right: JSONValue | undefined) => stableJSONString(left ?? null) === stableJSONString(right ?? null);

function members(row: Row, field: string): JSONValue[] {
  const value = row[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`${field} is not many-valued`);
  return value;
}

function setMembers(row: Row, field: string, value: JSONValue[]) {
  if (value.length) row[field] = value;
  else delete row[field];
}

/** Apply one row operation to the decoded rows by stable key. */
function applyRowOperation(schema: CollectionSchema, rows: Map<string, Row | null>, operation: RowOperation) {
  if (operation.table !== schema.model) invalid(`table ${operation.table} is not in this collection`);
  const current = rows.get(operation.row);
  if (operation.kind === "rowCreate") {
    if (current) invalid("row already exists");
    if (stableKeyFromProperties(schema.primaryKey, operation.values) !== operation.row) invalid("values do not have the row's key");
    rows.set(operation.row, canonicalRow(schema, operation.values));
    return;
  }
  if (!current) invalid("row is absent");
  if (operation.kind === "rowDelete") { rows.set(operation.row, null); return; }
  if (schema.primaryKey.includes(operation.field)) invalid("a key field is never set");
  const row = { ...current };
  if (operation.kind === "rowSet") {
    if (!same(row[operation.field], operation.before)) invalid(`${operation.field} does not have the value seen`);
    if (same(operation.before, operation.value)) invalid("rowSet changes nothing");
    if (operation.value === null) delete row[operation.field];
    else row[operation.field] = operation.value;
  } else {
    const list = members(row, operation.field);
    const at = (member: RowMember) => list.findIndex((item) => same(item, member));
    const index = at(operation.member);
    if (operation.kind === "rowConnect") {
      if (index >= 0) invalid("member is already present");
      setMembers(row, operation.field, [...list, operation.member]);
    } else {
      if (index < 0) invalid("member is absent");
      const rest = list.filter((_, i) => i !== index);
      if (operation.kind !== "rowMove") setMembers(row, operation.field, rest);
      else {
        const anchor = operation.after;
        const after = anchor === null ? -1 : rest.findIndex((item) => same(item, anchor));
        if (anchor !== null && after < 0) invalid("anchor member is absent");
        rest.splice(after + 1, 0, list[index]!);
        if (rest.every((item, i) => same(item, list[i]))) invalid("rowMove changes nothing");
        setMembers(row, operation.field, rest);
      }
    }
  }
  rows.set(operation.row, canonicalRow(schema, row));
}

/** Rows of a collection after operations: the result `rowsAfter` and the
 * splice that writes it. Exposed for merge, which applies one side's
 * operations to another side's rows. */
export function applyRowOperations(
  schema: CollectionSchema,
  basis: ReadonlyArray<{ stableKey: string; sourceKey: string; properties: Row }>,
  operations: readonly RowOperation[],
): CollectionRowSplice & { rows: Map<string, Row | null> } {
  const rows = new Map<string, Row | null>(basis.map((row) => [row.stableKey, row.properties]));
  for (const operation of operations) applyRowOperation(schema, rows, operation);
  const known = new Set(basis.map((row) => row.stableKey));
  const replaced = new Map<string, Row | null>();
  for (const row of basis) {
    const next = rows.get(row.stableKey)!;
    if (next === null || stableJSONString(next) !== stableJSONString(row.properties)) replaced.set(row.sourceKey, next);
  }
  const appended = [...rows].filter(([key, row]) => !known.has(key) && row !== null).map(([, row]) => row!);
  return { replaced, appended, rows };
}

/** The collection schema package's row replay (spec 10 §4.1): validate the
 * basis collection, apply the operations, splice the representation and
 * re-derive the descriptor's child-set hash. */
export const replayCollectionRows: CollectionRowReplay = async (directoryHash, operations, read) => {
  const directory = decodeProtocolDirectory(await read(directoryHash));
  const descriptor = directory.childrenSource;
  if (!descriptor) invalid("collection directory has no collection file");
  const sourceEntry = directory.entries.find((entry) => entry.name === descriptor.source);
  const schemaEntry = directory.entries.find((entry) => entry.name === descriptor.schemaSource);
  if (!sourceEntry?.file || !schemaEntry?.file) invalid("collection file is missing");
  let schema: CollectionSchema;
  try {
    schema = sharedCollectionSchemaCache.compile(await read(schemaEntry.file));
  } catch (error) {
    if (error instanceof CollectionSchemaError) invalid(`schema.usl: ${error.message}`);
    throw error;
  }
  if (schema.revision !== descriptor.schemaFingerprint) invalid("schema fingerprint does not match schema.usl");
  const sourceBytes = await read(sourceEntry.file);
  const basis = collectionFileRows(descriptor.format, sourceBytes, schema);
  if (basis.childSetHash !== descriptor.childSetHash) invalid("child-set hash does not match the basis rows");
  const splice = applyRowOperations(schema, basis.rows, operations);
  const text = spliceCollectionFile(descriptor.format, new TextDecoder().decode(sourceBytes), schema, splice);
  const bytes = new TextEncoder().encode(text);
  const result = collectionFileRows(descriptor.format, bytes, schema);
  const expected = [...splice.rows].filter(([, row]) => row !== null);
  const written = new Map(result.rows.map((row) => [row.stableKey, row.properties]));
  if (written.size !== expected.length || expected.some(([key, row]) => stableJSONString(written.get(key) ?? null) !== stableJSONString(row)))
    throw new ProtocolCollectionFileError("source", "Collection file does not re-read as the rows written");
  const generated = new Map<ObjectHash, Uint8Array>();
  const source = hashObject(bytes);
  generated.set(source, bytes);
  const next = encodeProtocolDirectory({
    ...directory,
    entries: directory.entries.map((entry) => entry.name === descriptor.source ? { name: entry.name, file: source } : entry),
    childrenSource: { ...descriptor, childSetHash: result.childSetHash },
  });
  const hash = hashObject(next);
  generated.set(hash, next);
  return { directory: hash, generated };
};
