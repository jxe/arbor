import { LazyStateMap, updateStateMap } from "./state-map.ts";

/** Thrown when evaluation reads a history record it did not load first. It is a
 * bug in the evaluator, never a merge outcome: silently answering "absent" would
 * change results without any test noticing. */
export class HistoryMiss extends Error {
  constructor(field: string, key: string) {
    super(`History record read before it was loaded: ${field}/${key}`);
  }
}

type Read = (hash: string) => Promise<Uint8Array>;
type Put = (bytes: Uint8Array) => string;

/** One history map of a lazily loaded state: the stored map it came from, the
 * records read from it so far (undefined = known absent), and local writes. */
class History {
  readonly values = new Map<string, unknown>();
  readonly dirty = new Set<string>();
  constructor(
    readonly field: string,
    readonly source: LazyStateMap,
  ) {}
  known(key: string) {
    if (!this.values.has(key)) throw new HistoryMiss(this.field, key);
    return this.values.get(key);
  }
}

const views = new WeakMap<object, History>();

function view(history: History): Record<string, unknown> {
  const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (target, key) =>
      typeof key === "symbol" ? Reflect.get(target, key) : history.known(key),
    has: (target, key) =>
      typeof key === "symbol"
        ? Reflect.has(target, key)
        : history.known(key) !== undefined,
    getOwnPropertyDescriptor: (target, key) => {
      if (typeof key === "symbol")
        return Reflect.getOwnPropertyDescriptor(target, key);
      const value = history.known(key);
      return value === undefined
        ? undefined
        : { value, writable: true, enumerable: true, configurable: true };
    },
    set: (_target, key, value) => {
      if (typeof key === "symbol") return false;
      history.values.set(key, value);
      history.dirty.add(key);
      return true;
    },
    deleteProperty: (_target, key) => {
      throw new HistoryMiss(history.field, `delete ${String(key)}`);
    },
    ownKeys: () => {
      throw new HistoryMiss(history.field, "*");
    },
  });
  views.set(proxy, history);
  return proxy;
}

export function lazyHistory(field: string, root: string, read: Read) {
  return view(new History(field, new LazyStateMap(root, read)));
}

export function isLazy(map: object): boolean {
  return views.has(map);
}

/** Load `keys` so later synchronous reads of them succeed. Plain maps already
 * hold everything. */
export async function need(map: object, keys: Iterable<string>) {
  const history = views.get(map);
  if (!history) return;
  for (const key of keys)
    if (!history.values.has(key))
      history.values.set(key, await history.source.get(key));
}

/** Records in `map` that `base` lacks or holds differently, loading them (and
 * base's copy of each key) so ordinary reads work afterwards. For two lazy maps
 * of the same field this reads only the buckets that differ. */
export async function since(
  map: Record<string, unknown>,
  base: Record<string, unknown>,
  same: (a: unknown, b: unknown) => boolean,
): Promise<Record<string, unknown>> {
  const mine = views.get(map);
  let candidates: Record<string, unknown>;
  if (!mine) candidates = map;
  else {
    const other = views.get(base);
    candidates = other
      ? await mine.source.since(other.source.root)
      : await mine.source.since(emptyRoot(mine));
    // Records written since load count whether or not the stored map has them.
    for (const key of mine.dirty) candidates[key] = mine.values.get(key);
    for (const [key, value] of Object.entries(candidates))
      if (!mine.dirty.has(key)) mine.values.set(key, value);
    if (other) for (const key of other.dirty) {
      if (!mine.values.has(key)) mine.values.set(key, await mine.source.get(key));
      if (mine.values.get(key) !== undefined) candidates[key] = mine.values.get(key);
    }
  }
  await need(base, Object.keys(candidates));
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(candidates))
    if (value !== undefined && !(Object.hasOwn(base, key) && same(base[key], value)))
      out[key] = value;
  return out;
}

function emptyRoot(_history: History): string {
  throw new HistoryMiss(_history.field, "since a plain map");
}

/** A copy that shares the stored map and copies what was loaded or written. */
export function cloneHistory<T extends object>(map: T, clone: <V>(value: V) => V): T {
  const history = views.get(map);
  if (!history) return clone(map);
  const copy = new History(history.field, history.source);
  for (const [key, value] of history.values) copy.values.set(key, clone(value));
  for (const key of history.dirty) copy.dirty.add(key);
  return view(copy) as T;
}

/** Store a lazy map by path-copying only the buckets holding written records. */
export function storeHistory(map: object, read: Read, put: Put): Promise<string> | undefined {
  const history = views.get(map);
  if (!history) return undefined;
  const updates: Record<string, unknown> = Object.create(null);
  for (const key of history.dirty) updates[key] = history.values.get(key);
  return updateStateMap(history.source.root, updates, read, put);
}

/** Every stored object read through these maps, for proof weight. */
export function touched(...maps: object[]): Set<string> {
  const out = new Set<string>();
  for (const map of maps)
    for (const hash of views.get(map)?.source.touched ?? []) out.add(hash);
  return out;
}

/** `upper` with every record of `lower` it lacks, as `{...lower, ...upper}`.
 * Wrapped: a view resolved from a promise would be probed for `then`. */
export async function union<T extends Record<string, unknown>>(
  lower: T,
  upper: T,
  same: (a: unknown, b: unknown) => boolean,
): Promise<{ map: T }> {
  if (!views.has(lower) && !views.has(upper)) return { map: { ...structuredClone(lower), ...upper } };
  const out = cloneHistory(upper, structuredClone) as Record<string, unknown>;
  for (const [key, value] of Object.entries(await since(lower, upper, same)))
    if (!Object.hasOwn(upper, key)) out[key] = structuredClone(value);
  return { map: out as T };
}
