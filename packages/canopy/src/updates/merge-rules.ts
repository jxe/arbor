import {
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type UpdateConflict,
  type WireObject,
} from "@arbor/wire";
import { canonicalCBORHash, stableJSONString, type CollectionFileDescriptor } from "@arbor/core";
import {
  decodeWireCollectionFile,
  encodeWireCollectionFile,
  SchemaSandbox,
  WireCollectionFileError,
  type WireCollectionFileRow,
} from "@arbor/stores";

/**
 * Merge rules: the representation-specific way to combine two changes to one
 * node. The node-level merge in merge.ts decides which nodes conflict; a rule
 * runs only for a conflicting node whose representation has one.
 */

export interface RuleContext {
  /** Store a generated object and return its hash. */
  store(object: WireObject): ObjectHash;
  object(hash: ObjectHash): Promise<WireObject>;
  conflicts: UpdateConflict[];
}

function splitLines(source: string): string[] {
  return source.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

interface Edit {
  start: number;
  end: number;
  replacement: string[];
}

function editsFrom(base: string[], changed: string[]): Edit[] {
  const rows = base.length + 1;
  const columns = changed.length + 1;
  const lcs = new Uint32Array(rows * columns);
  for (let left = base.length - 1; left >= 0; left--) {
    for (let right = changed.length - 1; right >= 0; right--) {
      lcs[left * columns + right] = base[left] === changed[right]
        ? 1 + lcs[(left + 1) * columns + right + 1]!
        : Math.max(lcs[(left + 1) * columns + right]!, lcs[left * columns + right + 1]!);
    }
  }
  const edits: Edit[] = [];
  let left = 0;
  let right = 0;
  while (left < base.length || right < changed.length) {
    if (left < base.length && right < changed.length && base[left] === changed[right]) {
      left++;
      right++;
      continue;
    }
    const start = left;
    const replacement: string[] = [];
    while (left < base.length || right < changed.length) {
      if (left < base.length && right < changed.length && base[left] === changed[right]) break;
      if (right < changed.length && (left === base.length || lcs[left * columns + right + 1]! >= lcs[(left + 1) * columns + right]!)) {
        replacement.push(changed[right++]!);
      } else if (left < base.length) {
        left++;
      }
    }
    edits.push({ start, end: left, replacement });
  }
  return edits;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sequenceOffsets(lines: string[], sequence: string[]): number[] {
  if (!sequence.length || sequence.length > lines.length) return [];
  const offsets: number[] = [];
  for (let offset = 0; offset <= lines.length - sequence.length; offset++) {
    if (arraysEqual(lines.slice(offset, offset + sequence.length), sequence)) offsets.push(offset);
  }
  return offsets;
}

/**
 * If both sides moved the same unique base block, let the already-accepted
 * side own its placement. LCS can otherwise represent the two moves as
 * separate insertions plus one shared deletion and duplicate the whole block.
 */
function collapseDuplicateMoves(
  base: string[],
  candidate: string[],
  remote: string[],
): { candidate: string[]; approximate: number } {
  const localDeletions = editsFrom(base, candidate).filter((edit) => edit.end > edit.start && !edit.replacement.length);
  const remoteDeletions = editsFrom(base, remote).filter((edit) => edit.end > edit.start && !edit.replacement.length);
  const shared = localDeletions
    .filter((local) => remoteDeletions.some((accepted) => accepted.start === local.start && accepted.end === local.end))
    .sort((left, right) => (right.end - right.start) - (left.end - left.start));
  const reduced = [...candidate];
  let approximate = 0;
  for (const deletion of shared) {
    const block = base.slice(deletion.start, deletion.end);
    if (!block.some((line) => line.trim())) continue;
    const baseOffsets = sequenceOffsets(base, block);
    const candidateOffsets = sequenceOffsets(reduced, block);
    const remoteOffsets = sequenceOffsets(remote, block);
    if (baseOffsets.length !== 1 || candidateOffsets.length !== 1 || remoteOffsets.length !== 1) continue;
    reduced.splice(candidateOffsets[0]!, block.length);
    if (candidateOffsets[0] !== remoteOffsets[0]) approximate++;
  }
  return { candidate: reduced, approximate };
}

function mergeLines(base: string[], candidate: string[], remote: string[]): { lines: string[]; approximate: number } {
  const collapsed = collapseDuplicateMoves(base, candidate, remote);
  const localEdits = editsFrom(base, collapsed.candidate).map((edit) => ({ ...edit, side: "candidate" as const }));
  const remoteEdits = editsFrom(base, remote).map((edit) => ({ ...edit, side: "remote" as const }));
  const edits = [...localEdits, ...remoteEdits].sort((left, right) => left.start - right.start || left.end - right.end || (left.side === "remote" ? -1 : 1));
  const result: string[] = [];
  let cursor = 0;
  let approximate = collapsed.approximate;
  for (let index = 0; index < edits.length;) {
    const group = [edits[index++]!];
    const start = group[0]!.start;
    let end = group[0]!.end;
    while (index < edits.length && (
      edits[index]!.start < end
      || (edits[index]!.start === end && end === start && edits[index]!.end === start)
    )) {
      const next = edits[index++]!;
      group.push(next);
      end = Math.max(end, next.end);
    }
    result.push(...base.slice(cursor, start));
    const remoteReplacement = group.filter((edit) => edit.side === "remote").flatMap((edit) => edit.replacement);
    const candidateReplacement = group.filter((edit) => edit.side === "candidate").flatMap((edit) => edit.replacement);
    if (arraysEqual(remoteReplacement, candidateReplacement)) result.push(...remoteReplacement);
    else if (!remoteReplacement.length) result.push(...candidateReplacement);
    else if (!candidateReplacement.length) result.push(...remoteReplacement);
    else {
      result.push(...remoteReplacement, ...candidateReplacement);
      approximate++;
    }
    cursor = end;
  }
  result.push(...base.slice(cursor));
  return { lines: result, approximate };
}

function frontmatter(source: string): Map<string, string> | null {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return new Map();
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([^#][^:]*):\s*(.*)$/.exec(line);
    if (match) values.set(match[1]!.trim(), match[2]!);
  }
  return values;
}

function divergentFrontmatter(base: string, candidate: string, remote: string): boolean {
  const maps = [frontmatter(base), frontmatter(candidate), frontmatter(remote)] as const;
  if (maps.some((map) => map === null)) return true;
  const [baseMap, candidateMap, remoteMap] = maps as [Map<string, string>, Map<string, string>, Map<string, string>];
  for (const key of new Set([...candidateMap.keys(), ...remoteMap.keys()])) {
    const before = baseMap.get(key);
    const local = candidateMap.get(key);
    const accepted = remoteMap.get(key);
    if (local !== before && accepted !== before && local !== accepted) return true;
  }
  return false;
}

function balancedFences(source: string): boolean {
  const fences = source.split(/\r?\n/).filter((line) => /^\s*(```|~~~)/.test(line));
  return fences.length % 2 === 0;
}


/** Parse Markdown frontmatter into a name/value map, or null when the block never closes. */
export { frontmatter };

/** `markdown-additive-v1`: line-level three-way merge of one Markdown node. */
export async function markdownAdditiveV1(
  path: string,
  baseHash: ObjectHash,
  candidateHash: ObjectHash,
  currentHash: ObjectHash,
  context: RuleContext,
): Promise<{ hash: ObjectHash; approximate: number }> {
  const [baseObject, candidateObject, currentObject] = await Promise.all([
    context.object(baseHash), context.object(candidateHash), context.object(currentHash),
  ]);
  if (baseObject.type !== "file" || candidateObject.type !== "file" || currentObject.type !== "file") {
    context.conflicts.push({ path, reason: "path-kind-conflict" });
    return { hash: candidateHash, approximate: 0 };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let baseSource: string;
  let candidateSource: string;
  let currentSource: string;
  try {
    baseSource = decoder.decode(baseObject.bytes);
    candidateSource = decoder.decode(candidateObject.bytes);
    currentSource = decoder.decode(currentObject.bytes);
  } catch {
    context.conflicts.push({ path, reason: "binary-conflict" });
    return { hash: candidateHash, approximate: 0 };
  }
  const merged = mergeLines(splitLines(baseSource), splitLines(candidateSource), splitLines(currentSource));
  const source = merged.lines.join("");
  if (divergentFrontmatter(baseSource, candidateSource, currentSource)) context.conflicts.push({ path, reason: "frontmatter-conflict" });
  if (!balancedFences(source)) context.conflicts.push({ path, reason: "invalid-markdown-fence" });
  return { hash: context.store({ type: "file", bytes: new TextEncoder().encode(source) }), approximate: merged.approximate };
}

export interface CollectionFileMergeInput {
  descriptor: CollectionFileDescriptor;
  source: ObjectHash;
  schemaSource: ObjectHash;
}

/** `collection-file-rows-v1`: merge two collection-file changes by stable row identity. */
export async function collectionFileRowsV1(
  path: string,
  base: CollectionFileMergeInput,
  candidate: CollectionFileMergeInput,
  current: CollectionFileMergeInput,
  context: RuleContext,
): Promise<{ descriptor: CollectionFileDescriptor; source: ObjectHash; schemaSource: ObjectHash; mergedRows: number }> {
  const collectionFile = async (hash: ObjectHash): Promise<Uint8Array> => {
    const value = await context.object(hash);
    if (value.type !== "file") throw new WireCollectionFileError("source", "Collection-file source is not a file object");
    return value.bytes;
  };
  const rowEqual = (left: WireCollectionFileRow | undefined, right: WireCollectionFileRow | undefined): boolean =>
    left === undefined ? right === undefined
      : right !== undefined && stableJSONString(left.properties) === stableJSONString(right.properties);
  const schemaState = (value: CollectionFileMergeInput) => stableJSONString({
    version: value.descriptor.version,
    type: value.descriptor.type,
    format: value.descriptor.format,
    source: value.descriptor.source,
    schemaSource: value.descriptor.schemaSource,
    schemaFingerprint: value.descriptor.schemaFingerprint,
    schemaObject: value.schemaSource,
  });
  if (schemaState(base) !== schemaState(candidate) || schemaState(base) !== schemaState(current)) {
    context.conflicts.push({ path, reason: "collection-file-schema-conflict" });
    return { ...candidate, mergedRows: 0 };
  }
  const schemas = new SchemaSandbox();
  let mergedRows = 0;
  try {
    const decode = async (value: CollectionFileMergeInput) => decodeWireCollectionFile(
      value.descriptor,
      await collectionFile(value.source),
      await collectionFile(value.schemaSource),
      schemas,
    );
    const [baseFile, candidateFile, currentFile] = [await decode(base), await decode(candidate), await decode(current)];
    const baseRows = new Map(baseFile.rows.map((row) => [row.stableKey, row]));
    const candidateRows = new Map(candidateFile.rows.map((row) => [row.stableKey, row]));
    const currentRows = new Map(currentFile.rows.map((row) => [row.stableKey, row]));
    const selected = new Map<string, WireCollectionFileRow>();
    for (const key of new Set([...baseRows.keys(), ...candidateRows.keys(), ...currentRows.keys()])) {
      const before = baseRows.get(key);
      const candidate = candidateRows.get(key);
      const current = currentRows.get(key);
      let row: WireCollectionFileRow | undefined;
      if (rowEqual(candidate, current)) row = candidate;
      else if (rowEqual(candidate, before)) row = current;
      else if (rowEqual(current, before)) {
        row = candidate;
        mergedRows += 1;
      } else {
        const name = candidate?.path ?? current?.path ?? before?.path ?? "row";
        context.conflicts.push({ path: `${path === "/" ? "" : path}/${name};arbor-key=${Buffer.from(key).toString("base64url")}`, reason: "collection-file-row-conflict" });
        row = candidate;
      }
      if (row) selected.set(key, row);
    }
    const ordered: WireCollectionFileRow[] = [];
    for (const row of [...currentFile.rows, ...candidateFile.rows]) {
      const selectedRow = selected.get(row.stableKey);
      if (selectedRow) {
        ordered.push(selectedRow);
        selected.delete(row.stableKey);
      }
    }
    ordered.push(...[...selected.values()].sort((left, right) => left.stableKey < right.stableKey ? -1 : 1));
    const childSetHash = canonicalCBORHash([...ordered]
      .sort((left, right) => left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
      .map((row) => ({ key: row.stableKey, name: row.path, properties: row.properties })));
    const source = context.store({
      type: "file",
      bytes: encodeWireCollectionFile(current.descriptor.format, currentFile.schema, ordered),
    });
    return {
      descriptor: { ...current.descriptor, childSetHash },
      source,
      schemaSource: current.schemaSource,
      mergedRows,
    };
  } catch (error) {
    if (error instanceof WireCollectionFileError) {
      context.conflicts.push({ path, reason: error.kind === "schema" ? "collection-file-schema-conflict" : "collection-file-constraint-conflict" });
      return { ...candidate, mergedRows: 0 };
    }
    throw error;
  } finally {
    await schemas[Symbol.asyncDispose]();
  }
}

/** Hash one wire object's canonical bytes without storing it. */
export function objectHashOf(object: WireObject): ObjectHash {
  return hashObject(encodeWireObject(object));
}
