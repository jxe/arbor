import {
  decodeProtocolDirectory,
  executeRowOperations,
  logicalRowKey,
  stableJSONString,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
  type RowMember,
  type RowOperation,
} from "@ovst/protocol";
import type { LogicalModel } from "@ovst/usl";
import { loadDirectoryCollection } from "./directory-collection.ts";
import { replayCollectionRows } from "./row-replay.ts";

type Read = (hash: ObjectHash) => Promise<Uint8Array>;
type Collection = RowOperation["collection"];

const json = (value: unknown) => stableJSONString(value ?? null);
const scalar = (value: JSONValue): value is RowMember => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The operations that turn one row into another, each stamped with the
 * row's new `modified`; false when no operations can. */
function rowEdits(model: LogicalModel, before: LogicalRow, after: LogicalRow, op: (fields: Record<string, unknown>) => void): boolean {
  // A row's times come from its operations' `at`, never from a set.
  if (before.created !== after.created || before.modified === after.modified) return false;
  let count = 0;
  const timed = (fields: Record<string, unknown>) => { count++; op({ ...fields, at: after.modified }); };
  return fieldEdits(model, before, after, timed) && count > 0;
}

function fieldEdits(model: LogicalModel, before: LogicalRow, after: LogicalRow, op: (fields: Record<string, unknown>) => void): boolean {
  for (const field of model.fields) {
    const b = before.fields[field.name], a = after.fields[field.name];
    if (json(b) === json(a)) continue;
    const lists = [b ?? [], a ?? []];
    if (field.arity === "many" && lists.every((l) => Array.isArray(l) && l.every(scalar))) {
      const [from, to] = lists as [RowMember[], RowMember[]];
      const target = new Set(to.map(json)), source = new Set(from.map(json));
      const working = from.filter((m) => target.has(json(m)));
      for (const member of from) if (!target.has(json(member))) op({ kind: "rowDisconnect", field: field.name, member });
      for (const member of to) if (!source.has(json(member))) { op({ kind: "rowConnect", field: field.name, member }); working.push(member); }
      if (!field.ordered) continue;
      for (const [index, member] of to.entries()) {
        if (json(working[index]) === json(member)) continue;
        op({ kind: "rowMove", field: field.name, member, after: index ? to[index - 1]! : null });
        working.splice(working.findIndex((m) => json(m) === json(member)), 1);
        working.splice(index, 0, member);
      }
      continue;
    }
    op({ kind: "rowSet", field: field.name, before: b ?? null, value: a ?? null });
  }
  return true;
}

/** Row operations for one collection directory whose rows changed, or null when only operations on its rows can't explain the change. */
async function collectionEdits(path: string, object: ObjectHash, before: ProtocolDirectory, after: ProtocolDirectory, read: Read): Promise<RowOperation[] | null> {
  if (stableJSONString(before.entries) !== stableJSONString(after.entries)) return null;
  if (before.collection!.modelFingerprint !== after.collection!.modelFingerprint) return null;
  let left, right;
  try {
    [left, right] = [await loadDirectoryCollection(before, read), await loadDirectoryCollection(after, read)];
  } catch {
    return null;
  }
  const collection: Collection = { material: { kind: "basis", path, object } };
  const operations: RowOperation[] = [];
  for (const model of left!.schema.models) {
    const rowsBefore = new Map((left!.tables[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
    const rowsAfter = new Map((right!.tables[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
    for (const [row, value] of rowsAfter) {
      const prior = rowsBefore.get(row);
      const op = (fields: Record<string, unknown>) => operations.push({ key: "", collection, table: model.name, row, ...fields } as RowOperation);
      if (!prior) {
        // A created row's times are its operation's.
        if (value.created !== value.modified) return null;
        op({ kind: "rowCreate", values: { ...Object.fromEntries(value.key), ...value.fields }, at: value.created });
      } else if (json(prior) !== json(value) && !rowEdits(model, prior, value, op)) return null;
    }
    for (const row of rowsBefore.keys())
      if (!rowsAfter.has(row)) operations.push({ key: "", kind: "rowDelete", collection, table: model.name, row });
  }
  return operations;
}

/**
 * The row operations that explain a change from `basis` to `candidate`, when
 * that change is only edits to collection rows and replaying the operations
 * reproduces `candidate` exactly (spec 10 §4.1). Null otherwise: any other
 * change stays a snapshot.
 */
export async function deriveRowOperations(basis: ObjectHash, candidate: ObjectHash, read: Read): Promise<RowOperation[] | null> {
  const operations: RowOperation[] = [];
  const walk = async (path: string, before: ObjectHash, after: ObjectHash): Promise<boolean> => {
    if (before === after) return true;
    const [left, right] = [decodeProtocolDirectory(await read(before)), decodeProtocolDirectory(await read(after))];
    if (left.collection && right.collection) {
      const edits = await collectionEdits(path, before, left, right, read);
      if (!edits?.length) return false;
      operations.push(...edits);
      return true;
    }
    if (left.collection || right.collection) return false;
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
