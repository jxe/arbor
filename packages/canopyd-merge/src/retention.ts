import { historyFields, indexedStateParts, loadActiveIntentState } from "./state-storage.ts";
import { stateMapNodeEdges, stateMapRecord } from "./state-map.ts";
import { decodeWireDirectory, hashObject } from "@overstory/protocol";
import { intentHistoryReferences, intentReferences, parseIntentHistoryRecord } from "./intent-model.ts";

type HistoryField = (typeof historyFields)[number];
/** A history map node is typed by its field: the field decides how its records
 * name further objects. */
type Kind = "object" | "directory" | "state" | "change" | `map-${HistoryField}`;
type Reference = { hash: string; kind: Kind };
type Closure = {
  hashes: ReadonlySet<string>;
  types: ReadonlySet<string>;
  /** Validated bytes that have not yet been read from the durable store. */
  pending: ReadonlySet<string>;
};

/** Derived, bounded facts about hash-verified immutable objects, never authority.
 * The kind is part of the key: reading file bytes does not validate a directory.
 * At most eight complete frontiers bound repeated history traversal. A proof
 * may include staged bytes, but those remain pending until a durable read.
 * An explicit integrity audit omits this cache and reads every byte again. */
export class RetentionCache {
  private entries = new Map<string, { edges: Reference[]; durable: boolean }>();
  private edges = 0;
  private closures = new Map<string, Closure>();
  /** History map nodes whose complete closure was found durable. Durable
   * storage is append-only, so a later walk may stop at them, as it stops at a
   * trusted accepted state. */
  private verifiedMaps = new Set<string>();
  mapVerified(key: string): boolean {
    return this.verifiedMaps.has(key);
  }
  retainVerifiedMaps(hashes: Iterable<string>) {
    for (const hash of hashes) {
      this.verifiedMaps.delete(hash);
      this.verifiedMaps.add(hash);
    }
    while (this.verifiedMaps.size > this.maxEntries * 2)
      this.verifiedMaps.delete(this.verifiedMaps.values().next().value!);
  }
  closure(hash: string): Closure | undefined {
    return this.closures.get(hash);
  }
  retainClosure(hash: string, closure: Closure) {
    if (closure.types.size > this.maxEdges) return;
    this.closures.delete(hash);
    this.closures.set(hash, closure);
    while (
      this.closures.size > 8 ||
      [...this.closures.values()].reduce((n, c) => n + c.types.size, 0) >
        this.maxEdges
    )
      this.closures.delete(this.closures.keys().next().value!);
  }
  constructor(
    private readonly maxEdges = 250_000,
    private readonly maxEntries = 100_000,
    private readonly retainStateEdges = false,
  ) {}
  get(ref: Reference): readonly Reference[] | undefined {
    return this.entries.get(ref.kind + ":" + ref.hash)?.edges;
  }
  isDurable(ref: Reference): boolean {
    return this.entries.get(ref.kind + ":" + ref.hash)?.durable ?? false;
  }
  markDurable(hash: string) {
    for (const kind of ["object", "directory", "change", ...historyFields.map((f) => `map-${f}`)]) {
      const entry = this.entries.get(kind + ":" + hash);
      if (entry) entry.durable = true;
    }
  }
  set(ref: Reference, dependencies: Reference[], durable: boolean) {
    if (
      (ref.kind === "state" && !this.retainStateEdges) ||
      dependencies.length > this.maxEdges ||
      this.maxEntries < 1
    )
      return;
    const key = ref.kind + ":" + ref.hash;
    const prior = this.entries.get(key);
    if (prior) this.edges -= prior.edges.length;
    this.entries.delete(key);
    this.entries.set(key, { edges: dependencies, durable });
    this.edges += dependencies.length;
    while (this.edges > this.maxEdges || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.edges -= this.entries.get(oldest)!.edges.length;
      this.entries.delete(oldest);
    }
  }
}

/** Explicit typed graph walk; arbitrary file bytes are never interpreted as metadata.
 * `durable(hash)` describes where `load(hash)` will read from. It is not itself
 * proof of availability: previously staged bytes must be loaded again before
 * their durability can be established. Durable storage is append-only. */
export async function verifyIntentRetention(
  roots: string[],
  load: (hash: string) => Promise<Uint8Array>,
  options?: {
    cache: RetentionCache;
    durable: (hash: string) => boolean;
    /** Audit a union without constructing a separate closure for every root. */
    union?: boolean;
    /** Host acceptance needs a verified frontier, not an enumerated full closure.
     * All staged overrides are hash-checked before any durable subtree is skipped. */
    staged?: ReadonlyMap<string, Uint8Array>;
    frontierOnly?: boolean;
    onCount?: (name: string, value: number) => void;
    /** References whose history the caller has already verified: accepted
     * input states, and durable change records (each was walked by the job
     * that published it into append-only storage). The walk stops at them
     * when they are durable; a requested root is never trusted. A full audit
     * passes none. */
    trusted?: (ref: Reference) => boolean;
  },
): Promise<Set<string>> {
  const bytesByHash = new Map<string, Uint8Array>();
  for (const [hash, bytes] of options?.staged ?? []) {
    if (hashObject(bytes) !== hash) throw new Error("Invalid retained object hash");
    bytesByHash.set(hash, bytes);
  }
  let visits = 0, mapHits = 0;
  const all = new Set<string>();
  const unionVerified = new Set<string>(), unionVisited = new Set<string>();
  const requested = new Set(roots);
  for (const root of requested) {
    const verified = options?.union ? unionVerified : new Set<string>(),
      visited = options?.union ? unionVisited : new Set<string>();
    const pending: Reference[] = [{ hash: root, kind: "state" }];
    const hot: Reference[] = [];
    const parents = new Map<string, Set<string>>();
    const blocked = new Set<string>();
    const mapCandidates = new Set<string>();
    let parent: string | undefined;
    let reusedRootClosure = false;
    const schedule = (edge: Reference) => {
      if (parent) {
        const key = edge.kind + ":" + edge.hash;
        const owners = parents.get(key) ?? new Set<string>();
        owners.add(parent);
        parents.set(key, owners);
      }
      const known =
        options &&
        (options.cache.closure(edge.hash) ||
          (edge.kind === "change" && !options.cache.get(edge)) ||
          options.cache
            .get(edge)
            ?.some(
              (next) =>
                next.kind === "state" && options.cache.closure(next.hash),
            ));
      (known ? hot : pending).push(edge);
    };
    while (pending.length || hot.length) {
      const ref = (hot.pop() ?? pending.pop())!,
        key = ref.kind + ":" + ref.hash;
      if (visited.has(key)) continue;
      visited.add(key);
      visits++;
      parent = key;
      if (ref.kind.startsWith("map-")) mapCandidates.add(key);
      if (options && !options.durable(ref.hash)) blocked.add(key);
      verified.add(ref.hash);
      if (verified.size > 1_000_000)
        throw new Error("Retained graph exceeds verification budget");
      if (
        (ref.kind === "state" || ref.kind === "change") && !requested.has(ref.hash) &&
        options?.trusted?.(ref) && options.durable(ref.hash)
      ) continue;
      if (ref.kind.startsWith("map-") && options?.staged && options.cache.mapVerified(key) && options.durable(ref.hash)) {
        mapHits++;
        continue;
      }
      const closure =
        ref.kind === "state" ? options?.cache.closure(ref.hash) : undefined;
      if (closure && options?.frontierOnly && options.staged) {
        if (ref.hash === root) reusedRootClosure = true;
        // A compact certificate already proves the durable part. Only bytes
        // pending publication need another read; overrides were checked above.
        for (const hash of closure.pending) {
          const bytes = bytesByHash.get(hash) ?? await load(hash);
          if (hashObject(bytes) !== hash) throw new Error("Invalid retained object hash");
          bytesByHash.set(hash, bytes);
          if (!options.durable(hash)) blocked.add(key);
          verified.add(hash);
        }
        // Preserve pending obligations until publication is observed. This
        // certificate must not be replaced by the smaller frontier below.
        continue;
      }
      if (closure) {
        // A proposal may include an already durable hash, but cannot override its
        // bytes merely because the stored graph has a certificate.
        for (const type of closure.types) visited.add(type);
        for (const hash of closure.hashes) {
          if (!options!.durable(hash)) blocked.add(key);
          if (closure.pending.has(hash) || !options!.durable(hash)) {
            const bytes = bytesByHash.get(hash) ?? (await load(hash));
            if (hashObject(bytes) !== hash)
              throw new Error("Invalid retained object hash");
            bytesByHash.set(hash, bytes);
            if (options!.durable(hash)) options!.cache.markDurable(hash);
          }
          verified.add(hash);
        }
        if (verified.size > 1_000_000)
          throw new Error("Retained graph exceeds verification budget");
        continue;
      }
      const durable = options?.durable(ref.hash) ?? false;
      const cached = options?.cache.get(ref);
      if (cached && durable && options!.cache.isDurable(ref)) {
        for (const edge of cached) schedule(edge);
        continue;
      }
      let bytes = bytesByHash.get(ref.hash);
      if (!bytes) {
        bytes = await load(ref.hash);
        if (hashObject(bytes) !== ref.hash)
          throw new Error("Invalid retained object hash");
        bytesByHash.set(ref.hash, bytes);
      }
      if (cached) {
        if (durable) options!.cache.markDurable(ref.hash);
        for (const edge of cached) schedule(edge);
        continue;
      }
      const edges = new Map<string, Reference>();
      const cachedRead = async (hash: string) => {
        const known = bytesByHash.get(hash);
        if (known) return known;
        const bytes = await load(hash);
        bytesByHash.set(hash, bytes);
        return bytes;
      };
      const add = (hash: string, kind: Kind = "object") =>
        edges.set(kind + ":" + hash, { hash, kind });
      if (ref.kind === "directory") {
        for (const entry of decodeWireDirectory(bytes).entries) {
          if (entry.directory) add(entry.directory, "directory");
          else if (entry.file) add(entry.file);
        }
      } else if (ref.kind === "change") {
        const recorded = JSON.parse(new TextDecoder().decode(bytes));
        if (recorded.base?.state) add(recorded.base.state, "state");
        add(recorded.base.object, "directory");
        add(recorded.incoming.object, "directory");
      } else if (ref.kind.startsWith("map-")) {
        const field = ref.kind.slice(4) as HistoryField;
        // The map and value readers hash-check every object they parse, so
        // bytes are cached here unchecked; a mismatch rejects the whole walk.
        const { children, records } = await stateMapNodeEdges(ref.hash, cachedRead);
        for (const child of children) add(child, ref.kind);
        for (const record of records) {
          const { value, objects } = await stateMapRecord(record, cachedRead);
          for (const hash of objects) add(hash);
          for (const reference of intentHistoryReferences(field, parseIntentHistoryRecord(field, value))) {
            const colon = reference.indexOf(":");
            add(reference.slice(colon + 1), reference.slice(0, colon) as Kind);
          }
        }
      } else if (ref.kind === "state") {
        // An indexed state: its active material whole, its history as typed
        // map nodes, so shared history is walked once per node.
        const parts = indexedStateParts(bytes);
        if (!parts) throw new Error("Retained state is not an indexed state");
        const active = await loadActiveIntentState(parts.active, cachedRead, (hash) => add(hash));
        for (const reference of intentReferences(active)) {
          const colon = reference.indexOf(":");
          add(reference.slice(colon + 1), reference.slice(0, colon) as Kind);
        }
        for (const field of historyFields) add(parts.maps[field], `map-${field}`);
      }
      const dependencies = [...edges.values()];
      options?.cache.set(ref, dependencies, durable);
      for (const edge of dependencies) schedule(edge);
    }
    // The walk already established this exact typed closure. Rebuilding it
    // from intermediate frontiers revisits the same history several times.
    // Input roots are primed separately; retain only the requested root here.
    if (!options?.union && !reusedRootClosure) options?.cache.retainClosure(root, {
      hashes: verified,
      types: visited,
      pending: new Set([...verified].filter((hash) => !options.durable(hash))),
    });
    if (!options?.union) for (const hash of verified) all.add(hash);
    // Promote each typed map independently. A staged sibling or state root
    // must not prevent a wholly durable history branch from becoming reusable.
    // Propagate non-durability up observed edges; semantic proofs alone never
    // establish availability. Already certified branches are terminal edges.
    if (options && !options.union) {
      const queue = [...blocked];
      for (let i = 0; i < queue.length; i++)
        for (const owner of parents.get(queue[i]!) ?? []) if (!blocked.has(owner)) {
          blocked.add(owner); queue.push(owner);
        }
      options.cache.retainVerifiedMaps(
        [...mapCandidates].filter(key => !blocked.has(key)),
      );
    }
    if (all.size > 1_000_000)
      throw new Error("Retained graph exceeds verification budget");
  }
  try {
    options?.onCount?.("retention-visits", visits);
    options?.onCount?.("retention-map-hits", mapHits);
  } catch { /* Diagnostics cannot affect acceptance. */ }
  return options?.union ? unionVerified : all;
}


/** A new audit owns fresh validation facts; nothing survives into a later
 * audit. Per-root closures serve migration 013, which compares them with the
 * explicit closures of its oldest rows; compact root records can be checked
 * together in one typed graph traversal. */
export function retentionAudit(load: (hash: string) => Promise<Uint8Array>) {
  const cache = new RetentionCache(1_000_000, 1_000_000, true);
  return (roots: string[], union = false) => verifyIntentRetention(roots, load, {
    cache, durable: () => true, union,
  });
}
