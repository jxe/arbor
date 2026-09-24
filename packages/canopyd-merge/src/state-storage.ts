import { encodeJSON, loadSharedValue, OBJECT_HASH, storeSharedValue } from "./state-value.ts";
import { hashObject } from "@overstory/protocol";
import { parseIntentState, type IntentState } from "./intent-model.ts";
import {
  getStateMap,
  loadStateMap,
  storeStateMap,
  updateStateMap,
} from "./state-map.ts";
import { lazyHistory, storeHistory } from "./history-view.ts";

type Load = (hash: string) => Promise<Uint8Array>;
type Put = (bytes: Uint8Array) => string;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

/** The active part of an indexed state: nodes and decisions, stored as a shared
 * value under an `arbor-merge-intent-state-v2` root. Its history maps are empty. */
export function storeSharedIntentState(state: IntentState, put: Put): string {
  return put(
    encodeJSON({
      format: "arbor-merge-intent-state-v2",
      value: storeSharedValue(state, put),
    }),
  );
}

/** One state load's reads. Every occurrence is charged, including repeated
 * references to the same chunk: a tiny DAG must not expand into unbounded
 * in-memory state. `raw` leaves hash checks to a reader that performs them. */
function budgetedReads(load: Load, retained?: (hash: string) => void) {
  let expanded = 0;
  const raw = async (hash: string) => {
    const bytes = await load(hash);
    expanded += bytes.length;
    if (expanded > MAX_EXPANDED_BYTES)
      throw Error("State chunk graph exceeds byte budget");
    retained?.(hash);
    return bytes;
  };
  const checked = async (hash: string) => {
    if (!OBJECT_HASH.test(hash)) throw Error("Invalid state chunk reference");
    const bytes = await raw(hash);
    if (hashObject(bytes) !== hash) throw Error("Invalid state chunk hash");
    return bytes;
  };
  return {
    raw,
    checked,
    get bytes() { return expanded; },
    charge(count: number) { expanded += count; },
  };
}

/** Active state under its v2 root. The root is read and hash-checked once. */
async function loadActive(
  hash: string,
  reads: ReturnType<typeof budgetedReads>,
): Promise<IntentState> {
  const root = decode(await reads.checked(hash));
  if (root?.format !== "arbor-merge-intent-state-v2")
    throw Error("Invalid active state root");
  if (Object.keys(root).sort().join() !== "format,value")
    throw Error("Invalid shared state root");
  // loadSharedValue hash-checks each chunk itself.
  const value = parseIntentState(await loadSharedValue(root.value, reads.raw));
  if (historyFields.some((field) => Object.keys(value[field]).length))
    throw Error("History embedded in active state");
  return value;
}

/** The active state stored under a v2 root, as retention walks it. Every chunk
 * is hash checked, bounded and reported to `retained`. */
export function loadActiveIntentState(
  hash: string,
  load: Load,
  retained?: (hash: string) => void,
): Promise<IntentState> {
  return loadActive(hash, budgetedReads(load, retained));
}

/** Reads an indexed (v3) state. Every chunk is hash checked, bounded, and
 * reported to `retained`; references are never inferred from text. */
export async function loadIntentState(
  hash: string,
  load: Load,
  retained?: (hash: string) => void,
): Promise<IntentState> {
  const reads = budgetedReads(load, retained);
  const indexed = indexedRoot(decode(await reads.checked(hash)));
  const value = await loadActive(indexed.active, reads);
  for (const field of historyFields)
    value[field] = (await loadStateMap(indexed.maps[field], reads.raw)) as never;
  return parseIntentState(value);
}

const historyFields = [
  "outputs",
  "effects",
  "origins",
  "alternatives",
  "changes",
] as const;
type HistoryField = (typeof historyFields)[number];
type IndexedRoot = {
  format: "arbor-merge-intent-state-v3";
  active: string;
  editable: boolean;
  maps: Record<HistoryField, string>;
};
function indexedRoot(raw: any): IndexedRoot {
  if (
    raw?.format !== "arbor-merge-intent-state-v3" ||
    !["active,editable,format,maps", "active,format,maps"].includes(
      Object.keys(raw).sort().join(),
    ) ||
    (Object.hasOwn(raw, "editable") && typeof raw.editable !== "boolean") ||
    typeof raw.active !== "string" ||
    !OBJECT_HASH.test(raw.active) ||
    !raw.maps ||
    Object.keys(raw.maps).sort().join() !== [...historyFields].sort().join() ||
    !historyFields.every(
      (field) =>
        typeof raw.maps[field] === "string" && OBJECT_HASH.test(raw.maps[field]),
    )
  )
    throw Error("Invalid indexed state root");
  return { ...raw, editable: raw.editable ?? false };
}
function activeState(state: IntentState): IntentState {
  return {
    ...state,
    outputs: {},
    effects: {},
    origins: {},
    alternatives: {},
    changes: {},
  };
}
/** The one v3 root writer: the active state beside its history map roots. */
function storeIndexedRoot(
  state: IntentState,
  maps: Record<string, string>,
  editable: boolean,
  put: Put,
): string {
  return put(
    encodeJSON({
      format: "arbor-merge-intent-state-v3",
      active: storeSharedIntentState(activeState(state), put),
      editable,
      maps,
    }),
  );
}
export function storeIntentState(
  state: IntentState,
  put: Put,
  editable = false,
): string {
  const maps = Object.fromEntries(
    historyFields.map((field) => [field, storeStateMap(state[field], put)]),
  );
  return storeIndexedRoot(state, maps, editable, put);
}

/** The active root and history map roots of an indexed (v3) state, or
 * undefined for bytes that are not one. */
export function indexedStateParts(bytes: Uint8Array) {
  const raw = decode(bytes);
  if (raw?.format !== "arbor-merge-intent-state-v3") return undefined;
  const root = indexedRoot(raw);
  return { active: root.active, maps: root.maps };
}
export { historyFields };

/** An editable state was recorded by an evaluation that enforced every deletion
 * in its effects map; its nodes already reflect them. */
export async function isEditableState(hash: string, load: Load): Promise<boolean> {
  const raw = decode(await load(hash));
  return raw?.format === "arbor-merge-intent-state-v3" && indexedRoot(raw).editable;
}

/** A partial state is for the exact-basis evaluator only. Its empty history maps
 * are a write set, never evidence that old records are absent. */
export async function loadEditableIntentState(hash: string, load: Load) {
  const reads = budgetedReads(load);
  const raw = decode(await reads.checked(hash));
  if (raw?.format !== "arbor-merge-intent-state-v3") return undefined;
  const root = indexedRoot(raw);
  // Snapshot/imported states do not establish that historical deletions have
  // already been applied. Their next edit uses the full evaluator first.
  if (!root.editable) return undefined;
  const value = await loadActive(root.active, reads);
  return {
    value,
    get: (field: HistoryField, key: string) =>
      getStateMap(root.maps[field], key, load),
    store: async (state: IntentState, put: Put) => {
      const maps = { ...root.maps };
      for (const field of historyFields)
        maps[field] = await updateStateMap(
          maps[field],
          state[field],
          load,
          put,
        );
      return storeIndexedRoot(state, maps, true, put);
    },
  };
}

/** Active material in full; history maps as lazy views that load records on
 * demand (see history-view.ts). */
export async function loadLazyIntentState(hash: string, load: Load): Promise<IntentState> {
  const reads = budgetedReads(load);
  const root = indexedRoot(decode(await reads.checked(hash)));
  const value = await loadActive(root.active, reads);
  for (const field of historyFields)
    value[field] = lazyHistory(field, root.maps[field], load) as never;
  return value;
}

/** Store a state whose history maps are lazy views by path-copying the written
 * buckets; plain maps are stored whole. */
export async function storeLazyIntentState(
  state: IntentState,
  load: Load,
  put: Put,
  editable = false,
): Promise<string> {
  const maps: Record<string, string> = {};
  for (const field of historyFields)
    maps[field] =
      (await storeHistory(state[field], load, put)) ??
      storeStateMap(state[field], put);
  return storeIndexedRoot(state, maps, editable, put);
}
