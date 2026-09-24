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

/** A full audit of retained states: walk the complete typed closure of all
 * roots as one traversal, reading and hash-checking every object, and return
 * the hashes. A new audit trusts nothing from an earlier one. The worker's
 * `retention-audit` request runs it. */
export function retentionAudit(load: (hash: string) => Promise<Uint8Array>) {
  return async (roots: string[]): Promise<Set<string>> => {
    const bytesByHash = new Map<string, Uint8Array>();
    const read = async (hash: string) => {
      const known = bytesByHash.get(hash);
      if (known) return known;
      const bytes = await load(hash);
      bytesByHash.set(hash, bytes);
      return bytes;
    };
    const verified = new Set<string>(), visited = new Set<string>();
    const pending: Reference[] = [...new Set(roots)].map((hash) => ({ hash, kind: "state" as const }));
    while (pending.length) {
      const ref = pending.pop()!, key = ref.kind + ":" + ref.hash;
      if (visited.has(key)) continue;
      visited.add(key);
      verified.add(ref.hash);
      if (verified.size > BUDGET) throw new Error("Retained graph exceeds verification budget");
      const bytes = await read(ref.hash);
      if (hashObject(bytes) !== ref.hash) throw new Error("Invalid retained object hash");
      pending.push(...await referencesOf(ref, bytes, read));
    }
    return verified;
  };
}
