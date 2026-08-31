import {
  decodeWireObject,
  encodeTransitionPayloadJSON,
  hashObject,
  type AcceptedTransitionPayload,
  type FileDelta,
  type FilePatch,
  type ObjectHash,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

const SMALL_MARKDOWN_LIMIT = 256 * 1024;

function commonBounds(base: Uint8Array, target: Uint8Array): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < target.length - prefix
    && base[base.length - suffix - 1] === target[target.length - suffix - 1]
  ) suffix += 1;
  return { prefix, suffix };
}

function patchRepresentation(base: ObjectHash, result: ObjectHash, before: Uint8Array, after: Uint8Array): FilePatch {
  const { prefix, suffix } = commonBounds(before, after);
  return {
    base,
    result,
    edits: [{
      offset: prefix,
      length: before.length - prefix - suffix,
      bytes: after.slice(prefix, after.length - suffix),
    }],
  };
}

function deltaRepresentation(base: ObjectHash, result: ObjectHash, before: Uint8Array, after: Uint8Array): FileDelta | null {
  const { prefix, suffix } = commonBounds(before, after);
  const instructions: FileDelta["instructions"] = [];
  if (prefix > 0) instructions.push({ copy: { offset: 0, length: prefix } });
  const middle = after.slice(prefix, after.length - suffix);
  if (middle.length > 0) instructions.push({ insert: middle });
  if (suffix > 0) instructions.push({ copy: { offset: before.length - suffix, length: suffix } });
  return instructions.length ? { base, result, instructions } : null;
}

function encodedSize(payload: AcceptedTransitionPayload): number {
  return Buffer.byteLength(JSON.stringify(encodeTransitionPayloadJSON(payload)));
}

function matchingEntry(entry: WireDirectoryEntry, entries: WireDirectoryEntry[]): WireDirectoryEntry | undefined {
  return entries.find((candidate) => candidate.name === entry.name);
}

/**
 * Derive one replayable sparse transition from the authority's actual accepted
 * endpoints. This deliberately does not fold history: callers invoke it once
 * for each accepted root, including merged results.
 */
export async function buildAcceptedTransitionPayload(
  previousRoot: ObjectHash,
  targetRoot: ObjectHash,
  load: Load,
): Promise<AcceptedTransitionPayload> {
  const cache = new Map<ObjectHash, { bytes: Uint8Array; object: WireObject }>();
  const provided = new Set<ObjectHash>();
  const objects: AcceptedTransitionPayload["objects"] = [];
  const filePatches: FilePatch[] = [];
  const fileDeltas: FileDelta[] = [];

  const loaded = async (hash: ObjectHash) => {
    const existing = cache.get(hash);
    if (existing) return existing;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) throw new Error(`Transition object hash mismatch: ${hash}`);
    const value = { bytes, object: decodeWireObject(bytes) };
    cache.set(hash, value);
    return value;
  };

  const includeObject = (hash: ObjectHash, bytes: Uint8Array) => {
    if (provided.add(hash)) objects.push({ hash, bytes });
  };

  const visit = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash, path: string): Promise<void> => {
    if (beforeHash === afterHash || provided.has(afterHash)) return;
    const after = await loaded(afterHash);
    const before = beforeHash ? await loaded(beforeHash) : undefined;
    if (after.object.type === "directory") {
      includeObject(afterHash, after.bytes);
      const beforeEntries = before?.object.type === "directory" ? before.object.entries : [];
      for (const entry of after.object.entries) {
        const prior = matchingEntry(entry, beforeEntries);
        const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        if (entry.hash) {
          await visit(prior?.hash, entry.hash, childPath);
        } else if (entry.rollup) {
          await visit(prior?.rollup?.source, entry.rollup.source, `${childPath}#source`);
          await visit(prior?.rollup?.schemaSource, entry.rollup.schemaSource, `${childPath}#schema`);
        }
      }
      return;
    }

    if (before?.object.type !== "file") {
      includeObject(afterHash, after.bytes);
      return;
    }

    const full: AcceptedTransitionPayload = { objects: [{ hash: afterHash, bytes: after.bytes }] };
    let selected: { kind: "full" | "patch" | "delta"; size: number; patch?: FilePatch; delta?: FileDelta } = {
      kind: "full",
      size: encodedSize(full),
    };
    const markdown = path.endsWith(".md")
      && after.object.bytes.length <= SMALL_MARKDOWN_LIMIT
      && (() => {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(before.object.bytes);
          new TextDecoder("utf-8", { fatal: true }).decode(after.object.bytes);
          return true;
        } catch { return false; }
      })();
    if (markdown) {
      const patch = patchRepresentation(beforeHash!, afterHash, before.object.bytes, after.object.bytes);
      const size = encodedSize({ objects: [], filePatches: [patch] });
      if (size < selected.size) selected = { kind: "patch", size, patch };
    }
    const delta = deltaRepresentation(beforeHash!, afterHash, before.object.bytes, after.object.bytes);
    if (delta) {
      const size = encodedSize({ objects: [], fileDeltas: [delta] });
      if (size < selected.size) selected = { kind: "delta", size, delta };
    }
    provided.add(afterHash);
    if (selected.patch) filePatches.push(selected.patch);
    else if (selected.delta) fileDeltas.push(selected.delta);
    else objects.push({ hash: afterHash, bytes: after.bytes });
  };

  await visit(previousRoot, targetRoot, "/");
  const payload: AcceptedTransitionPayload = {
    objects,
    ...(filePatches.length ? { filePatches } : {}),
    ...(fileDeltas.length ? { fileDeltas } : {}),
  };
  // Exercise the exact persisted/wire encoding here; generated objects and
  // file results were already hash-checked while walking the canonical graph.
  encodeTransitionPayloadJSON(payload);
  return payload;
}
