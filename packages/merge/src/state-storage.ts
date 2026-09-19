import { loadSharedValue, storeSharedValue } from "./state-value.ts";
import { stableJSONString } from "@arbor/core";
import { hashObject } from "@arbor/wire";
import {
  parseIntentHistoryRecord,
  intentHistoryReferences,
  intentReferences,
  parseIntentState,
  type IntentState,
} from "./intent-model.ts";
import {
  getStateMap,
  loadStateMap,
  storeStateMap,
  updateStateMap,
  loadValidatedStateMap,
  type StateMapValidationCache,
} from "./state-map.ts";

const encoder = new TextEncoder();
const HASH = /^sha256:[a-f0-9]{64}$/;
const encode = (value: unknown) => encoder.encode(stableJSONString(value));
export function storeSharedIntentState(
  state: IntentState,
  put: (bytes: Uint8Array) => string,
): string {
  return put(
    encode({
      format: "arbor-merge-intent-state-v2",
      value: storeSharedValue(state, put),
    }),
  );
}

/** Reads legacy states and shared states. Every chunk is hash checked, bounded,
 * and reported to the retention walker; references are never inferred from text. */
export async function loadIntentState(
  hash: string,
  load: (hash: string) => Promise<Uint8Array>,
  retained?: (hash: string) => void,
  historyCache?: StateMapValidationCache,
  summary?: {
    bytes: (count: number) => void;
    references: (refs: ReadonlySet<string>) => void;
  },
): Promise<IntentState> {
  let expandedBytes = 0;
  const read = async (hash: string) => {
    if (!HASH.test(hash)) throw Error("Invalid state chunk reference");
    const bytes = await load(hash);
    // Charge every occurrence, including repeated references to the same
    // chunk. A tiny DAG must not expand into unbounded in-memory state.
    expandedBytes += bytes.length;
    if (expandedBytes > 128 * 1024 * 1024)
      throw Error("State chunk graph exceeds byte budget");
    if (hashObject(bytes) !== hash) throw Error("Invalid state chunk hash");
    retained?.(hash);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const root = await read(hash);
  if (root?.format === "arbor-merge-intent-state-v3") {
    const indexed = indexedRoot(root);
    const activeRoot = await read(indexed.active);
    if (activeRoot?.format !== "arbor-merge-intent-state-v2")
      throw Error("Invalid active state root");
    const rawRead = async (hash: string) => {
      const bytes = await load(hash);
      expandedBytes += bytes.length;
      if (expandedBytes > 128 * 1024 * 1024)
        throw Error("State chunk graph exceeds byte budget");
      retained?.(hash);
      return bytes;
    };
    const value = await loadIntentState(indexed.active, rawRead);
    if (historyFields.some((field) => Object.keys(value[field]).length))
      throw Error("History embedded in active state");
    const references = intentReferences(value);
    for (const field of historyFields) {
      if (historyCache) {
        const proof = await loadValidatedStateMap(indexed.maps[field], load, {
          cache: historyCache,
          role: field,
          validate: (raw) => parseIntentHistoryRecord(field, raw),
          references: (record) => intentHistoryReferences(field, record),
          maxBytes: 128 * 1024 * 1024 - expandedBytes,
        });
        expandedBytes += proof.bytes;
        for (const ref of proof.references) references.add(ref);
        for (const hash of proof.objects) retained?.(hash);
        value[field] = proof.values as never;
      } else
        value[field] = (await loadStateMap(
          indexed.maps[field],
          rawRead,
        )) as never;
    }
    // Active state and each history record have already passed the same schema.
    // Cached history is immutable; this mode is only for authority validation.
    summary?.bytes(expandedBytes);
    summary?.references(historyCache ? references : intentReferences(value));
    return historyCache ? value : parseIntentState(value);
  }
  if (root?.format !== "arbor-merge-intent-state-v2") {
    const value = parseIntentState(root);
    summary?.bytes(expandedBytes);
    summary?.references(intentReferences(value));
    return value;
  }
  if (Object.keys(root).sort().join() !== "format,value")
    throw Error("Invalid shared state root");
  const value = parseIntentState(
    await loadSharedValue(root.value, async (hash) => {
      const bytes = await load(hash);
      expandedBytes += bytes.length;
      if (expandedBytes > 128 * 1024 * 1024)
        throw Error("State chunk graph exceeds byte budget");
      retained?.(hash);
      return bytes;
    }),
  );
  summary?.bytes(expandedBytes);
  summary?.references(intentReferences(value));
  return value;
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
    !HASH.test(raw.active) ||
    !raw.maps ||
    Object.keys(raw.maps).sort().join() !== [...historyFields].sort().join() ||
    !historyFields.every(
      (field) =>
        typeof raw.maps[field] === "string" && HASH.test(raw.maps[field]),
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
export function storeIntentState(
  state: IntentState,
  put: (bytes: Uint8Array) => string,
  editable = false,
): string {
  const maps = Object.fromEntries(
    historyFields.map((field) => [field, storeStateMap(state[field], put)]),
  );
  return put(
    encode({
      format: "arbor-merge-intent-state-v3",
      active: storeSharedIntentState(activeState(state), put),
      editable,
      maps,
    }),
  );
}

/** An editable state was recorded by an evaluation that enforced every deletion
 * in its effects map; its nodes already reflect them. */
export async function isEditableState(
  hash: string,
  load: (hash: string) => Promise<Uint8Array>,
): Promise<boolean> {
  const raw = JSON.parse(new TextDecoder().decode(await load(hash)));
  return raw?.format === "arbor-merge-intent-state-v3" && indexedRoot(raw).editable;
}

/** A partial state is for the exact-basis evaluator only. Its empty history maps
 * are a write set, never evidence that old records are absent. */
export async function loadEditableIntentState(
  hash: string,
  load: (hash: string) => Promise<Uint8Array>,
) {
  const bytes = await load(hash);
  if (hashObject(bytes) !== hash) throw Error("Invalid indexed state hash");
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (raw?.format !== "arbor-merge-intent-state-v3") return undefined;
  const root = indexedRoot(raw);
  // Snapshot/imported states do not establish that historical deletions have
  // already been applied. Their next edit uses the full evaluator first.
  if (!root.editable) return undefined;
  const activeBytes = await load(root.active);
  if (
    hashObject(activeBytes) !== root.active ||
    JSON.parse(new TextDecoder().decode(activeBytes))?.format !==
      "arbor-merge-intent-state-v2"
  )
    throw Error("Invalid active state root");
  const value = await loadIntentState(root.active, load);
  if (historyFields.some((field) => Object.keys(value[field]).length))
    throw Error("History embedded in active state");
  return {
    value,
    get: (field: HistoryField, key: string) =>
      getStateMap(root.maps[field], key, load),
    store: async (state: IntentState, put: (bytes: Uint8Array) => string) => {
      const maps = { ...root.maps };
      for (const field of historyFields)
        maps[field] = await updateStateMap(
          maps[field],
          state[field],
          load,
          put,
        );
      return put(
        encode({
          format: root.format,
          active: storeSharedIntentState(activeState(state), put),
          editable: true,
          maps,
        }),
      );
    },
  };
}
