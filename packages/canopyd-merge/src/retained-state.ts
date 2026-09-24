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
  builtBuckets++;
  if (entries.length <= 16 || depth === 64) {
    let size = 0;
    const lines = entries.map(([key, value]) => {
      const known = factsOf(value), name = JSON.stringify(key);
      size += utf8(name) + 1 + known.size;
      return `${name}:${known.hash}`;
    });
    return { entries, hash: digest(`L${lines.join("\n")}`), size, count: entries.length };
  }
  const buckets: Array<Array<readonly [string, unknown]>> = Array.from({ length: 16 }, () => []);
  for (const entry of entries) buckets[digit(entry[0], depth)]!.push(entry);
  return branch(buckets.map((bucket) => (bucket.length ? build(bucket, depth + 1) : null)));
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
  const state = viewState(retained), nodes = copy(state.nodes), decisions = copy(state.decisions);
  sources.set(nodes, retained.nodes);
  sources.set(decisions, retained.decisions);
  return { ...state, nodes, decisions };
}

/** A value to keep in a working state: frozen values are shared (nothing can
 * change them), anything else is copied. */
export const own = <T>(value: T): T =>
  isObject(value) && !Object.isFrozen(value) ? copy(value) : value;

/** A history map to write: its records as `own` gives them. */
export function cloneMap<T extends Record<string, unknown>>(map: T): T {
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

/** Records of `map` that `base` lacks or holds differently. */
export function since<M extends Record<string, unknown>>(map: M, base: M): M {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map))
    if (value !== undefined && !(Object.hasOwn(base, key) && same(base[key], value))) out[key] = value;
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
  const source = sources.get(map) as Bucket | undefined;
  const changes: Array<readonly [string, unknown]> = [];
  let present = 0, added = 0, bytes = 0;
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value === undefined) continue;
    present++;
    const prior = source ? lookup(source, key) : undefined;
    if (prior === value || (prior !== undefined && same(value, prior))) continue;
    if (prior === undefined) added++;
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
