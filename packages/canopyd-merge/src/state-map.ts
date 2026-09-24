import { boundedJSONSize, encodeJSON, keyHash, loadSharedValue, OBJECT_HASH, storeSharedValue } from "./state-value.ts";
import { hashObject } from "@overstory/protocol";

const format = "arbor-state-map-v1";
const hashPattern = OBJECT_HASH;
type Entry = [string, string];
type Node =
  | { format: typeof format; entries: Entry[] }
  | { format: typeof format; children: (string | null)[] };
type Read = (hash: string) => Promise<Uint8Array>;
type Put = (bytes: Uint8Array) => string;
const emit = (value: unknown, put: Put) => put(encodeJSON(value));
const digit = (key: string, depth: number) =>
  parseInt(keyHash(key)[depth]!, 16);

async function readJSON(hash: string, read: Read): Promise<any> {
  if (!hashPattern.test(hash)) throw Error("Invalid state map reference");
  const bytes = await read(hash);
  if (hashObject(bytes) !== hash) throw Error("Invalid state map hash");
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function node(hash: string, read: Read, prefix: string): Promise<Node> {
  if (prefix.length > 64) throw Error("State map exceeds depth budget");
  const value = await readJSON(hash, read);
  if (value?.format !== format) throw Error("Invalid state map format");
  const keys = Object.keys(value).sort().join();
  if (
    keys === "entries,format" &&
    Array.isArray(value.entries) &&
    value.entries.length <= 16
  ) {
    let previous: string | undefined;
    for (const entry of value.entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        !hashPattern.test(entry[1]) ||
        !keyHash(entry[0]).startsWith(prefix) ||
        (previous !== undefined && previous >= entry[0])
      )
        throw Error("Invalid state map entry");
      previous = entry[0];
    }
    return value;
  }
  if (
    keys === "children,format" &&
    prefix.length < 64 &&
    Array.isArray(value.children) &&
    value.children.length === 16 &&
    value.children.every(
      (h: unknown) =>
        h === null || (typeof h === "string" && hashPattern.test(h)),
    )
  )
    return value;
  throw Error("Invalid state map node");
}
function build(entries: Entry[], put: Put, depth = 0): string {
  if (entries.length <= 16)
    return emit(
      {
        format,
        entries: entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      },
      put,
    );
  if (depth >= 64) throw Error("State map key collision");
  const buckets: Entry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) buckets[digit(entry[0], depth)]!.push(entry);
  return emit(
    {
      format,
      children: buckets.map((entries) =>
        entries.length ? build(entries, put, depth + 1) : null,
      ),
    },
    put,
  );
}
function record(value: unknown, put: Put): string {
  // Large records contain growing before/after piece sequences. Chunk those
  // sequences so unchanged pages are shared between versions, not copied into
  // every historical effect. Small scalar records stay inline.
  // The threshold counts UTF-16 units of the canonical JSON, bounded rather
  // than serializing a large record only to measure it.
  if (boundedJSONSize(value, 2048, (json) => json.length) <= 2048)
    return emit({ format: "arbor-state-record-v1", value }, put);
  return emit(
    { format: "arbor-state-record-v2", value: storeSharedValue(value, put) },
    put,
  );
}
async function readRecord(hash: string, read: Read): Promise<unknown> {
  const value = await readJSON(hash, read);
  if (
    !["arbor-state-record-v1", "arbor-state-record-v2"].includes(
      value?.format,
    ) ||
    Object.keys(value).sort().join() !== "format,value"
  )
    throw Error("Invalid state record");
  return value.format === "arbor-state-record-v2"
    ? loadSharedValue(value.value, read)
    : value.value;
}
export function storeStateMap(
  values: Record<string, unknown>,
  put: Put,
): string {
  return build(
    Object.entries(values).map(([key, value]) => [key, record(value, put)]),
    put,
  );
}
/** `nodes` caches validated nodes by hash and prefix across lookups. */
export async function getStateMap(
  root: string,
  key: string,
  read: Read,
  nodes?: Map<string, Promise<Node>>,
): Promise<unknown> {
  let hash = root,
    prefix = "";
  for (;;) {
    let pending = nodes?.get(prefix + ":" + hash);
    if (!pending) {
      pending = node(hash, read, prefix);
      nodes?.set(prefix + ":" + hash, pending);
    }
    const value = await pending;
    if ("entries" in value) {
      const entry = value.entries.find(([name]) => name === key);
      return entry ? readRecord(entry[1], read) : undefined;
    }
    const index = digit(key, prefix.length),
      child = value.children[index];
    if (!child) return undefined;
    prefix += index.toString(16);
    hash = child;
  }
}
/** Path-copy only the buckets containing new or replaced records. No old record
 * values are loaded, and untouched branches retain their exact hashes. */
export async function updateStateMap(
  root: string,
  updates: Record<string, unknown>,
  read: Read,
  put: Put,
): Promise<string> {
  const changes: Entry[] = Object.entries(updates).map(([key, value]) => [
    key,
    record(value, put),
  ]);
  const update = async (
    hash: string | null,
    entries: Entry[],
    prefix: string,
  ): Promise<string> => {
    if (!entries.length) return hash!;
    if (!hash) return build(entries, put, prefix.length);
    const value = await node(hash, read, prefix);
    if ("entries" in value)
      return build(
        [...new Map([...value.entries, ...entries])],
        put,
        prefix.length,
      );
    const buckets: Entry[][] = Array.from({ length: 16 }, () => []);
    for (const entry of entries)
      buckets[digit(entry[0], prefix.length)]!.push(entry);
    const children = [...value.children];
    for (let i = 0; i < 16; i++)
      if (buckets[i]!.length)
        children[i] = await update(
          children[i]!,
          buckets[i]!,
          prefix + i.toString(16),
        );
    return emit({ format, children }, put);
  };
  return changes.length ? update(root, changes, "") : root;
}
export async function loadStateMap(
  root: string,
  read: Read,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = Object.create(null);
  let visits = 0;
  const visit = async (hash: string, prefix: string): Promise<void> => {
    if (++visits > 1_000_000) throw Error("State map exceeds object budget");
    const value = await node(hash, read, prefix);
    if ("entries" in value) {
      for (const [key, hash] of value.entries) {
        if (++visits > 1_000_000)
          throw Error("State map exceeds object budget");
        output[key] = await readRecord(hash, read);
      }
    } else
      for (let i = 0; i < 16; i++)
        if (value.children[i])
          await visit(value.children[i]!, prefix + i.toString(16));
  };
  await visit(root, "");
  return output;
}

/** Records under `root` whose key is absent from `since` or whose record hash
 * differs. Identical subtrees are skipped by hash, so the cost is the changed
 * buckets, not the map size. */
export async function diffStateMap(
  root: string,
  since: string,
  read: Read,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = Object.create(null);
  const all = async (hash: string, prefix: string): Promise<Entry[]> => {
    const value = await node(hash, read, prefix);
    if ("entries" in value) return value.entries;
    const out: Entry[] = [];
    for (let i = 0; i < 16; i++)
      if (value.children[i])
        out.push(...(await all(value.children[i]!, prefix + i.toString(16))));
    return out;
  };
  const visit = async (a: string, b: string | null, prefix: string): Promise<void> => {
    if (a === b) return;
    const left = await node(a, read, prefix);
    const right = b ? await node(b, read, prefix) : undefined;
    if ("children" in left && right && "children" in right) {
      for (let i = 0; i < 16; i++)
        if (left.children[i])
          await visit(left.children[i]!, right.children[i] ?? null, prefix + i.toString(16));
      return;
    }
    const mine = await all(a, prefix);
    const theirs = new Map(b ? await all(b, prefix) : []);
    for (const [key, hash] of mine)
      if (theirs.get(key) !== hash) output[key] = await readRecord(hash, read);
  };
  await visit(root, since, "");
  return output;
}

/** A read-through view of one history map. Records load on demand and are kept. */
export class LazyStateMap {
  private readonly values = new Map<string, unknown>();
  /** Parsed nodes, so lookups share the path from the root. */
  private readonly nodes = new Map<string, Promise<Node>>();
  constructor(readonly root: string, private readonly read: Read) {}
  async get(key: string): Promise<unknown> {
    if (this.values.has(key)) return this.values.get(key);
    const value = await getStateMap(this.root, key, this.read, this.nodes);
    this.values.set(key, value);
    return value;
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
  /** Records added or replaced since another root of the same map. */
  since(root: string): Promise<Record<string, unknown>> {
    return diffStateMap(this.root, root, this.read);
  }
}
