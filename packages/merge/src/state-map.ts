import { loadSharedValue, storeSharedValue } from "./state-value.ts";
import { stableJSONString } from "@arbor/core";
import { hashObject } from "@arbor/wire";

const format = "arbor-state-map-v1";
const encoder = new TextEncoder();
const hashPattern = /^sha256:[a-f0-9]{64}$/;
type Entry = [string, string];
type Node =
  | { format: typeof format; entries: Entry[] }
  | { format: typeof format; children: (string | null)[] };
type Read = (hash: string) => Promise<Uint8Array>;
type Put = (bytes: Uint8Array) => string;
const emit = (value: unknown, put: Put) =>
  put(encoder.encode(stableJSONString(value)));
const keyHash = (key: string) => hashObject(encoder.encode(key)).slice(7);
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
  if (stableJSONString(value).length <= 2048)
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
export async function getStateMap(
  root: string,
  key: string,
  read: Read,
): Promise<unknown> {
  let hash = root,
    prefix = "";
  for (;;) {
    const value = await node(hash, read, prefix);
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

type MapProof = {
  values: Readonly<Record<string, unknown>>;
  objects: ReadonlySet<string>;
  bytes: number;
  visits: number;
  references: ReadonlySet<string>;
};
type RecordProof = {
  value: unknown;
  bytes: number;
  objects: ReadonlySet<string>;
  references: ReadonlySet<string>;
};
/** Semantic facts only, never evidence of durable availability. Keys include the
 * record schema and radix position so reuse cannot change an object's role. */
export class StateMapValidationCache {
  private readonly entries = new Map<
    string,
    { proof: MapProof | RecordProof; weight: number }
  >();
  private weight = 0;
  /** Cumulative diagnostics; callers diff snapshots. */
  readonly stats = { hits: 0, misses: 0, sets: 0, rejected: 0, evictions: 0 };
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  /** Current accounted weight and entry count. */
  get size(): { bytes: number; entries: number } {
    return { bytes: this.weight, entries: this.entries.size };
  }
  get(key: string): MapProof | RecordProof | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.stats.misses++; return undefined; }
    this.stats.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.proof;
  }
  set(key: string, proof: MapProof | RecordProof, weight: number) {
    if (weight > this.maxBytes) { this.stats.rejected++; return; }
    this.stats.sets++;
    const prior = this.entries.get(key);
    if (prior) this.weight -= prior.weight;
    this.entries.delete(key);
    this.entries.set(key, { proof, weight });
    this.weight += weight;
    while (this.weight > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.weight -= this.entries.get(oldest)!.weight;
      this.entries.delete(oldest);
      this.stats.evictions++;
    }
  }
}
function freezeValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}
/** Revalidate only changed branches/records; report the complete dependency set
 * even on cache hits. The authority must separately verify their availability. */
export async function loadValidatedStateMap(
  root: string,
  read: Read,
  options: {
    cache: StateMapValidationCache;
    role: string;
    validate: (value: unknown) => unknown;
    references?: (value: unknown) => ReadonlySet<string>;
    maxBytes: number;
  },
): Promise<MapProof> {
  const check = <T extends { bytes: number; visits: number }>(proof: T) => {
    if (proof.bytes > options.maxBytes || proof.visits > 1_000_000)
      throw Error("State map exceeds verification budget");
    return proof;
  };
  const visit = async (hash: string, prefix: string): Promise<MapProof> => {
    const key = JSON.stringify(["map", options.role, prefix, hash]);
    const cached = options.cache.get(key) as MapProof | undefined;
    if (cached) return check(cached);
    let bytes = 0;
    const value = await node(
      hash,
      async (h) => {
        const b = await read(h);
        bytes += b.length;
        return b;
      },
      prefix,
    );
    const ownBytes = bytes;
    const values: Record<string, unknown> = Object.create(null);
    const objects = new Set([hash]);
    const references = new Set<string>();
    let visits = 1;
    if ("entries" in value) {
      for (const [name, hash] of value.entries) {
        const recordKey = JSON.stringify(["record", options.role, hash]);
        let record = options.cache.get(recordKey) as RecordProof | undefined;
        if (!record) {
          let length = 0;
          const recordObjects = new Set<string>();
          const raw = await readRecord(hash, async (h) => {
            const b = await read(h);
            length += b.length;
            recordObjects.add(h);
            return b;
          });
          const value = freezeValue(options.validate(raw));
          record = {
            value,
            bytes: length,
            objects: recordObjects,
            references: options.references?.(value) ?? new Set(),
          };
          options.cache.set(
            recordKey,
            record,
            length * 2 +
              (recordObjects.size + record.references.size) * 160 +
              256,
          );
        }
        bytes += record.bytes;
        visits++;
        check({ values, objects, bytes, visits });
        values[name] = record.value;
        for (const hash of record.objects) objects.add(hash);
        for (const ref of record.references) references.add(ref);
      }
    } else
      for (let i = 0; i < 16; i++)
        if (value.children[i]) {
          const child = await visit(
            value.children[i]!,
            prefix + i.toString(16),
          );
          bytes += child.bytes;
          visits += child.visits;
          check({ values, objects, bytes, visits });
          Object.assign(values, child.values);
          for (const hash of child.objects) objects.add(hash);
          for (const ref of child.references) references.add(ref);
        }
    const proof = check({
      references,
      values: Object.freeze(values),
      objects,
      bytes,
      visits,
    });
    // Record values are charged where their record proofs are cached; a map
    // proof holds only pointers to them. Charging every level for all bytes
    // below it counted one state's history once per tree level and made the
    // cache evict thousands of entries per update.
    options.cache.set(
      key,
      proof,
      ownBytes * 2 +
        (objects.size + references.size + Object.keys(values).length) * 64,
    );
    return proof;
  };
  return visit(root, "");
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

/** A read-through view of one history map. Records load on demand and are kept;
 * `touched` is every object hash read through this view. */
export class LazyStateMap {
  private readonly values = new Map<string, unknown>();
  readonly touched = new Set<string>();
  private readonly read: Read;
  constructor(readonly root: string, read: Read) {
    this.read = async (hash) => {
      this.touched.add(hash);
      return read(hash);
    };
  }
  async get(key: string): Promise<unknown> {
    if (this.values.has(key)) return this.values.get(key);
    const value = await getStateMap(this.root, key, this.read);
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

/** One map node's direct edges for a retention walk: child nodes, or the
 * records a leaf names. Position checks belong to lookups, not retention. */
export async function stateMapNodeEdges(
  hash: string,
  read: Read,
): Promise<{ children: string[]; records: string[] }> {
  const value = await node(hash, read, "");
  return "entries" in value
    ? { children: [], records: value.entries.map(([, record]) => record) }
    : { children: value.children.filter((h): h is string => h !== null), records: [] };
}
/** A record's value and every object read to reconstruct it. */
export async function stateMapRecord(
  hash: string,
  read: Read,
): Promise<{ value: unknown; objects: Set<string> }> {
  const objects = new Set<string>();
  const value = await readRecord(hash, async (h) => {
    objects.add(h);
    return read(h);
  });
  return { value, objects };
}
