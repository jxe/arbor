// A logical collection as the tree holds it (collections §1, data model §5): a directory's
// `collection` reference names the head of the collection's log. Each entry names the one
// before it and holds either the rows one accepted update changed (each changed row's whole
// new form, or its removal) or a snapshot: a SQLite file the tree's host wrote, holding every
// row. Every entry carries the row count and the rows hash after it (LtHash16 over each row's
// canonical CBOR), so the same rows give the same logical hash, whatever history led there
// and however a placement holds them.

import { CBORTag, canonicalCBORHash, decodeCanonicalCBOR, encodeCanonicalCBOR } from "./cbor.ts";
import { isPageTimestamp as isRowDate } from "../pages.ts";
import type { Hash } from "./identifiers.ts";
import type { JSONValue } from "./node-model.ts";
import { compareUTF8 } from "./utf8.ts";
import { sha256 } from "./hash.ts";

/** One row: its key as `[field, value]` pairs in key order, its other fields, and when accepted changes made and last changed it. */
export interface LogicalRow {
  key: [string, JSONValue][];
  fields: Record<string, JSONValue>;
  /** Unix milliseconds in UTC, like a file or page entry's times (collections §2). */
  created: number;
  modified: number;
}

/** One row an accepted update changed: its whole new form, or `null` when it was removed. */
export interface RowChange {
  model: string;
  key: [string, JSONValue][];
  row: LogicalRow | null;
}

interface LogEntryHead {
  type: "log";
  /** The entry before this one; null only for a log's first entry. */
  previous: Hash | null;
  /** The row count after this entry. */
  rows: number;
  /** The rows hash after this entry. */
  rowsHash: Hash;
}

/** A log entry: one accepted update's row changes, or a snapshot file of every row. */
export type ProtocolLog =
  | (LogEntryHead & { changes: RowChange[] })
  | (LogEntryHead & { snapshot: Hash });

export interface CollectionReference {
  version: 2;
  modelFingerprint: Hash;
  /** The log's head entry. */
  log: Hash;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((k) => k in value)) throw new TypeError(`${label} must have exactly ${keys.join(", ")}`);
}

/** A row's stable key: the canonical JSON of its key pairs (spec 03 §2). */
export function logicalRowKey(row: Pick<LogicalRow, "key">): string {
  // A Date key field is tagged in a rows object; its key JSON is the plain text.
  return JSON.stringify(row.key, (_name, value) => value instanceof CBORTag ? value.value : value);
}

/** Canonical stable-key order (spec 06 §1.2). */
export function compareLogicalRows(a: Pick<LogicalRow, "key">, b: Pick<LogicalRow, "key">): number {
  return compareUTF8(logicalRowKey(a), logicalRowKey(b));
}

/**
 * A row's canonical CBOR bytes and hash. Rows a loaded collection holds are deeply frozen
 * and shared, so theirs are kept: comparing two states of a collection encodes only the rows
 * that aren't the same objects.
 */
const encodedRows = new WeakMap<LogicalRow, { bytes: Uint8Array; hash: Hash }>();
export function encodedRow(row: LogicalRow): { bytes: Uint8Array; hash: Hash } {
  const cached = encodedRows.get(row);
  if (cached) return cached;
  const bytes = encodeCanonicalCBOR(row);
  const encoded = { bytes, hash: `sha256:${sha256(bytes)}` as Hash };
  if (Object.isFrozen(row)) encodedRows.set(row, encoded);
  return encoded;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function checkJSONValue(value: unknown, label: string, depth = 0): asserts value is JSONValue {
  if (depth > 32) throw new TypeError(`${label} nests too deep`);
  // A Date field's value: tag 1004 around a date, tag 0 around a UTC date-time (collections §2).
  if (value instanceof CBORTag) {
    if (!isRowDate(value)) throw new TypeError(`${label} is not a date or a UTC date-time`);
    return;
  }
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
    if (typeof time !== "number" || !Number.isSafeInteger(time)) throw new TypeError(`${label}.${name} must be Unix milliseconds`);
  }
  if ((created as number) > (modified as number)) throw new TypeError(`${label}.created is later than its modified`);
  return value as unknown as LogicalRow;
}

/** The bytes a row adds to its collection's rows hash: the canonical CBOR of `[model, row]`. */
export function rowHashElement(model: string, row: LogicalRow): Uint8Array {
  const own = encodedRow(row).bytes;
  const name = encodeCanonicalCBOR(model);
  const out = new Uint8Array(1 + name.length + own.length);
  out[0] = 0x82; // an array of two
  out.set(name, 1);
  out.set(own, 1 + name.length);
  return out;
}

function compareChanges(a: RowChange, b: RowChange): number {
  return compareUTF8(a.model, b.model) || compareLogicalRows(a, b);
}

/** A log entry's canonical bytes. Changes are sorted by model, then stable key. */
export function encodeProtocolLog(entry: ProtocolLog): Uint8Array {
  if ("changes" in entry) return encodeCanonicalCBOR({ ...entry, changes: [...entry.changes].sort(compareChanges) });
  return encodeCanonicalCBOR(entry);
}

/** A `log` object: canonical, its changes well formed, in model then stable-key order, each row once. */
export function decodeProtocolLog(bytes: Uint8Array): ProtocolLog {
  const value = decodeCanonicalCBOR(bytes, { tags: [0, 1004] });
  if (!isRecord(value) || value.type !== "log") throw new TypeError("Not a log object");
  const body = "changes" in value ? "changes" : "snapshot";
  exactKeys(value, ["type", "previous", "rows", "rowsHash", body], "log object");
  if (value.previous !== null && (typeof value.previous !== "string" || !HASH.test(value.previous))) throw new TypeError("log previous must be a hash or null");
  if (!Number.isSafeInteger(value.rows) || (value.rows as number) < 0) throw new TypeError("log rows must be a count");
  if (typeof value.rowsHash !== "string" || !HASH.test(value.rowsHash)) throw new TypeError("log rowsHash must be a hash");
  const head = { type: "log" as const, previous: value.previous as Hash | null, rows: value.rows as number, rowsHash: value.rowsHash as Hash };
  if (body === "snapshot") {
    if (typeof value.snapshot !== "string" || !HASH.test(value.snapshot)) throw new TypeError("log snapshot must be a hash");
    return { ...head, snapshot: value.snapshot as Hash };
  }
  if (!Array.isArray(value.changes)) throw new TypeError("log changes must be an array");
  const changes = value.changes.map((change, i): RowChange => {
    const label = `log changes[${i}]`;
    if (!isRecord(change)) throw new TypeError(`${label} must be a map`);
    exactKeys(change, ["model", "key", "row"], label);
    if (typeof change.model !== "string" || !NAME.test(change.model)) throw new TypeError(`${label}.model must be a model name`);
    if (change.row === null) {
      const key = decodeLogicalRow({ key: change.key, fields: {}, created: 0, modified: 0 }, label).key;
      return { model: change.model, key, row: null };
    }
    const row = decodeLogicalRow(change.row, `${label}.row`);
    if (encodeCanonicalCBOR(row.key).join() !== encodeCanonicalCBOR(change.key).join()) throw new TypeError(`${label}.key must be its row's key`);
    return { model: change.model, key: row.key, row };
  });
  for (let i = 1; i < changes.length; i++) {
    if (compareChanges(changes[i - 1]!, changes[i]!) >= 0) throw new TypeError("log changes must be in model, then stable-key order, each row once");
  }
  return { ...head, changes };
}

/** The objects a log entry reaches: the entry before it, unless it's a snapshot, whose file it reaches instead. */
export function logEntryReferences(entry: ProtocolLog): { kind: "log" | "file"; hash: Hash }[] {
  if ("snapshot" in entry) return [{ kind: "file", hash: entry.snapshot }];
  return entry.previous ? [{ kind: "log", hash: entry.previous }] : [];
}

export function decodeCollectionReference(value: unknown): CollectionReference {
  if (!isRecord(value)) throw new TypeError("collection must be a map");
  exactKeys(value, ["version", "modelFingerprint", "log"], "collection");
  if (value.version !== 2) throw new TypeError("collection.version must be 2");
  if (typeof value.modelFingerprint !== "string" || !HASH.test(value.modelFingerprint)) throw new TypeError("collection.modelFingerprint must be a hash");
  if (typeof value.log !== "string" || !HASH.test(value.log)) throw new TypeError("collection.log must be a hash");
  return { version: 2, modelFingerprint: value.modelFingerprint as Hash, log: value.log as Hash };
}

/** The collection's logical hash: what it contributes to its folder's model hash, from its rows alone. */
export function collectionLogicalHash(modelFingerprint: Hash, rowsHash: Hash): Hash {
  return canonicalCBORHash({ modelFingerprint, rowsHash });
}
