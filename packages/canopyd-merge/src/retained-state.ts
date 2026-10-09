import { hashObject, stableJSONString } from "@overstory/protocol";
import type { IntentDecision, IntentState, Node } from "./intent-model.ts";

const HISTORY = ["outputs", "effects", "origins", "alternatives", "changes"] as const;
type HistoryField = (typeof HISTORY)[number];

/** A state the engine recorded, kept decoded in memory and never serialized.
 * Every record, node and decision in it is frozen and shared with any other
 * state that holds the same value; its nodes and history maps are persistent
 * maps, so a state shares every bucket its edits did not touch. It keeps the
 * root it projects to and whether its nodes already reflect every deletion in
 * its effects (`editable`), so an evaluation on it need only enforce newer
 * ones. `bytes` estimates the memory it added. */
export interface RetainedState {
  readonly format: IntentState["format"];
  readonly tree: string;
  readonly root: string;
  readonly decisions: readonly IntentDecision[];
  readonly nodes: Bucket;
  readonly history: Readonly<Record<HistoryField, Bucket>>;
  readonly object: string;
  readonly editable: boolean;
  readonly bytes: number;
}

/** Recorded states by identity: the sidecar's cache, or a plain `Map`. */
export interface RetainedStates {
  get(id: string): RetainedState | undefined;
  set(id: string, value: RetainedState): unknown;
}

const encoder = new TextEncoder();
const digest = (text: string) => hashObject(encoder.encode(text));
const utf8 = (text: string) => Buffer.byteLength(text);
const isObject = (value: unknown): value is object => value !== null && typeof value === "object";

/** Whether `a` and `b` have one `stableJSONString` form, decided without
 * building either string (evaluation compares whole node maps with it).
 * Evaluation data is JSON, so equal references and primitives serialize
 * alike, and each member of an array or record serializes unambiguously and
 * can be compared alone. The one collision between different shapes, an
 * array of one unserializable member against an empty array, is left to the
 * full form. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b))
    return !isObject(a) && !isObject(b) && JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length)
      return stableJSONString(a) === stableJSONString(other);
    for (let index = 0; index < a.length; index++)
      if (!same(a[index], other[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  let count = 0;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    if (right[key] === undefined || !Object.hasOwn(right, key) || !same(left[key], right[key]))
      return false;
    count++;
  }
  for (const key of Object.keys(right)) if (right[key] !== undefined) count--;
  return count === 0;
}

/** A deep, mutable copy of JSON data in which no two places share an object.
 * Recorded values are interned, so one frozen object can stand for several
 * equal values; `structuredClone` would keep that sharing, and an edit to one
 * place would reach the others. */
export function copy<T>(value: T): T {
  if (!isObject(value)) return value;
  if (Array.isArray(value)) return value.map(copy) as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = copy((value as Record<string, unknown>)[key]);
    if (key === "__proto__") Object.defineProperty(out, key, { value: child, writable: true, enumerable: true, configurable: true });
    else out[key] = child;
  }
  return out as T;
}

// ---- Persistent maps ------------------------------------------------------

/** A persistent map of frozen values: sixteen or fewer entries in key order,
 * more split by one hex digit of each key's hash per level. Buckets are
 * immutable and shared; `hash` digests the contents, and `size` is the
 * canonical JSON length of the entries (keys and values, without the braces
 * and commas of the object they make). */
export type Bucket =
  | { readonly entries: ReadonlyArray<readonly [string, unknown]>; readonly hash: string; readonly size: number; readonly count: number }
  | { readonly children: ReadonlyArray<Bucket | null>; readonly hash: string; readonly size: number; readonly count: number };

const keyHashes = new Map<string, string>();
/** Hex SHA-256 of a key, memoized with a bound. */
function keyHash(key: string): string {
  let known = keyHashes.get(key);
  if (known === undefined) {
    known = digest(key).slice(7);
    if (keyHashes.size >= 65_536) keyHashes.clear();
    keyHashes.set(key, known);
  }
  return known;
}
const digit = (key: string, depth: number) => parseInt(keyHash(key)[depth]!, 16);
/** Sorted keys in the order a bucket of them would hold. */
function radix(keys: string[], depth: number): string[] {
  if (keys.length <= 16 || depth === 64) return keys;
  const buckets: string[][] = Array.from({ length: 16 }, () => []);
  for (const key of keys) buckets[digit(key, depth)]!.push(key);
  return buckets.flatMap((bucket) => radix(bucket, depth + 1));
}
const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Bucket nodes built since the counter was last read: a memory estimate. */
let builtBuckets = 0;

function build(entries: ReadonlyArray<readonly [string, unknown]>, depth: number): Bucket {
  if (entries.length <= 16 || depth === 64) return leaf(entries);
  const buckets: Array<Array<readonly [string, unknown]>> = Array.from({ length: 16 }, () => []);
  for (const entry of entries) buckets[digit(entry[0], depth)]!.push(entry);
  return branch(buckets.map((bucket) => (bucket.length ? build(bucket, depth + 1) : null)));
}
/** A bucket of `entries` in the order given. */
function leaf(entries: ReadonlyArray<readonly [string, unknown]>): Bucket {
  builtBuckets++;
  let size = 0;
  const lines = entries.map(([key, value]) => {
    const known = factsOf(value), name = JSON.stringify(key);
    size += utf8(name) + 1 + known.size;
    return `${name}:${known.hash}`;
  });
  return { entries, hash: digest(`L${lines.join("\n")}`), size, count: entries.length };
}
function branch(children: Array<Bucket | null>): Bucket {
  builtBuckets++;
  return {
    children,
    hash: digest(`B${children.map((child) => child?.hash ?? "").join(",")}`),
    size: children.reduce((n, child) => n + (child?.size ?? 0), 0),
    count: children.reduce((n, child) => n + (child?.count ?? 0), 0),
  };
}
/** `bucket` with `changes` (sorted by key) set, path-copying only the buckets
 * they fall in. Adding keys splits a bucket exactly as building the whole
 * map would, so equal contents have one shape. */
function update(bucket: Bucket | null, changes: Array<readonly [string, unknown]>, depth: number): Bucket {
  if (!bucket) return build(changes, depth);
  if ("entries" in bucket) return build([...new Map([...bucket.entries, ...changes])].sort(byKey), depth);
  const groups: Array<Array<readonly [string, unknown]>> = Array.from({ length: 16 }, () => []);
  for (const change of changes) groups[digit(change[0], depth)]!.push(change);
  return branch(bucket.children.map((child, index) => (groups[index]!.length ? update(child, groups[index]!, depth + 1) : child)));
}
/** The value `bucket` holds under `key`. */
export function lookup(bucket: Bucket, key: string): unknown {
  for (let depth = 0, at: Bucket | null = bucket; at; depth++) {
    if ("entries" in at) return at.entries.find(([name]) => name === key)?.[1];
    at = at.children[digit(key, depth)]!;
  }
  return undefined;
}
function entriesOf(bucket: Bucket, into: Array<readonly [string, unknown]> = []): Array<readonly [string, unknown]> {
  if ("entries" in bucket) into.push(...bucket.entries);
  else for (const child of bucket.children) if (child) entriesOf(child, into);
  return into;
}

// ---- Working copies -------------------------------------------------------

/** The recorded value a working copy was taken from (a bucket for a map, a
 * frozen array for decisions), so that recording the copy shares whatever
 * did not change. */
const sources = new WeakMap<object, Bucket | readonly IntentDecision[]>();

/** Counters for complexity benchmarks, independent of wall-clock timing. */
export const historyMapDiagnostics = { enumerated: 0, compared: 0, recorded: 0 };
export function resetHistoryMapDiagnostics(): void {
  historyMapDiagnostics.enumerated = historyMapDiagnostics.compared = historyMapDiagnostics.recorded = 0;
}

interface WorkingHistory {
  bucket: Bucket;
  values: Map<string, unknown>;
  removed: Set<string>;
  appended: Set<string>;
}
const histories = new WeakMap<object, WorkingHistory>();

/** History records are immutable values. Keep a bucket plus this evaluation's
 * writes until a caller actually enumerates the map. In particular, loading,
 * cloning, comparing and recording an ordinary head edit need not visit every
 * historical operation. Nodes still use mutable, detached working copies. */
function historyMap<T>(bucket: Bucket, values = new Map<string, unknown>(), removed = new Set<string>(), appended = new Set<string>()): Record<string, T> {
  const working = { bucket, values, removed, appended };
  const target = {} as Record<string, T>;
  let materialized = false;
  const value = (key: string) => removed.has(key) ? undefined : values.has(key) ? values.get(key) : lookup(bucket, key);
  const define = (key: string, next: unknown) => Object.defineProperty(target, key, { value: next, enumerable: true, configurable: true, writable: true });
  const keys = () => {
    if (!materialized) {
      const entries = entriesOf(bucket);
      historyMapDiagnostics.enumerated += entries.length;
      for (const [key, next] of entries) if (!removed.has(key) && !appended.has(key)) define(key, next);
      for (const [key, next] of values) if (!removed.has(key)) define(key, next);
      materialized = true;
    }
    return Object.keys(target);
  };
  const result = new Proxy(target, {
    get: (target, key, receiver) => {
      if (materialized || typeof key !== "string" || removed.has(key)) return Reflect.get(target, key, receiver);
      if (values.has(key)) return values.get(key);
      const known = lookup(bucket, key);
      return known !== undefined ? known : Reflect.get(target, key, receiver);
    },
    set: (_target, key, next) => {
      if (typeof key !== "string") throw Error("History keys must be strings");
      if (removed.has(key)) { appended.add(key); values.delete(key); }
      values.set(key, next); removed.delete(key);
      if (materialized) define(key, next);
      return true;
    },
    deleteProperty: (_target, key) => {
      if (typeof key === "string") { values.delete(key); removed.add(key); delete target[key]; }
      return true;
    },
    has: (target, key) => materialized ? Reflect.has(target, key)
      : typeof key === "string" && !removed.has(key) && (values.has(key) || lookup(bucket, key) !== undefined) || Reflect.has(target, key),
    ownKeys: keys,
    getOwnPropertyDescriptor: (_target, key) => materialized ? Reflect.getOwnPropertyDescriptor(target, key)
      : typeof key === "string" && !removed.has(key) && (values.has(key) || lookup(bucket, key) !== undefined)
        ? { value: value(key), enumerable: true, writable: true, configurable: true } : undefined,
  });
  histories.set(result, working);
  sources.set(result, bucket);
  return result;
}

/** A plain map of a bucket's frozen values, in the order every recorded map
 * keeps its keys: bucket order, except that a map of nodes whose canonical
 * JSON is 2 KiB or less is in key order. */
function materialize<T>(bucket: Bucket, nodes = false): Record<string, T> {
  const entries = entriesOf(bucket);
  if (nodes && 2 + Math.max(0, bucket.count - 1) + bucket.size <= 2048) entries.sort(byKey);
  const map = Object.fromEntries(entries) as Record<string, T>;
  sources.set(map, bucket);
  return map;
}

/** A recorded state to read: its nodes, decisions and records frozen. */
export function viewState(retained: RetainedState): IntentState {
  const { format, tree, root, decisions } = retained;
  const state: IntentState = {
    format, tree, root, decisions: decisions as IntentDecision[],
    nodes: materialize<Node>(retained.nodes, true),
    ...(Object.fromEntries(HISTORY.map((field) => [field, materialize(retained.history[field])])) as Pick<IntentState, HistoryField>),
  };
  return state;
}

/** A recorded state to edit: nodes and decisions copied, records shared. */
export function loadState(retained: RetainedState): IntentState {
  const { format, tree, root } = retained;
  const nodes = copy(materialize<Node>(retained.nodes, true)), decisions = copy(retained.decisions) as IntentDecision[];
  sources.set(nodes, retained.nodes);
  sources.set(decisions, retained.decisions);
  return { format, tree, root, nodes, decisions,
    ...(Object.fromEntries(HISTORY.map((field) => [field, historyMap(retained.history[field])])) as Pick<IntentState, HistoryField>) };
}

/** A value to keep in a working state: frozen values are shared (nothing can
 * change them), anything else is copied. */
export const own = <T>(value: T): T =>
  isObject(value) && !Object.isFrozen(value) ? copy(value) : value;

/** A history map to write: its records as `own` gives them. */
export function cloneMap<T extends Record<string, unknown>>(map: T): T {
  const lazy = histories.get(map);
  if (lazy) return historyMap(lazy.bucket, new Map([...lazy.values].map(([key, value]) => [key, own(value)])), new Set(lazy.removed), new Set(lazy.appended)) as T;
  const result = Object.fromEntries(Object.entries(map).map(([key, value]) => [key, own(value)])) as T;
  const source = sources.get(map);
  if (source) sources.set(result, source);
  return result;
}

/** A state to edit: nodes and decisions copied, history maps as `cloneMap`. */
export function cloneState(state: IntentState): IntentState {
  const { outputs, effects, origins, alternatives, changes, nodes, decisions, ...rest } = state;
  const result: IntentState = {
    ...rest,
    nodes: copy(nodes),
    decisions: copy(decisions),
    outputs: cloneMap(outputs),
    effects: cloneMap(effects),
    origins: cloneMap(origins),
    alternatives: cloneMap(alternatives),
    changes: cloneMap(changes),
  };
  const nodeSource = sources.get(nodes), decisionSource = Object.isFrozen(decisions) ? decisions : sources.get(decisions);
  if (nodeSource) sources.set(result.nodes, nodeSource);
  if (decisionSource) sources.set(result.decisions, decisionSource);
  return result;
}

/** A state to record beside `state` in which only decisions are edited: the
 * decisions copied as `cloneState` copies them, the nodes and history
 * records shared, in maps of its own (so recording it leaves `state`'s
 * sources as they were). Nothing may edit a node or record of either state
 * while the other is in use. */
export function shareState(state: IntentState): IntentState {
  const { outputs, effects, origins, alternatives, changes, nodes, decisions, ...rest } = state;
  const shared = <T extends Record<string, unknown>>(map: T): T => {
    const result = { ...map };
    const source = sources.get(map);
    if (source) sources.set(result, source);
    return result;
  };
  const result: IntentState = {
    ...rest,
    nodes: shared(nodes),
    decisions: copy(decisions),
    outputs: cloneMap(outputs),
    effects: cloneMap(effects),
    origins: cloneMap(origins),
    alternatives: cloneMap(alternatives),
    changes: cloneMap(changes),
  };
  const decisionSource = Object.isFrozen(decisions) ? decisions : sources.get(decisions);
  if (decisionSource) sources.set(result.decisions, decisionSource);
  return result;
}

/** Records of `map` that `base` lacks or holds differently. */
export function since<M extends Record<string, unknown>>(map: M, base: M): M {
  const out: Record<string, unknown> = {};
  const upper = histories.get(map), lower = histories.get(base);
  // Appends to an unchanged persistent source preserve insertion order.
  // Replacements and deletions take the general path, including its ordering.
  const appended = upper && lower && upper.bucket === lower.bucket && !lower.values.size && !lower.removed.size && !upper.removed.size
    && [...upper.values.keys()].every((key) => lookup(upper.bucket, key) === undefined);
  const entries = appended ? Object.entries(Object.fromEntries(upper.values)) : Object.entries(map);
  for (const [key, value] of entries) {
    historyMapDiagnostics.compared++;
    if (value !== undefined && !(Object.hasOwn(base, key) && same(base[key], value))) out[key] = value;
  }
  return out as M;
}

/** `upper` with every record of `lower` it lacks, as `{...lower, ...upper}`. */
export function union<T extends Record<string, unknown>>(lower: T, upper: T): T {
  return { ...cloneMap(lower), ...upper };
}

// ---- Recording ------------------------------------------------------------

/** A frozen value's digest, and its canonical JSON length in UTF-8 bytes and
 * in UTF-16 units (the ordering thresholds below). */
interface Facts { hash: string; size: number; length: number }
const facts = new WeakMap<object, Facts>();
function factsOf(value: unknown): Facts {
  if (isObject(value)) return facts.get(value)!;
  const json = value === undefined ? "" : JSON.stringify(value);
  return { hash: json, size: utf8(json), length: json.length };
}
/** Every frozen value by digest (and key order), while anything holds it, so
 * that equal values recorded anywhere are one object. */
const interned = new Map<string, WeakRef<object>>();
const released = new FinalizationRegistry<string>((key) => {
  if (!interned.get(key)?.deref()) interned.delete(key);
});

/** The frozen canonical copy of a JSON value, its digest, and the bytes it
 * added. An object's keys are in key order, or in bucket order when it has
 * more than sixteen and its canonical JSON exceeds 2 KiB, unless `sorted`:
 * every object of a history record of 2,048 or fewer UTF-16 units is in key
 * order (as the encoding these states once had gave them on load, so what the
 * engine iterates is unchanged). */
function freeze(value: unknown, sorted: boolean): Facts & { value: unknown; bytes: number } {
  if (!isObject(value)) return { value, ...factsOf(value), bytes: factsOf(value).size };
  const known = facts.get(value);
  if (known) return { value, ...known, bytes: 0 };
  let keys: string[], children: Array<Facts & { value: unknown; bytes: number }>, text: string;
  if (Array.isArray(value)) {
    keys = [];
    children = value.map((item) => freeze(item, sorted));
    text = `[${children.map((child) => child.hash).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    children = keys.map((key) => freeze(record[key], sorted));
    text = `{${keys.map((key, index) => `${JSON.stringify(key)}:${children[index]!.hash}`).join(",")}}`;
  }
  let size = 2 + Math.max(0, children.length - 1), length = size;
  for (const [index, child] of children.entries()) {
    const name = keys[index] === undefined ? "" : JSON.stringify(keys[index]);
    size += (name ? utf8(name) + 1 : 0) + child.size;
    length += (name ? name.length + 1 : 0) + child.length;
  }
  const bucketed = !Array.isArray(value) && !sorted && size > 2048 && keys.length > 16;
  const hash = digest(text), key = `${bucketed ? "b" : "k"}${hash}`;
  const existing = interned.get(key)?.deref();
  if (existing) return { value: existing, ...facts.get(existing)!, bytes: 0 };
  const values = new Map(keys.map((key, index) => [key, children[index]!.value]));
  const frozen = Object.freeze(Array.isArray(value)
    ? children.map((child) => child.value)
    : Object.fromEntries((bucketed ? radix(keys, 0) : keys).map((key) => [key, values.get(key)]))) as object;
  facts.set(frozen, { hash, size, length });
  interned.set(key, new WeakRef(frozen));
  released.register(frozen, key);
  const own = size - children.reduce((n, child) => n + child.size, 0);
  return { value: frozen, hash, size, length, bytes: own + children.reduce((n, child) => n + child.bytes, 0) };
}

/** A map as a bucket, sharing every bucket of its source that holds the same
 * values, and the bytes that added. */
function freezeMap(map: Record<string, unknown>, history: boolean): { bucket: Bucket; bytes: number } {
  const lazy = histories.get(map);
  const source = lazy?.bucket ?? sources.get(map) as Bucket | undefined;
  const changes: Array<readonly [string, unknown]> = [];
  // Deletions use the general rebuilding path. Ordinary immutable history
  // only adds/replaces records; scan those writes instead of the entire map.
  const incremental = lazy && !lazy.removed.size && ![...lazy.values.values()].includes(undefined);
  let present = incremental ? lazy.bucket.count : 0, added = 0, bytes = 0;
  for (const key of incremental ? lazy.values.keys() : Object.keys(map)) {
    if (history) historyMapDiagnostics.recorded++;
    const value = map[key];
    if (value === undefined) continue;
    if (!incremental) present++;
    const prior = source ? lookup(source, key) : undefined;
    if (prior === value || (prior !== undefined && same(value, prior))) continue;
    if (prior === undefined) { added++; if (incremental) present++; }
    const fresh = isObject(value) && !facts.has(value);
    let entry = freeze(value, false);
    // A history record of 2,048 or fewer UTF-16 units keeps key order within.
    if (history && fresh && entry.length <= 2048 && entry.size > 2048) entry = freeze(value, true);
    changes.push([key, entry.value]);
    bytes += entry.bytes + utf8(key) + 16;
  }
  builtBuckets = 0;
  let bucket: Bucket;
  if (source && present === source.count + added) bucket = changes.length ? update(source, changes.sort(byKey), 0) : source;
  else {
    // No source, or keys were removed: build the whole map.
    const values = new Map(changes);
    bucket = build(Object.keys(map).filter((key) => map[key] !== undefined).sort()
      .map((key) => [key, values.has(key) ? values.get(key) : lookup(source!, key)] as const), 0);
  }
  return { bucket, bytes: bytes + 256 * builtBuckets };
}

/** Record `state` in `states`. Its identity is a digest of its content and
 * `editable`, so equal states recorded on any path are one state. Returns the
 * identity and the estimated bytes it added (none when already recorded). */
export function retainState(
  states: RetainedStates,
  state: IntentState,
  object: string,
  editable: boolean,
): { id: string; bytes: number } {
  const nodes = freezeMap(state.nodes, false);
  const prior = sources.get(state.decisions) as readonly IntentDecision[] | undefined;
  const decisions = prior && same(state.decisions, prior)
    ? { value: prior, hash: facts.get(prior)!.hash, bytes: 0 }
    : freeze(state.decisions, false);
  const maps = HISTORY.map((field) => freezeMap(state[field], true));
  const id = digest(stableJSONString({
    format: state.format, tree: state.tree, root: state.root, editable,
    nodes: nodes.bucket.hash, decisions: decisions.hash, history: maps.map((map) => map.bucket.hash),
  }));
  const known = states.get(id);
  const bytes = known ? 0 : nodes.bytes + decisions.bytes + maps.reduce((n, map) => n + map.bytes, 0);
  const retained: RetainedState = known ?? {
    format: state.format, tree: state.tree, root: state.root,
    decisions: decisions.value as readonly IntentDecision[],
    nodes: nodes.bucket,
    history: Object.fromEntries(HISTORY.map((field, index) => [field, maps[index]!.bucket])) as Record<HistoryField, Bucket>,
    object, editable, bytes,
  };
  // The working state equals the record now; its later edits share from it.
  sources.set(state.nodes, retained.nodes);
  sources.set(state.decisions, retained.decisions);
  for (const field of HISTORY) sources.set(state[field], retained.history[field]);
  if (!known) states.set(id, retained);
  return { id, bytes };
}

// ---- Saving ---------------------------------------------------------------

/** A recorded state as JSON: its buckets' shape and every value in the key
 * order it was recorded with, so that `decodeRetainedState` rebuilds the same
 * state, iteration order included. */
export function encodeRetainedState(retained: RetainedState): unknown {
  const bucket = (b: Bucket): unknown =>
    "entries" in b ? { entries: b.entries } : { children: b.children.map((child) => (child ? bucket(child) : null)) };
  return {
    format: retained.format, tree: retained.tree, root: retained.root, object: retained.object, editable: retained.editable,
    decisions: retained.decisions, nodes: bucket(retained.nodes),
    history: Object.fromEntries(HISTORY.map((field) => [field, bucket(retained.history[field])])),
  };
}

/** `encodeRetainedState`'s value back as a recorded state, and its identity
 * as `retainState` computes it. Values are frozen as they come, in the order
 * they were saved in; equal values already interned are shared. */
export function decodeRetainedState(value: unknown): { id: string; state: RetainedState } {
  const saved = value as {
    format: IntentState["format"]; tree: string; root: string; object: string; editable: boolean;
    decisions: unknown; nodes: unknown; history: Record<HistoryField, unknown>;
  };
  if (!isObject(saved) || saved.format !== "arbor-merge-intent-state" || typeof saved.tree !== "string"
    || typeof saved.root !== "string" || typeof saved.object !== "string" || typeof saved.editable !== "boolean"
    || !Array.isArray(saved.decisions) || !isObject(saved.history))
    throw new Error("Invalid saved state");
  builtBuckets = 0;
  const bucket = (raw: unknown): Bucket => {
    const b = raw as { entries?: unknown; children?: unknown };
    if (Array.isArray(b?.entries))
      return leaf(b.entries.map((entry: unknown) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Invalid saved bucket");
        return [entry[0], thaw(entry[1]).value] as const;
      }));
    if (Array.isArray(b?.children) && b.children.length === 16)
      return branch(b.children.map((child: unknown) => (child === null ? null : bucket(child))));
    throw new Error("Invalid saved bucket");
  };
  const decisions = thaw(saved.decisions), nodes = bucket(saved.nodes);
  const history = Object.fromEntries(HISTORY.map((field) => [field, bucket(saved.history[field])])) as Record<HistoryField, Bucket>;
  const id = digest(stableJSONString({
    format: saved.format, tree: saved.tree, root: saved.root, editable: saved.editable,
    nodes: nodes.hash, decisions: decisions.hash, history: HISTORY.map((field) => history[field].hash),
  }));
  const bytes = decisions.bytes + nodes.size + HISTORY.reduce((n, field) => n + history[field].size, 0) + 256 * builtBuckets;
  return { id, state: {
    format: saved.format, tree: saved.tree, root: saved.root, decisions: decisions.value as readonly IntentDecision[],
    nodes, history, object: saved.object, editable: saved.editable, bytes,
  } };
}

/** `freeze` for a saved value: the same facts, but the key order it has. A
 * recorded object is in key order or, when bucketed, in `radix` order;
 * interning shares it only with an object recorded in that same order. */
type Thawed = Facts & { value: unknown; bytes: number };

function thaw(value: unknown): Thawed {
  if (isObject(value) && facts.has(value)) return { value, ...facts.get(value)!, bytes: 0 };
  if (!isObject(value)) return { value, ...factsOf(value), bytes: factsOf(value).size };
  if (Array.isArray(value)) return intern(null, value.map(thaw));
  const record = value as Record<string, unknown>, order = Object.keys(record);
  return intern(order, order.map((key) => thaw(record[key])));
}

/** The frozen, interned value of an array (`order` null) or of an object
 * whose keys are `order`, from its members already thawed in that order. */
function intern(order: string[] | null, members: Thawed[]): Thawed {
  let keys: string[], children: Thawed[], text: string;
  if (!order) {
    keys = [];
    children = members;
    text = `[${children.map((child) => child.hash).join(",")}]`;
  } else {
    const values = new Map(order.map((key, index) => [key, members[index]!]));
    if (values.size !== order.length) throw new Error("Saved value repeats a key");
    keys = [...order].sort();
    children = keys.map((key) => values.get(key)!);
    text = `{${keys.map((key, index) => `${JSON.stringify(key)}:${children[index]!.hash}`).join(",")}}`;
  }
  let size = 2 + Math.max(0, children.length - 1), length = size;
  for (const [index, child] of children.entries()) {
    const name = keys[index] === undefined ? "" : JSON.stringify(keys[index]);
    size += (name ? utf8(name) + 1 : 0) + child.size;
    length += (name ? name.length + 1 : 0) + child.length;
  }
  const hash = digest(text);
  // The order `freeze` gives an object, as JavaScript lays its keys out
  // (integer-like keys first).
  const laid = (order: string[]) => Object.keys(Object.fromEntries(order.map((key) => [key, 0])));
  const inOrder = (order: string[], expected: string[]) => order.every((key, index) => key === expected[index]);
  const kind = !order || inOrder(order, laid(keys)) ? "k"
    : keys.length > 16 && inOrder(order, laid(radix(keys, 0))) ? "b" : null;
  if (kind === null) throw new Error("Saved value is in no recorded order");
  const existing = interned.get(`${kind}${hash}`)?.deref();
  if (existing) return { value: existing, ...facts.get(existing)!, bytes: 0 };
  const byKey = order ? new Map(keys.map((key, index) => [key, children[index]!.value])) : null;
  const frozen = Object.freeze(!order
    ? children.map((child) => child.value)
    : Object.fromEntries(order.map((key) => [key, byKey!.get(key)]))) as object;
  facts.set(frozen, { hash, size, length });
  interned.set(`${kind}${hash}`, new WeakRef(frozen));
  released.register(frozen, `${kind}${hash}`);
  const own = size - children.reduce((n, child) => n + child.size, 0);
  return { value: frozen, hash, size, length, bytes: own + children.reduce((n, child) => n + child.bytes, 0) };
}


/** Private cache records have their own hashes, distinct from semantic state
 * identities. Objects and buckets are encoded once while they remain alive;
 * unchanged persistent branches need neither traversal nor hashing on save. */
export class StateRecordWriter {
  private known = new WeakMap<object, string>();
  constructor(private readonly put: (bytes: Uint8Array) => string) {}
  private record(value: unknown): string { return this.put(encoder.encode(JSON.stringify(value))); }
  value(value: unknown): unknown {
    if (!isObject(value)) return typeof value === "string" && value.length >= 256 ? [this.record(["scalar", value])] : value;
    const known = this.known.get(value);
    if (known) return [known];
    // Every frozen value is its own record, however small: values are shared
    // widely within and across states, and a restore decodes each record
    // once (writing small values in place saved about a third of the bytes
    // but rebuilt each one wherever it appeared, slowing live restores).
    const id = this.record(Array.isArray(value)
      ? ["array", value.map((v) => this.value(v))]
      : ["object", Object.keys(value).map((key) => [key, this.value((value as Record<string, unknown>)[key])])]);
    this.known.set(value, id);
    return [id];
  }
  private bucket(b: Bucket): string {
    const known = this.known.get(b);
    if (known) return known;
    const id = this.record("entries" in b
      ? ["leaf", b.entries.map(([key, value]) => [key, this.value(value)])]
      : ["branch", b.children.map((child) => child ? this.bucket(child) : null)]);
    this.known.set(b, id);
    return id;
  }
  state(s: RetainedState): string {
    const known = this.known.get(s);
    if (known) return known;
    const id = this.record(["state", s.format, s.tree, s.root, s.object, s.editable,
      this.value(s.decisions), this.bucket(s.nodes), HISTORY.map((field) => this.bucket(s.history[field]))]);
    this.known.set(s, id);
    return id;
  }
  /** Forget identities after a failed transaction or collection: a later save
   * must publish dependencies again before it can publish their manifest. */
  clear(): void { this.known = new WeakMap(); }
}

/** Hydrate shared buckets and frozen values directly. Every record is read and
 * decoded once per restore; no expanded snapshot JSON is constructed. The
 * adapter verifies record hashes, and state() recomputes semantic identities. */
export class StateRecordReader {
  private values = new Map<string, unknown>();
  private buckets = new Map<string, Bucket>();
  private states = new Map<string, { id: string; state: RetainedState }>();
  private active = new Set<string>();
  private addedBytes = 0;
  constructor(private readonly get: (id: string) => Uint8Array) {}
  private read<T>(id: string, decode: (record: unknown[]) => T): T {
    if (this.active.has(id)) throw new Error("Cyclic cache record");
    this.active.add(id);
    try {
      const record: unknown = JSON.parse(new TextDecoder().decode(this.get(id)));
      if (!Array.isArray(record)) throw new Error("Invalid cache record");
      return decode(record);
    } finally { this.active.delete(id); }
  }
  value(ref: unknown): unknown {
    if (!Array.isArray(ref)) {
      if (isObject(ref)) throw new Error("Invalid cache value reference");
      return ref;
    }
    const built = this.member(ref);
    this.addedBytes += built.bytes;
    return built.value;
  }
  /** A member as interned, with the bytes it newly added (none for a
   * record already decoded, which counted them then). */
  private member(ref: unknown): Thawed {
    if (!Array.isArray(ref)) {
      if (isObject(ref)) throw new Error("Invalid cache value reference");
      return { value: ref, ...factsOf(ref), bytes: factsOf(ref).size };
    }
    if (ref.length !== 1 || typeof ref[0] !== "string") throw new Error("Invalid cache value reference");
    const id = ref[0];
    if (this.values.has(id)) {
      const value = this.values.get(id);
      return { value, ...factsOf(value), bytes: 0 };
    }
    const built = this.read(id, ([tag, data]): Thawed => {
      if (tag === "scalar" && !isObject(data)) return { value: data, ...factsOf(data), bytes: factsOf(data).size };
      return this.composite(tag, data);
    });
    this.addedBytes += built.bytes;
    this.values.set(id, built.value);
    return { ...built, bytes: 0 };
  }
  /** An array or object built directly from its decoded members, in their
   * recorded order. */
  private composite(tag: unknown, data: unknown): Thawed {
    if (tag === "array" && Array.isArray(data)) return intern(null, data.map((ref) => this.member(ref)));
    if (tag === "object" && Array.isArray(data)) {
      for (const pair of data)
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") throw new Error("Invalid cache member");
      const pairs = data as Array<[string, unknown]>;
      return intern(pairs.map(([key]) => key), pairs.map(([, ref]) => this.member(ref)));
    }
    throw new Error("Invalid cache value");
  }
  private bucket(id: string): Bucket {
    const known = this.buckets.get(id);
    if (known) return known;
    const b = this.read(id, ([tag, data]) => {
      if (tag === "leaf" && Array.isArray(data)) return leaf(data.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") throw new Error("Invalid cache leaf");
        return [pair[0], this.value(pair[1])] as const;
      }));
      if (tag === "branch" && Array.isArray(data) && data.length === 16)
        return branch(data.map((ref) => ref === null ? null : this.bucket(String(ref))));
      throw new Error("Invalid cache bucket");
    });
    this.addedBytes += 256;
    this.buckets.set(id, b);
    return b;
  }
  state(ref: string): { id: string; state: RetainedState } {
    const known = this.states.get(ref);
    if (known) return known;
    const before = this.addedBytes;
    const decoded = this.read(ref, ([tag, format, tree, root, object, editable, decisionsRef, nodesRef, historyRefs]) => {
      if (tag !== "state" || format !== "arbor-merge-intent-state" || typeof tree !== "string"
        || typeof root !== "string" || typeof object !== "string" || typeof editable !== "boolean"
        || !Array.isArray(historyRefs) || historyRefs.length !== HISTORY.length) throw new Error("Invalid cache state");
      const decisions = this.value(decisionsRef);
      if (!Array.isArray(decisions)) throw new Error("Invalid cache decisions");
      const nodes = this.bucket(String(nodesRef));
      const history = Object.fromEntries(HISTORY.map((field, index) => [field, this.bucket(String(historyRefs[index]))])) as Record<HistoryField, Bucket>;
      const id = digest(stableJSONString({ format, tree, root, editable, nodes: nodes.hash,
        decisions: facts.get(decisions)!.hash, history: HISTORY.map((field) => history[field].hash) }));
      const state: RetainedState = { format, tree, root, object, editable, decisions, nodes, history, bytes: this.addedBytes - before };
      return { id, state };
    });
    this.states.set(ref, decoded);
    return decoded;
  }
}
