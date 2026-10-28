import {
  decodeProtocolDirectory,
  decodeProtocolPage,
  encodeCanonicalCBOR,
  executeRowOperations,
  pageValueJSON,
  type PageOperation,
  type PageValue,
  type PropertyOperation,
  type ProtocolPage,
  logicalRowKey,
  stableJSONString,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
  type RowMember,
  type RowOperation,
} from "@ovst/protocol";
import type { LogicalModel, LogicalTables } from "@ovst/usl";
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
      for (const member of from) if (!target.has(json(member))) op({ kind: "disconnect", field: field.name, member });
      for (const member of to) if (!source.has(json(member))) { op({ kind: "connect", field: field.name, member }); working.push(member); }
      if (!field.ordered) continue;
      for (const [index, member] of to.entries()) {
        if (json(working[index]) === json(member)) continue;
        op({ kind: "move", field: field.name, member, after: index ? to[index - 1]! : null });
        working.splice(working.findIndex((m) => json(m) === json(member)), 1);
        working.splice(index, 0, member);
      }
      continue;
    }
    op({ kind: "set", field: field.name, before: b ?? null, value: a ?? null });
  }
  return true;
}

/**
 * The row operations that turn one collection's logical tables into another's,
 * or null when operations on its rows can't: a row whose `created` changed, or
 * a changed row whose `modified` didn't. Each operation is stamped with its
 * row's new `modified` (a created row's, `created`). Keys are left empty.
 */
export function rowOperationsBetween(models: readonly LogicalModel[], before: LogicalTables, after: LogicalTables, collection: Collection): RowOperation[] | null {
  const operations: RowOperation[] = [];
  for (const model of models) {
    const rowsBefore = new Map((before[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
    const rowsAfter = new Map((after[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
    for (const [row, value] of rowsAfter) {
      const prior = rowsBefore.get(row);
      const op = (fields: Record<string, unknown>) => operations.push({ key: "", collection, model: model.name, row, ...fields } as RowOperation);
      if (!prior) {
        // A created row's times are its operation's.
        if (value.created !== value.modified) return null;
        op({ kind: "rowCreate", values: { ...Object.fromEntries(value.key), ...value.fields }, at: value.created });
      } else if (json(prior) !== json(value) && !rowEdits(model, prior, value, op)) return null;
    }
    for (const row of rowsBefore.keys())
      if (!rowsAfter.has(row)) operations.push({ key: "", kind: "rowDelete", collection, model: model.name, row });
  }
  return operations;
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
  return rowOperationsBetween(left!.schema.models, left!.tables, right!.tables, { material: { kind: "basis", path, object } });
}

/** Property operations for one page whose properties alone changed, or null
 * when its id or body changed too. */
function pageEdits(path: string, object: ObjectHash, before: ProtocolPage, after: ProtocolPage): PageOperation[] | null {
  if (before.id !== after.id || !Buffer.from(before.body).equals(Buffer.from(after.body))) return null;
  const page = { material: { kind: "basis" as const, path, object } };
  const operations: PageOperation[] = [];
  const op = (fields: Record<string, unknown>) => operations.push({ key: "", page, ...fields } as PageOperation);
  const same = (a: PageValue | undefined, b: PageValue | undefined) =>
    a === undefined || b === undefined ? a === b : Buffer.from(encodeCanonicalCBOR(a)).equals(Buffer.from(encodeCanonicalCBOR(b)));
  const valuesBefore = new Map(before.properties), valuesAfter = new Map(after.properties);
  for (const name of new Set([...valuesBefore.keys(), ...valuesAfter.keys()])) {
    const b = valuesBefore.get(name), a = valuesAfter.get(name);
    if (same(b, a)) continue;
    // A list both versions hold changes member by member, as an ordered field.
    if (Array.isArray(b) && Array.isArray(a) && new Set(b.map((m) => json(pageValueJSON(m)))).size === b.length
      && new Set(a.map((m) => json(pageValueJSON(m)))).size === a.length) {
      const key = (m: PageValue) => json(pageValueJSON(m));
      const target = new Set(a.map(key)), source = new Set(b.map(key));
      const working = b.filter((m) => target.has(key(m)));
      for (const member of b) if (!target.has(key(member))) op({ kind: "disconnect", field: name, member: pageValueJSON(member) });
      for (const member of a) if (!source.has(key(member))) { op({ kind: "connect", field: name, member: pageValueJSON(member) }); working.push(member); }
      for (const [index, member] of a.entries()) {
        if (working[index] !== undefined && key(working[index]!) === key(member)) continue;
        op({ kind: "move", field: name, member: pageValueJSON(member), after: index ? pageValueJSON(a[index - 1]!) : null });
        working.splice(working.findIndex((m) => key(m) === key(member)), 1);
        working.splice(index, 0, member);
      }
      continue;
    }
    op({ kind: "set", field: name, before: b === undefined ? null : pageValueJSON(b), value: a === undefined ? null : pageValueJSON(a) });
  }
  return operations;
}

/**
 * The property operations that explain a change from `basis` to
 * `candidate`, when that change is only edits to collection rows and to page
 * properties and replaying the operations reproduces `candidate` exactly
 * (spec 10 §4.1). Null otherwise: any other change stays a snapshot.
 */
export async function deriveRowOperations(basis: ObjectHash, candidate: ObjectHash, read: Read): Promise<PropertyOperation[] | null> {
  const operations: PropertyOperation[] = [];
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
      const child = `${path === "/" ? "" : path}/${name}`;
      if (a?.page && b?.page) {
        const edits = pageEdits(child, a.page, decodeProtocolPage(await read(a.page)), decodeProtocolPage(await read(b.page)));
        if (!edits?.length) return false;
        operations.push(...edits);
        continue;
      }
      if (!a?.directory || !b?.directory) return false;
      if (!(await walk(`${path === "/" ? "" : path}/${name}`, a.directory, b.directory))) return false;
    }
    return true;
  };
  if (!(await walk("/", basis, candidate)) || !operations.length) return null;
  operations.forEach((operation, index) => { operation.key = `${"page" in operation ? "page" : "row"}-${index + 1}`; });
  try {
    const replayed = await executeRowOperations(basis, operations, read, replayCollectionRows);
    return replayed.root === candidate ? operations : null;
  } catch {
    return null;
  }
}
