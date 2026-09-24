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

/** Proofs mirror the radix tree. Parents retain child proofs, not copies of all
 * descendant values and dependencies. Expanded bytes still enforce input limits. */
type ProofAllocation = {
  weight: number;
  children: readonly ProofAllocation[];
};
export type MapProof = ProofAllocation & {
  values: Readonly<Record<string, unknown>>;
  objects: Iterable<string>;
  bytes: number;
  visits: number;
  references: Iterable<string>;
};
type RecordProof = ProofAllocation & {
  value: unknown;
  bytes: number;
  objects: ReadonlySet<string>;
  references: ReadonlySet<string>;
};

function* combined<T>(own: Iterable<T>, children: readonly Iterable<T>[]): Generator<T> {
  yield* own;
  for (const child of children) yield* child;
}

function proofObjects(hash: string, children: readonly (MapProof | RecordProof)[]): Iterable<string> {
  return { [Symbol.iterator]: () => combined([hash], children.map(c => c.objects)) };
}
function proofReferences(children: readonly (MapProof | RecordProof)[]): Iterable<string> {
  return { [Symbol.iterator]: () => combined([], children.map(c => c.references)) };
}

/** A synchronous, immutable lookup view over already validated children. Only
 * explicit enumeration pays for enumerating the whole history. */
function branchValues(children: readonly (MapProof | undefined)[], depth: number): Readonly<Record<string, unknown>> {
  const get = (key: string) => children[digit(key, depth)]?.values[key];
  return new Proxy(Object.create(null), {
    get: (_target, key) => typeof key === "string" ? get(key) : undefined,
    has: (_target, key) => typeof key === "string" && get(key) !== undefined,
    ownKeys: () => children.flatMap(child => child ? Object.keys(child.values) : []),
    getOwnPropertyDescriptor: (_target, key) => {
      const value = typeof key === "string" ? get(key) : undefined;
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
}

/** Semantic facts only, never evidence of durable availability. The memory
 * ledger counts a shared allocation once across cache entries and pinned state
 * proofs. Removing an entry cannot hide memory still owned by another root. */
export class StateMapValidationCache {
  private readonly entries = new Map<string, MapProof | RecordProof>();
  private readonly owners = new Map<ProofAllocation, number>();
  private weight = 0;
  readonly stats = { hits: 0, misses: 0, sets: 0, rejected: 0, evictions: 0 };
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  get size(): { bytes: number; entries: number } {
    return { bytes: this.weight, entries: this.entries.size };
  }
  private acquire(proof: ProofAllocation) {
    const count = this.owners.get(proof) ?? 0;
    this.owners.set(proof, count + 1);
    if (count) return;
    this.weight += proof.weight;
    for (const child of proof.children) this.acquire(child);
  }
  private release(proof: ProofAllocation) {
    const count = this.owners.get(proof)!;
    if (count > 1) { this.owners.set(proof, count - 1); return; }
    this.owners.delete(proof);
    this.weight -= proof.weight;
    for (const child of proof.children) this.release(child);
  }
  private trim() {
    while (this.weight > this.maxBytes && this.entries.size) {
      const key = this.entries.keys().next().value!;
      const proof = this.entries.get(key)!;
      this.entries.delete(key);
      this.release(proof);
      this.stats.evictions++;
    }
  }
  /** A state cache must hold this lease for as long as it retains these views.
   * If pinned roots alone exceed the bound, decline the new lease. */
  pin(proofs: readonly MapProof[]): (() => void) | undefined {
    for (const proof of proofs) this.acquire(proof);
    this.trim();
    if (this.weight > this.maxBytes) {
      for (const proof of proofs) this.release(proof);
      return undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const proof of proofs) this.release(proof);
    };
  }
  get(key: string): MapProof | RecordProof | undefined {
    const proof = this.entries.get(key);
    if (!proof) { this.stats.misses++; return undefined; }
    this.stats.hits++;
    this.entries.delete(key);
    this.entries.set(key, proof);
    return proof;
  }
  set(key: string, proof: MapProof | RecordProof) {
    if (proof.weight > this.maxBytes) { this.stats.rejected++; return; }
    this.stats.sets++;
    this.acquire(proof);
    const prior = this.entries.get(key);
    if (prior) this.release(prior);
    this.entries.delete(key);
    this.entries.set(key, proof);
    this.trim();
  }
}
function freezeValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}
/** Revalidate changed branches and records. Complete dependency enumeration is
 * available to audits, but normal authority validation retains the proof DAG. */
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
    const value = await node(hash, async h => {
      const b = await read(h); bytes += b.length; return b;
    }, prefix);
    const ownBytes = bytes;
    const records: RecordProof[] = [];
    const branches: (MapProof | undefined)[] = Array(16);
    let values: Readonly<Record<string, unknown>>;
    let visits = 1;
    if ("entries" in value) {
      const leaf: Record<string, unknown> = Object.create(null);
      for (const [name, hash] of value.entries) {
        const recordKey = JSON.stringify(["record", options.role, hash]);
        let record = options.cache.get(recordKey) as RecordProof | undefined;
        if (!record) {
          let length = 0;
          const objects = new Set<string>();
          const raw = await readRecord(hash, async h => {
            const b = await read(h); length += b.length; objects.add(h); return b;
          });
          const value = freezeValue(options.validate(raw));
          const references = options.references?.(value) ?? new Set<string>();
          record = { value, bytes: length, objects, references, children: [],
            weight: length * 2 + (objects.size + references.size) * 160 + 256 };
          options.cache.set(recordKey, record);
        }
        records.push(record);
        bytes += record.bytes;
        visits++;
        check({ bytes, visits });
        leaf[name] = record.value;
      }
      values = Object.freeze(leaf);
    } else {
      for (let i = 0; i < 16; i++) if (value.children[i]) {
        const child = await visit(value.children[i]!, prefix + i.toString(16));
        branches[i] = child;
        bytes += child.bytes;
        visits += child.visits;
        check({ bytes, visits });
      }
      values = branchValues(branches, prefix.length);
    }
    const children = [...records, ...branches.filter((p): p is MapProof => !!p)];
    const proof: MapProof = check({ values, bytes, visits, children,
      weight: ownBytes * 2 + children.length * 64 + 256,
      // Factories create repeatable iterables, without retaining this visit's
      // loader or its staged object map in the long-lived cache.
      objects: proofObjects(hash, children),
      references: proofReferences(children),
    });
    options.cache.set(key, proof);
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
  /** Parsed nodes, so lookups share the path from the root. */
  private readonly nodes = new Map<string, Promise<Node>>();
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
