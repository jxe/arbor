// A logical collection as the tree holds it (spec 06 §2.1, 01 §1.1.2): a
// directory's `collection` reference names one table object per model with
// data rows, and each table lists its rows in content-defined chunks, each a
// `rows` object. Rows are in canonical stable-key order, so the same rows
// always give the same objects and the same logical hash, whatever file or
// database a placement projects them into.

import { canonicalCBORHash, decodeCanonicalCBOR, encodeCanonicalCBOR } from "./cbor.ts";
import type { Hash } from "./identifiers.ts";
import type { JSONValue } from "./node-model.ts";
import { compareUTF8 } from "./utf8.ts";

/** One row: its key as `[field, value]` pairs in key order, its other fields, and when accepted changes made and last changed it. */
export interface LogicalRow {
  key: [string, JSONValue][];
  fields: Record<string, JSONValue>;
  created: string;
  modified: string;
}

export interface ProtocolRows {
  type: "rows";
  rows: LogicalRow[];
}

export interface ProtocolTable {
  type: "table";
  /** The sum of its chunks' rows. */
  rows: number;
  chunks: { rows: number; chunk: Hash }[];
}

export interface CollectionReference {
  version: 1;
  modelFingerprint: Hash;
  /** One per model with data rows, in UTF-8 order of model. */
  tables: { model: string; table: Hash }[];
}

/** A chunk ends after a row once it holds `CHUNK_MIN` rows and the row's hash starts below `CHUNK_BOUNDARY`, or at `CHUNK_MAX` rows. */
export const CHUNK_MIN = 512;
export const CHUNK_MAX = 8192;
export const CHUNK_BOUNDARY = 128;

const HASH = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((k) => k in value)) throw new TypeError(`${label} must have exactly ${keys.join(", ")}`);
}

/** A row's stable key: the canonical JSON of its key pairs (spec 03 §2). */
export function logicalRowKey(row: Pick<LogicalRow, "key">): string {
  return JSON.stringify(row.key);
}

/** Canonical stable-key order (spec 06 §1.2). */
export function compareLogicalRows(a: Pick<LogicalRow, "key">, b: Pick<LogicalRow, "key">): number {
  return compareUTF8(logicalRowKey(a), logicalRowKey(b));
}

/** The canonical CBOR hash of a row, which places chunk boundaries. */
export function logicalRowHash(row: LogicalRow): Hash {
  return canonicalCBORHash(row);
}

function endsChunk(row: LogicalRow, size: number): boolean {
  if (size >= CHUNK_MAX) return true;
  if (size < CHUNK_MIN) return false;
  return Number.parseInt(logicalRowHash(row).slice(7, 11), 16) < CHUNK_BOUNDARY;
}

/** Splits rows, already in stable-key order, at the boundaries the chunk rule places. */
export function chunkLogicalRows(rows: LogicalRow[]): LogicalRow[][] {
  const chunks: LogicalRow[][] = [];
  let current: LogicalRow[] = [];
  for (const row of rows) {
    current.push(row);
    if (endsChunk(row, current.length)) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

function checkJSONValue(value: unknown, label: string, depth = 0): asserts value is JSONValue {
  if (depth > 32) throw new TypeError(`${label} nests too deep`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJSONValue(item, `${label}[${i}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) checkJSONValue(v, `${label}.${k}`, depth + 1);
    return;
  }
  throw new TypeError(`${label} is not a JSON value`);
}

/** Checks one row's shape (not its schema): key pairs, present fields, and timestamps. */
export function decodeLogicalRow(value: unknown, label = "row"): LogicalRow {
  if (!isRecord(value)) throw new TypeError(`${label} must be a map`);
  exactKeys(value, ["key", "fields", "created", "modified"], label);
  const { key, fields, created, modified } = value;
  if (!Array.isArray(key) || key.length === 0) throw new TypeError(`${label}.key must be a non-empty array`);
  const names = new Set<string>();
  for (const [i, pair] of key.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !NAME.test(pair[0])) {
      throw new TypeError(`${label}.key[${i}] must be a [field, value] pair`);
    }
    if (names.has(pair[0])) throw new TypeError(`${label}.key names ${pair[0]} twice`);
    names.add(pair[0]);
    if (pair[1] === null) throw new TypeError(`${label}.key[${i}] has no value`);
    checkJSONValue(pair[1], `${label}.key[${i}]`);
  }
  if (!isRecord(fields)) throw new TypeError(`${label}.fields must be a map`);
  for (const [name, field] of Object.entries(fields)) {
    if (!NAME.test(name)) throw new TypeError(`${label}.fields has an invalid name ${JSON.stringify(name)}`);
    if (names.has(name)) throw new TypeError(`${label}.fields repeats the key field ${name}`);
    if (field === null || (Array.isArray(field) && field.length === 0)) throw new TypeError(`${label}.fields.${name} is written only when it has a value`);
    checkJSONValue(field, `${label}.fields.${name}`);
  }
  for (const [name, time] of [["created", created], ["modified", modified]] as const) {
    if (typeof time !== "string" || !TIME.test(time) || Number.isNaN(Date.parse(time))) {
      throw new TypeError(`${label}.${name} must be an RFC 3339 UTC date-time with milliseconds`);
    }
  }
  return value as unknown as LogicalRow;
}

export function encodeProtocolRows(rows: LogicalRow[]): Uint8Array {
  return encodeCanonicalCBOR({ type: "rows", rows } satisfies ProtocolRows);
}

/** A `rows` object: canonical, each row well formed, and in stable-key order without a key twice. */
export function decodeProtocolRows(bytes: Uint8Array): ProtocolRows {
  const value = decodeCanonicalCBOR(bytes);
  if (!isRecord(value) || value.type !== "rows") throw new TypeError("Not a rows object");
  exactKeys(value, ["type", "rows"], "rows object");
  if (!Array.isArray(value.rows)) throw new TypeError("rows object rows must be an array");
  const rows = value.rows.map((row, i) => decodeLogicalRow(row, `rows[${i}]`));
  for (let i = 1; i < rows.length; i++) {
    if (compareLogicalRows(rows[i - 1]!, rows[i]!) >= 0) throw new TypeError("rows object rows must be in stable-key order, each key once");
  }
  return { type: "rows", rows };
}

export function encodeProtocolTable(table: ProtocolTable): Uint8Array {
  return encodeCanonicalCBOR(table);
}

export function decodeProtocolTable(bytes: Uint8Array): ProtocolTable {
  const value = decodeCanonicalCBOR(bytes);
  if (!isRecord(value) || value.type !== "table") throw new TypeError("Not a table object");
  exactKeys(value, ["type", "rows", "chunks"], "table object");
  if (!Number.isSafeInteger(value.rows) || (value.rows as number) < 0) throw new TypeError("table rows must be a count");
  if (!Array.isArray(value.chunks) || value.chunks.length === 0) throw new TypeError("table chunks must be a non-empty array");
  let total = 0;
  const chunks = value.chunks.map((chunk, i) => {
    if (!isRecord(chunk)) throw new TypeError(`table chunks[${i}] must be a map`);
    exactKeys(chunk, ["rows", "chunk"], `table chunks[${i}]`);
    if (!Number.isSafeInteger(chunk.rows) || (chunk.rows as number) < 0) throw new TypeError(`table chunks[${i}].rows must be a count`);
    if (typeof chunk.chunk !== "string" || !HASH.test(chunk.chunk)) throw new TypeError(`table chunks[${i}].chunk must be a hash`);
    total += chunk.rows as number;
    return { rows: chunk.rows as number, chunk: chunk.chunk as Hash };
  });
  if (total !== value.rows) throw new TypeError("table rows must equal the sum of its chunks'");
  return { type: "table", rows: total, chunks };
}

/** The table and rows objects that hold `rows`, which are sorted and checked here. */
export function encodeLogicalTable(rows: LogicalRow[]): { hash: Hash; table: ProtocolTable; objects: Map<Hash, Uint8Array> } {
  const sorted = [...rows].sort(compareLogicalRows);
  for (let i = 1; i < sorted.length; i++) {
    if (compareLogicalRows(sorted[i - 1]!, sorted[i]!) === 0) throw new TypeError(`Two rows have the key ${logicalRowKey(sorted[i]!)}`);
  }
  const objects = new Map<Hash, Uint8Array>();
  const chunks = chunkLogicalRows(sorted).map((chunk) => {
    const bytes = encodeProtocolRows(chunk);
    const hash = canonicalCBORHash({ type: "rows", rows: chunk });
    objects.set(hash, bytes);
    return { rows: chunk.length, chunk: hash };
  });
  const table: ProtocolTable = { type: "table", rows: sorted.length, chunks };
  const hash = canonicalCBORHash(table);
  objects.set(hash, encodeProtocolTable(table));
  return { hash, table, objects };
}

/**
 * A table's rows, loaded through `load` (which returns an object's bytes by
 * hash, verified). Requires each chunk to hold its stated rows, the chunks to
 * continue one another's order, and every chunk to end where the rule ends it.
 */
export async function loadLogicalTable(hash: Hash, load: (hash: Hash) => Promise<Uint8Array>): Promise<LogicalRow[]> {
  const table = decodeProtocolTable(await load(hash));
  const rows: LogicalRow[] = [];
  for (const [i, { rows: count, chunk }] of table.chunks.entries()) {
    const part = decodeProtocolRows(await load(chunk)).rows;
    if (part.length !== count) throw new TypeError(`table chunk ${i} holds ${part.length} rows, not ${count}`);
    if (rows.length > 0 && part.length > 0 && compareLogicalRows(rows[rows.length - 1]!, part[0]!) >= 0) {
      throw new TypeError(`table chunk ${i} doesn't continue the stable-key order`);
    }
    const last = i === table.chunks.length - 1;
    if (part.length === 0 && !(last && table.chunks.length === 1)) throw new TypeError(`table chunk ${i} is empty`);
    part.forEach((row, j) => {
      const ends = endsChunk(row, j + 1);
      if (ends && j !== part.length - 1) throw new TypeError(`table chunk ${i} continues past a chunk boundary`);
      if (!ends && j === part.length - 1 && !last) throw new TypeError(`table chunk ${i} ends before a chunk boundary`);
    });
    rows.push(...part);
  }
  return rows;
}

export function decodeCollectionReference(value: unknown): CollectionReference {
  if (!isRecord(value)) throw new TypeError("collection must be a map");
  exactKeys(value, ["version", "modelFingerprint", "tables"], "collection");
  if (value.version !== 1) throw new TypeError("collection.version must be 1");
  if (typeof value.modelFingerprint !== "string" || !HASH.test(value.modelFingerprint)) throw new TypeError("collection.modelFingerprint must be a hash");
  if (!Array.isArray(value.tables)) throw new TypeError("collection.tables must be an array");
  let previous: string | undefined;
  const tables = value.tables.map((entry, i) => {
    if (!isRecord(entry)) throw new TypeError(`collection.tables[${i}] must be a map`);
    exactKeys(entry, ["model", "table"], `collection.tables[${i}]`);
    if (typeof entry.model !== "string" || !NAME.test(entry.model)) throw new TypeError(`collection.tables[${i}].model must be a model name`);
    if (typeof entry.table !== "string" || !HASH.test(entry.table)) throw new TypeError(`collection.tables[${i}].table must be a hash`);
    if (previous !== undefined && compareUTF8(previous, entry.model) >= 0) throw new TypeError("collection.tables must be in UTF-8 order of model, each once");
    previous = entry.model;
    return { model: entry.model, table: entry.table as Hash };
  });
  return { version: 1, modelFingerprint: value.modelFingerprint as Hash, tables };
}

/** The collection's logical hash: what it contributes to its folder's model hash, the same at every placement. */
export function collectionLogicalHash(reference: CollectionReference): Hash {
  return canonicalCBORHash(reference);
}
