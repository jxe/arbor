import {
  collectionTableSources,
  decodeProtocolDirectory,
  executeRowOperations,
  ROW_TIME,
  stableJSONString,
  type ChildrenSourceDescriptor,
  type JSONValue,
  type ObjectHash,
  type ProtocolDirectory,
  type RowMember,
  type RowOperation,
} from "@ovst/protocol";
import type { CollectionSchema } from "./compile.ts";
import { collectionFileRows, collectionTables, type CollectionTable } from "./collection-file.ts";
import { replayCollectionRows } from "./row-replay.ts";
import { SYSTEM_COLUMNS } from "./csv.ts";

type Row = Record<string, JSONValue>;
type Read = (hash: ObjectHash) => Promise<Uint8Array>;
type Collection = RowOperation["collection"];

const json = (value: unknown) => stableJSONString(value ?? null);
const scalar = (value: JSONValue): value is RowMember => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The operations that turn one row into another, or null when its arrays
 * cannot be stated member by member. */
function rowEdits(schema: CollectionSchema, before: Row, after: Row, op: (fields: Record<string, unknown>) => void): boolean {
  // A row's times come from its operations' `at`, never from a set.
  if (json(before.created) !== json(after.created)) return false;
  const at = json(before.modified) === json(after.modified) ? undefined : after.modified;
  if (at !== undefined && !(typeof at === "string" && ROW_TIME.test(at))) return false;
  let count = 0;
  const timed = (fields: Record<string, unknown>) => { count++; op(at === undefined ? fields : { ...fields, at }); };
  if (!fieldEdits(schema, before, after, timed)) return false;
  return at === undefined || count > 0;
}

function fieldEdits(schema: CollectionSchema, before: Row, after: Row, op: (fields: Record<string, unknown>) => void): boolean {
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SYSTEM_COLUMNS.includes(field)) continue;
    const b = before[field], a = after[field];
    if (json(b) === json(a)) continue;
    const kind = schema.merge.get(field);
    const lists = [b ?? [], a ?? []];
    if ((kind === "many" || kind === "ordered") && lists.every((l) => Array.isArray(l) && l.every(scalar))) {
      const [from, to] = lists as [RowMember[], RowMember[]];
      const target = new Set(to.map(json)), source = new Set(from.map(json));
      const working = from.filter((m) => target.has(json(m)));
      for (const member of from) if (!target.has(json(member))) op({ kind: "rowDisconnect", field, member });
      for (const member of to) if (!source.has(json(member))) { op({ kind: "rowConnect", field, member }); working.push(member); }
      for (const [index, member] of to.entries()) {
        if (json(working[index]) === json(member)) continue;
        if (kind !== "ordered") return false;
        const after = index ? to[index - 1]! : null;
        op({ kind: "rowMove", field, member, after });
        working.splice(working.findIndex((m) => json(m) === json(member)), 1);
        working.splice(index, 0, member);
      }
      continue;
    }
    op({ kind: "rowSet", field, before: b ?? null, value: a ?? null });
  }
  return true;
}

/** Row operations for one collection directory whose collection files changed. */
async function collectionEdits(path: string, object: ObjectHash, before: ProtocolDirectory, after: ProtocolDirectory, read: Read): Promise<RowOperation[] | null> {
  const descriptor = before.childrenSource!, next = after.childrenSource!;
  const sources = new Set(collectionTableSources(descriptor).map((t) => t.source));
  const shape = (d: ChildrenSourceDescriptor) => stableJSONString(d.type === "collection-file"
    ? { ...d, childSetHash: null }
    : { ...d, tables: d.tables.map((t) => ({ ...t, childSetHash: null })) });
  if (shape(descriptor) !== shape(next)) return null;
  const entry = (directory: ProtocolDirectory, name: string) => directory.entries.find((e) => e.name === name);
  const names = new Set([...before.entries, ...after.entries].map((e) => e.name));
  for (const name of names)
    if (!sources.has(name) && stableJSONString(entry(before, name) ?? null) !== stableJSONString(entry(after, name) ?? null)) return null;
  const schemaFile = entry(before, descriptor.schemaSource)?.file;
  if (!schemaFile) return null;
  const collection: Collection = { material: { kind: "basis", path, object } };
  const operations: RowOperation[] = [];
  let tables: CollectionTable[];
  try {
    tables = collectionTables(descriptor, await read(schemaFile));
  } catch {
    return null;
  }
  for (const { schema, source } of tables) {
    const sourceBefore = entry(before, source)?.file, sourceAfter = entry(after, source)?.file;
    if (!sourceBefore || !sourceAfter) return null;
    if (sourceBefore === sourceAfter) continue;
    let rowsBefore: Map<string, Row>, rowsAfter: Map<string, Row>;
    try {
      const decode = async (hash: ObjectHash) => new Map(collectionFileRows(descriptor.format, await read(hash), schema).rows.map((row) => [row.stableKey, row.properties]));
      [rowsBefore, rowsAfter] = [await decode(sourceBefore), await decode(sourceAfter)];
    } catch {
      return null;
    }
    for (const [row, value] of rowsAfter) {
      const prior = rowsBefore.get(row);
      const op = (fields: Record<string, unknown>) => operations.push({ key: "", collection, table: schema.model, row, ...fields } as RowOperation);
      if (!prior) {
        // A row created with equal times was created by a timed operation.
        const { created, modified, ...values } = value;
        if (created !== undefined && json(created) === json(modified) && typeof created === "string" && ROW_TIME.test(created))
          op({ kind: "rowCreate", values, at: created });
        else op({ kind: "rowCreate", values: value });
      }
      else if (!rowEdits(schema, prior, value, op)) return null;
    }
    for (const row of rowsBefore.keys())
      if (!rowsAfter.has(row)) operations.push({ key: "", kind: "rowDelete", collection, table: schema.model, row });
  }
  return operations;
}

/**
 * The row operations that explain a change from `basis` to `candidate`, when
 * that change is only edits to collection rows and replaying the operations
 * reproduces `candidate` exactly (spec 10 §4.1). Null otherwise: any other
 * change, or bytes replay would write differently, stays a snapshot.
 */
export async function deriveRowOperations(basis: ObjectHash, candidate: ObjectHash, read: Read): Promise<RowOperation[] | null> {
  const operations: RowOperation[] = [];
  const walk = async (path: string, before: ObjectHash, after: ObjectHash): Promise<boolean> => {
    if (before === after) return true;
    const [left, right] = [decodeProtocolDirectory(await read(before)), decodeProtocolDirectory(await read(after))];
    if (left.childrenSource && right.childrenSource) {
      const edits = await collectionEdits(path, before, left, right, read);
      if (!edits?.length) return false;
      operations.push(...edits);
      return true;
    }
    if (left.childrenSource || right.childrenSource) return false;
    const names = new Set([...left.entries, ...right.entries].map((e) => e.name));
    for (const name of names) {
      const a = left.entries.find((e) => e.name === name), b = right.entries.find((e) => e.name === name);
      if (stableJSONString(a ?? null) === stableJSONString(b ?? null)) continue;
      if (!a?.directory || !b?.directory) return false;
      if (!(await walk(`${path === "/" ? "" : path}/${name}`, a.directory, b.directory))) return false;
    }
    return true;
  };
  if (!(await walk("/", basis, candidate)) || !operations.length) return null;
  operations.forEach((operation, index) => { operation.key = `row-${index + 1}`; });
  try {
    const replayed = await executeRowOperations(basis, operations, read, replayCollectionRows);
    return replayed.root === candidate ? operations : null;
  } catch {
    return null;
  }
}
