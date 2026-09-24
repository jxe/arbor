import { stableJSONString, hashObject } from "@overstory/protocol";
const encoder = new TextEncoder();
const FORMAT = "arbor-merge-value-v1";
type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value };
type Item = { inline: Value } | { ref: string };
type Chunk =
  | { format: typeof FORMAT; kind: "value"; value: Value }
  | { format: typeof FORMAT; kind: "object"; entries: Array<[string, Item]> }
  | { format: typeof FORMAT; kind: "array"; items: Item[] }
  | {
      format: typeof FORMAT;
      kind: "object-branches" | "array-branches";
      children: string[];
    };
/** An object-store hash: the one pattern every merge-package format checks. */
export const OBJECT_HASH = /^sha256:[a-f0-9]{64}$/;
const HASH = OBJECT_HASH;
/** Canonical JSON bytes: the exact encoding every stored merge format uses. */
export const encodeJSON = (value: unknown): Uint8Array =>
  encoder.encode(stableJSONString(value));
const encode = encodeJSON;

/** Hex SHA-256 of a map key, which radix partitions consume one digit per
 * level. Keys repeat across levels, lookups and writes, so the digest is
 * memoized; the bound keeps a long-lived worker's memory flat. */
const keyHashes = new Map<string, string>();
export function keyHash(key: string): string {
  let known = keyHashes.get(key);
  if (known === undefined) {
    known = hashObject(encoder.encode(key)).slice(7);
    if (keyHashes.size >= 65_536) keyHashes.clear();
    keyHashes.set(key, known);
  }
  return known;
}

/** Canonical JSON length of `value`: exact up to `limit`, `limit + 1` above
 * it, without serializing more than the bound requires. `measure` counts one
 * serialized scalar or key, in UTF-8 bytes or UTF-16 units as the caller's
 * threshold is defined. `sizes` memoizes shared subtrees within one write. */
export function boundedJSONSize(
  value: unknown,
  limit: number,
  measure: (json: string) => number,
  sizes = new WeakMap<object, number>(),
): number {
  const size = (value: unknown): number => {
    if (value === null || typeof value !== "object")
      return measure(stableJSONString(value) ?? "");
    const known = sizes.get(value);
    if (known !== undefined) return known;
    let total = 2,
      count = 0;
    if (Array.isArray(value)) {
      for (const child of value) {
        total += (count++ ? 1 : 0) + size(child);
        if (total > limit) break;
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        total += (count++ ? 1 : 0) + measure(JSON.stringify(key)) + 1 + size(child);
        if (total > limit) break;
      }
    }
    const bounded = Math.min(total, limit + 1);
    sizes.set(value, bounded);
    return bounded;
  };
  return size(value);
}
const utf8Length = (json: string) => Buffer.byteLength(json);

/** Deterministic immutable chunks. Object keys use a radix partition so one new
 * entry rewrites only its bucket and ancestors, rather than shifting all pages. */
export function storeSharedValue(
  input: unknown,
  put: (bytes: Uint8Array) => string,
): string {
  // Threshold decisions need only a bounded size, not a serialization of every
  // historical value at each ancestor. Memoization is local to this immutable
  // write, so a later mutation can never reuse stale bytes or hashes.
  const sizes = new WeakMap<object, number>();
  const stored = new WeakMap<object, string>();
  const size = (value: Value): number =>
    boundedJSONSize(value, 2048, utf8Length, sizes);
  const emit = (value: Chunk) => put(encode(value));
  const item = (value: Value): Item =>
    size(value) <= 512 ? { inline: value } : { ref: store(value) };
  const object = (entries: Array<[string, Value]>, depth = 0): string => {
    if (entries.length <= 16 || depth === 64)
      return emit({
        format: FORMAT,
        kind: "object",
        entries: entries.map(([key, value]) => [key, item(value)]),
      });
    const buckets = new Map<string, Array<[string, Value]>>();
    for (const entry of entries) {
      const digit = keyHash(entry[0])[depth]!;
      const bucket = buckets.get(digit) ?? [];
      bucket.push(entry);
      buckets.set(digit, bucket);
    }
    return emit({
      format: FORMAT,
      kind: "object-branches",
      children: [...buckets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, bucket]) => object(bucket, depth + 1)),
    });
  };
  const array = (items: Item[]): string => {
    if (items.length <= 32)
      return emit({ format: FORMAT, kind: "array", items });
    let children: string[] = [];
    for (let i = 0; i < items.length; i += 32)
      children.push(array(items.slice(i, i + 32)));
    while (children.length > 32) {
      const next: string[] = [];
      for (let i = 0; i < children.length; i += 32)
        next.push(
          emit({
            format: FORMAT,
            kind: "array-branches",
            children: children.slice(i, i + 32),
          }),
        );
      children = next;
    }
    return emit({ format: FORMAT, kind: "array-branches", children });
  };
  const store = (value: Value): string => {
    const isObject = value !== null && typeof value === "object";
    const known = isObject ? stored.get(value) : undefined;
    if (known) return known;
    const result =
      size(value) <= 2048
        ? emit({ format: FORMAT, kind: "value", value })
        : Array.isArray(value)
          ? array(value.map(item))
          : isObject
            ? object(
                Object.entries(value).sort(([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              )
            : emit({ format: FORMAT, kind: "value", value });
    if (isObject) stored.set(value, result);
    return result;
  };
  return store(input as Value);
}

export async function loadSharedValue(
  root: string,
  load: (hash: string) => Promise<Uint8Array>,
): Promise<unknown> {
  let expandedBytes = 0;
  const read = async (hash: string) => {
    if (!HASH.test(hash)) throw Error("Invalid state chunk reference");
    const bytes = await load(hash);
    expandedBytes += bytes.length;
    if (expandedBytes > 128 * 1024 * 1024)
      throw Error("State chunk graph exceeds byte budget");
    if (hashObject(bytes) !== hash) throw Error("Invalid state chunk hash");
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const active = new Set<string>();
  let count = 0;
  const item = async (raw: any, depth: number): Promise<Value> => {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length !== 1)
      throw Error("Invalid state chunk item");
    if (Object.hasOwn(raw, "inline")) return raw.inline;
    if (Object.hasOwn(raw, "ref")) return value(raw.ref, depth + 1);
    throw Error("Invalid state chunk item");
  };
  const value = async (hash: string, depth: number): Promise<Value> => {
    if (depth > 128 || ++count > 1_000_000 || active.has(hash))
      throw Error("State chunk graph exceeds budget");
    active.add(hash);
    try {
      const chunk = await read(hash);
      if (chunk?.format !== FORMAT) throw Error("Invalid state chunk format");
      const fields = Object.keys(chunk).sort().join();
      if (chunk.kind === "value" && fields === "format,kind,value")
        return chunk.value;
      if (
        chunk.kind === "array" &&
        fields === "format,items,kind" &&
        Array.isArray(chunk.items)
      ) {
        const result: Value[] = [];
        for (const entry of chunk.items) result.push(await item(entry, depth));
        return result;
      }
      if (
        chunk.kind === "object" &&
        fields === "entries,format,kind" &&
        Array.isArray(chunk.entries)
      ) {
        const result: Record<string, Value> = Object.create(null);
        for (const entry of chunk.entries) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            Object.hasOwn(result, entry[0])
          )
            throw Error("Invalid state chunk key");
          result[entry[0]] = await item(entry[1], depth);
        }
        return result;
      }
      if (
        (chunk.kind === "object-branches" || chunk.kind === "array-branches") &&
        fields === "children,format,kind" &&
        Array.isArray(chunk.children)
      ) {
        if (chunk.kind === "array-branches") {
          const result: Value[] = [];
          for (const child of chunk.children) {
            const part = await value(child, depth + 1);
            if (!Array.isArray(part)) throw Error("Invalid array branch");
            for (const entry of part) result.push(entry);
          }
          return result;
        }
        const result: Record<string, Value> = Object.create(null);
        for (const child of chunk.children) {
          const part = await value(child, depth + 1);
          if (!part || typeof part !== "object" || Array.isArray(part))
            throw Error("Invalid object branch");
          for (const [key, entry] of Object.entries(part)) {
            if (Object.hasOwn(result, key))
              throw Error("Duplicate state chunk key");
            result[key] = entry;
          }
        }
        return result;
      }
      throw Error("Invalid state chunk");
    } finally {
      active.delete(hash);
    }
  };
  return value(root, 0);
}
