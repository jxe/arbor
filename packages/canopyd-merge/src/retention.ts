import { historyFields, indexedStateParts, loadActiveIntentState } from "./state-storage.ts";
import { stateMapNodeEdges, stateMapRecord } from "./state-map.ts";
import { decodeWireDirectory, hashObject } from "@overstory/protocol";
import { intentHistoryReferences, intentReferences, parseIntentHistoryRecord } from "./intent-model.ts";

type HistoryField = (typeof historyFields)[number];
/** A history map node is typed by its field: the field decides how its records
 * name further objects. */
type Kind = "object" | "directory" | "state" | "change" | `map-${HistoryField}`;
type Reference = { hash: string; kind: Kind };

/** The objects one typed reference names. Arbitrary file bytes are never
 * interpreted as metadata. The map and value readers hash-check every object
 * they parse, so `read` may hand them unchecked bytes. */
async function referencesOf(
  ref: Reference,
  bytes: Uint8Array,
  read: (hash: string) => Promise<Uint8Array>,
): Promise<Reference[]> {
  const edges = new Map<string, Reference>();
  const add = (hash: string, kind: Kind = "object") => edges.set(kind + ":" + hash, { hash, kind });
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
    const { children, records } = await stateMapNodeEdges(ref.hash, read);
    for (const child of children) add(child, ref.kind);
    for (const record of records) {
      const { value, objects } = await stateMapRecord(record, read);
      for (const hash of objects) add(hash);
      for (const reference of intentHistoryReferences(field, parseIntentHistoryRecord(field, value))) {
        const colon = reference.indexOf(":");
        add(reference.slice(colon + 1), reference.slice(0, colon) as Kind);
      }
    }
  } else if (ref.kind === "state") {
    // An indexed state: its active material whole, its history as typed map
    // nodes, so shared history is walked once per node.
    const parts = indexedStateParts(bytes);
    if (!parts) throw new Error("Retained state is not an indexed state");
    const active = await loadActiveIntentState(parts.active, read, (hash) => add(hash));
    for (const reference of intentReferences(active)) {
      const colon = reference.indexOf(":");
      add(reference.slice(colon + 1), reference.slice(0, colon) as Kind);
    }
    for (const field of historyFields) add(parts.maps[field], `map-${field}`);
  }
  return [...edges.values()];
}

const BUDGET = 1_000_000;

/** A full audit of retained states: walk each root's complete typed closure,
 * reading and hash-checking every object, and return the hashes. A new audit
 * trusts nothing from an earlier one. Within one audit, parsed edges are
 * shared across roots, and a later root stops at an earlier root's complete
 * closure. `union` checks all roots as one traversal (the worker's
 * `retention-audit` request); per-root closures serve migration 013. */
export function retentionAudit(load: (hash: string) => Promise<Uint8Array>) {
  const edgesOf = new Map<string, Reference[]>();
  const closures = new Map<string, Set<string>>();
  return async (roots: string[], union = false): Promise<Set<string>> => {
    const bytesByHash = new Map<string, Uint8Array>();
    const read = async (hash: string) => {
      const known = bytesByHash.get(hash);
      if (known) return known;
      const bytes = await load(hash);
      bytesByHash.set(hash, bytes);
      return bytes;
    };
    const all = new Set<string>();
    const unionVerified = new Set<string>(), unionVisited = new Set<string>();
    for (const root of new Set(roots)) {
      const verified = union ? unionVerified : new Set<string>();
      const visited = union ? unionVisited : new Set<string>();
      const pending: Reference[] = [{ hash: root, kind: "state" }];
      while (pending.length) {
        const ref = pending.pop()!, key = ref.kind + ":" + ref.hash;
        if (visited.has(key)) continue;
        visited.add(key);
        verified.add(ref.hash);
        if (verified.size > BUDGET) throw new Error("Retained graph exceeds verification budget");
        const known = !union && ref.kind === "state" ? closures.get(ref.hash) : undefined;
        if (known) {
          for (const hash of known) verified.add(hash);
          continue;
        }
        let edges = edgesOf.get(key);
        if (!edges) {
          const bytes = await read(ref.hash);
          if (hashObject(bytes) !== ref.hash) throw new Error("Invalid retained object hash");
          edges = await referencesOf(ref, bytes, read);
          if (edgesOf.size >= BUDGET) edgesOf.clear();
          edgesOf.set(key, edges);
        }
        pending.push(...edges);
      }
      if (!union) {
        closures.set(root, verified);
        for (const hash of verified) all.add(hash);
      }
      if (all.size > BUDGET) throw new Error("Retained graph exceeds verification budget");
    }
    return union ? unionVerified : all;
  };
}
