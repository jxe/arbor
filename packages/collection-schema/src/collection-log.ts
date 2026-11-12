// A collection's log (collections §1): loading the rows a log entry stands for, writing the
// entry for a new state, and snapshots. A state is the rows of each model as the tree holds
// them (Date fields tagged), with the row count and the LtHash state behind the rows hash.
// States are cached by head entry, so appending to a log that was just loaded applies one
// entry, not the whole history.

import {
  compareUTF8,
  decodeProtocolLog,
  deepFreeze,
  encodedRow,
  encodeProtocolLog,
  LtHash,
  logicalRowKey,
  rowHashElement,
  sha256,
  type Hash,
  type LogicalRow,
  type ProtocolLog,
  type RowChange,
} from "@ovst/protocol";
import { layoutOf, logicalFromRows, rowsFromLogical, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
import { treeTables, type LogicalSchema } from "./logical.ts";

type Load = (hash: Hash) => Promise<Uint8Array>;

/** The rows a log entry stands for, as the tree holds them. */
export interface CollectionState {
  /** The entry, or null for the empty state before a log's first entry. */
  readonly head: Hash | null;
  readonly rows: number;
  readonly lthash: LtHash;
  /** Each model's rows by stable key; the rows are frozen and shared between states. */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, LogicalRow>>;
}

export const EMPTY_COLLECTION_STATE: CollectionState = Object.freeze({ head: null, rows: 0, lthash: new LtHash(), tables: new Map() });

/** A state's rows by model, each model in stable-key order. */
export function stateTables(state: CollectionState): Record<string, LogicalRow[]> {
  const out: Record<string, LogicalRow[]> = {};
  for (const [model, rows] of state.tables) {
    out[model] = [...rows.keys()].sort(compareUTF8).map((key) => rows.get(key)!);
  }
  return out;
}

// ------------------------------------------------------------------ the cache

const STATE_CACHE_ROWS = 200_000;
const states = new Map<Hash, CollectionState>();
let cachedRows = 0;

function remember(state: CollectionState): void {
  if (!state.head || states.has(state.head)) return;
  states.set(state.head, state);
  cachedRows += state.rows;
  for (const [head, old] of states) {
    if (cachedRows <= STATE_CACHE_ROWS || states.size === 1) break;
    states.delete(head);
    cachedRows -= old.rows;
  }
}

function recall(head: Hash): CollectionState | undefined {
  const state = states.get(head);
  if (state) {
    states.delete(head);
    states.set(head, state);
  }
  return state;
}

// ------------------------------------------------------------------ applying entries

/**
 * The state after `changes`, checked as collections §1 says: each change names a model with
 * data rows, a removed row is present, and the row count and rows hash are the entry's.
 */
export function applyRowChanges(schema: LogicalSchema, state: CollectionState, changes: readonly RowChange[], head: Hash | null): { state: CollectionState; rows: number; rowsHash: Hash } {
  const models = new Set(schema.models.map((m) => m.name));
  const tables = new Map<string, Map<string, LogicalRow>>();
  for (const model of schema.models) tables.set(model.name, new Map(state.tables.get(model.name) ?? []));
  const lthash = state.lthash.clone();
  let rows = state.rows;
  for (const change of changes) {
    if (!models.has(change.model)) throw new TypeError(`The schema has no model ${change.model} with data rows`);
    const table = tables.get(change.model)!;
    const key = logicalRowKey(change);
    const old = table.get(key);
    if (old) {
      lthash.remove(rowHashElement(change.model, old));
      rows--;
    } else if (!change.row) {
      throw new TypeError(`${change.model} ${key} is removed but isn't there`);
    }
    if (change.row) {
      const row = deepFreeze(change.row);
      table.set(key, row);
      lthash.add(rowHashElement(change.model, row));
      rows++;
    } else {
      table.delete(key);
    }
  }
  return { state: { head, rows, lthash, tables }, rows, rowsHash: lthash.hash() };
}

/** The changes that turn `state` into `tables` (rows as the tree holds them), in model then stable-key order. */
export function rowChangesTo(schema: LogicalSchema, state: CollectionState, tables: Readonly<Record<string, readonly LogicalRow[]>>): RowChange[] {
  const changes: RowChange[] = [];
  for (const model of schema.models) {
    const before = state.tables.get(model.name) ?? new Map<string, LogicalRow>();
    const after = new Map<string, LogicalRow>();
    for (const row of tables[model.name] ?? []) after.set(logicalRowKey(row), row);
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of [...keys].sort(compareUTF8)) {
      const was = before.get(key), is = after.get(key);
      if (was && is && (was === is || encodedRow(was).hash === encodedRow(is).hash)) continue;
      changes.push({ model: model.name, key: (is ?? was)!.key, row: is ?? null });
    }
  }
  return changes;
}

/** A log entry and its bytes and hash. */
export function encodedLogEntry(entry: ProtocolLog): { entry: ProtocolLog; hash: Hash; bytes: Uint8Array } {
  const bytes = encodeProtocolLog(entry);
  return { entry, bytes, hash: `sha256:${sha256(bytes)}` as Hash };
}

/**
 * The entry that appends `changes` to the log at `state`, and the state after it. A log's
 * first entry (`state.head` null) may hold no changes; any other entry holds at least one.
 */
export function appendRowChanges(schema: LogicalSchema, state: CollectionState, changes: readonly RowChange[]): { hash: Hash; bytes: Uint8Array; state: CollectionState } {
  const applied = applyRowChanges(schema, state, changes, null);
  const { hash, bytes } = encodedLogEntry({ type: "log", previous: state.head, rows: applied.rows, rowsHash: applied.rowsHash, changes: [...changes] });
  const next = { ...applied.state, head: hash };
  remember(next);
  return { hash, bytes, state: next };
}

/**
 * The state `head` stands for, loaded through `load` and checked entry by entry: from the
 * nearest cached state, a snapshot, or the log's first entry, each later entry applied in
 * order with its row count and rows hash required to match.
 */
export async function loadCollectionState(schema: LogicalSchema, head: Hash, load: Load): Promise<CollectionState> {
  const cached = recall(head);
  if (cached) return cached;
  const pending: Array<{ hash: Hash; entry: ProtocolLog }> = [];
  let base: CollectionState = EMPTY_COLLECTION_STATE;
  for (let at: Hash | null = head; at;) {
    const known = recall(at);
    if (known) { base = known; break; }
    const entry = decodeProtocolLog(await load(at));
    if ("snapshot" in entry) {
      const tables = readSnapshot(schema, await load(entry.snapshot));
      const changes = schema.models.flatMap((m) => (tables[m.name] ?? []).map((row) => ({ model: m.name, key: row.key, row })));
      const applied = applyRowChanges(schema, EMPTY_COLLECTION_STATE, changes, at);
      if (applied.rows !== entry.rows || applied.rowsHash !== entry.rowsHash) throw new TypeError(`The snapshot in log entry ${at} doesn't hold the rows its entry says`);
      base = applied.state;
      remember(base);
      break;
    }
    pending.push({ hash: at, entry });
    at = entry.previous;
  }
  let state = base;
  for (const { hash, entry } of pending.reverse()) {
    if (entry.previous !== state.head) throw new TypeError(`Log entry ${hash} doesn't follow ${state.head ?? "the start of the log"}`);
    if (!("changes" in entry)) throw new TypeError(`Log entry ${hash} isn't a changes entry`);
    if (entry.previous !== null && entry.changes.length === 0) throw new TypeError(`Log entry ${hash} changes no row`);
    const applied = applyRowChanges(schema, state, entry.changes, hash);
    if (applied.rows !== entry.rows || applied.rowsHash !== entry.rowsHash) throw new TypeError(`Log entry ${hash} doesn't hold the rows its count and rows hash say`);
    state = applied.state;
    remember(state);
  }
  return state;
}

/**
 * The changes from the state at `before` to the state at `after`, read from the entries
 * between them when `after` follows `before` (an accepted update's entries), else by
 * comparing the two states. Each changed row is listed once, with its newest form.
 */
export async function changesBetween(schema: LogicalSchema, before: Hash, after: Hash, load: Load, limit = 1_000): Promise<{ before: CollectionState; changes: RowChange[] }> {
  const start = await loadCollectionState(schema, before, load);
  if (before === after) return { before: start, changes: [] };
  const newest = new Map<string, RowChange>();
  let at: Hash | null = after;
  for (let i = 0; at && at !== before && i < limit; i++) {
    const entry = decodeProtocolLog(await load(at));
    if (!("changes" in entry)) break;
    for (const change of entry.changes) {
      const key = `${change.model}\0${logicalRowKey(change)}`;
      if (!newest.has(key)) newest.set(key, change);
    }
    at = entry.previous;
  }
  if (at === before) {
    const changes = [...newest.values()].sort((a, b) => compareUTF8(a.model, b.model) || compareUTF8(logicalRowKey(a), logicalRowKey(b)));
    return { before: start, changes: changes.filter((c) => {
      const was = start.tables.get(c.model)?.get(logicalRowKey(c));
      if (!was) return c.row !== null;
      return !c.row || encodedRow(was).hash !== encodedRow(c.row).hash;
    }) };
  }
  const end = await loadCollectionState(schema, after, load);
  return { before: start, changes: rowChangesTo(schema, start, stateTables(end)) };
}

// ------------------------------------------------------------------ snapshots

/** Reads and writes a snapshot's SQLite file; this package touches no database itself. */
export interface SnapshotDatabase {
  write(layout: readonly Table[], rows: RowsByTable): Uint8Array;
  read(layout: readonly Table[], bytes: Uint8Array): RowsByTable;
}

let snapshotDatabase: SnapshotDatabase | undefined;
/** Sets how snapshots are read and written: `sqliteSnapshots` from `@ovst/beetle/sqlite` under Bun. */
export function useSnapshotDatabase(database: SnapshotDatabase): void {
  snapshotDatabase = database;
}
function database(): SnapshotDatabase {
  if (!snapshotDatabase) throw new TypeError("No snapshot database is set to read a collection's snapshot (useSnapshotDatabase)");
  return snapshotDatabase;
}

const layouts = new WeakMap<LogicalSchema, Table[]>();
/** The schema's database layout, which a snapshot implements under its own names. */
export function snapshotLayout(schema: LogicalSchema): Table[] {
  let layout = layouts.get(schema);
  if (!layout) layouts.set(schema, (layout = layoutOf(schema.result, { store: "database" })));
  return layout;
}

/** A snapshot file: a SQLite database of `tables` (plain logical rows) in the schema's database layout. */
export function writeSnapshot(schema: LogicalSchema, tables: LogicalTables): Uint8Array {
  const layout = snapshotLayout(schema);
  return database().write(layout, rowsFromLogical(schema.result, layout, tables));
}

/** The plain logical rows a snapshot file holds. */
export function readSnapshotRows(schema: LogicalSchema, bytes: Uint8Array): LogicalTables {
  const layout = snapshotLayout(schema);
  return logicalFromRows(schema.result, layout, database().read(layout, bytes), { now: 0 });
}

function readSnapshot(schema: LogicalSchema, bytes: Uint8Array): Record<string, LogicalRow[]> {
  return treeTables(schema, readSnapshotRows(schema, bytes));
}
