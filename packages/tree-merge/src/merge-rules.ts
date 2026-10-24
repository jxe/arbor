import {
  type ObjectHash,
  type UpdateConflict,
} from "@ovst/protocol";
import { logicalRowKey, type LogicalRow, type ProtocolDirectory } from "@ovst/protocol";
import {
  encodeDirectoryCollection,
  loadDirectoryCollection,
  mergeCollectionRows,
  ProtocolCollectionError,
  type RowFieldConflict,
} from "@ovst/collection-schema";
import type { LogicalTables } from "@ovst/usl";

/**
 * Merge rules: the representation-specific way to combine two changes to one
 * node. The node-level merge in merge.ts decides which nodes conflict; a rule
 * runs only for a conflicting node whose representation has one.
 */

export interface RuleContext {
  /** Store a generated object and return its hash. */
  store(bytes: Uint8Array): ObjectHash;
  file(hash: ObjectHash): Promise<Uint8Array>;
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

/** Sources the line merge accepts, as the format rules bound their analysis. */
const MAX_LINE_MERGE_BYTES = 256 * 1024;
/** LCS table cells one line diff may allocate: a 64 MiB table. */
const MAX_DIFF_CELLS = 16 * 1024 * 1024;

/** Line edits from `base` to `changed`, or null when the LCS table would
 * exceed its budget. */
function editsFrom(base: string[], changed: string[]): Edit[] | null {
  const rows = base.length + 1;
  const columns = changed.length + 1;
  if (rows * columns > MAX_DIFF_CELLS) return null;
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
  candidateEdits: Edit[],
  remote: string[],
  remoteEdits: Edit[],
): { candidate: string[]; approximate: number } {
  const localDeletions = candidateEdits.filter((edit) => edit.end > edit.start && !edit.replacement.length);
  const remoteDeletions = remoteEdits.filter((edit) => edit.end > edit.start && !edit.replacement.length);
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

/** Null when either diff exceeds its budget. */
function mergeLines(base: string[], candidate: string[], remote: string[]): { lines: string[]; approximate: number } | null {
  const candidateDiff = editsFrom(base, candidate), remoteDiff = editsFrom(base, remote);
  if (!candidateDiff || !remoteDiff) return null;
  const collapsed = collapseDuplicateMoves(base, candidate, candidateDiff, remote, remoteDiff);
  // A collapsed candidate is shorter than the original, so its diff fits too.
  const collapsedDiff = collapsed.candidate.length === candidate.length
    ? candidateDiff
    : editsFrom(base, collapsed.candidate)!;
  const localEdits = collapsedDiff.map((edit) => ({ ...edit, side: "candidate" as const }));
  const remoteEdits = remoteDiff.map((edit) => ({ ...edit, side: "remote" as const }));
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
    context.file(baseHash), context.file(candidateHash), context.file(currentHash),
  ]);
  // Beyond the analysis budget the node conflicts, as it would with no rule.
  const tooLarge = () => {
    context.conflicts.push({ path, reason: "node-conflict" });
    return { hash: candidateHash, approximate: 0 };
  };
  if ([baseObject, candidateObject, currentObject].some((bytes) => bytes.length > MAX_LINE_MERGE_BYTES))
    return tooLarge();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let baseSource: string;
  let candidateSource: string;
  let currentSource: string;
  try {
    baseSource = decoder.decode(baseObject);
    candidateSource = decoder.decode(candidateObject);
    currentSource = decoder.decode(currentObject);
  } catch {
    context.conflicts.push({ path, reason: "binary-conflict" });
    return { hash: candidateHash, approximate: 0 };
  }
  const merged = mergeLines(splitLines(baseSource), splitLines(candidateSource), splitLines(currentSource));
  if (!merged) return tooLarge();
  const source = merged.lines.join("");
  if (divergentFrontmatter(baseSource, candidateSource, currentSource)) context.conflicts.push({ path, reason: "frontmatter-conflict" });
  if (!balancedFences(source)) context.conflicts.push({ path, reason: "invalid-markdown-fence" });
  return { hash: context.store(new TextEncoder().encode(source)), approximate: merged.approximate };
}

/** A field conflict a collection merge kept for someone to pick. */
export interface CollectionFieldConflict extends RowFieldConflict {
  /** The collection's folder. */
  path: string;
  /** The row's model. */
  table: string;
}

/**
 * `collection-fields-v1` (spec 10 §7.1): merge two changes to a logical
 * collection model by model, by row identity and then field by field.
 * `merged` is the folder as its entries merged, holding the `schema.usl` the
 * result is checked against; its rows are encoded from the merged tables.
 * Field conflicts keep current's value and are reported for a decision; a
 * merge the schema rejects is a conflict on the folder, which keeps
 * candidate's rows.
 */
export async function collectionFieldsV1(
  path: string,
  base: ProtocolDirectory,
  candidate: ProtocolDirectory,
  current: ProtocolDirectory,
  merged: ProtocolDirectory,
  context: RuleContext,
): Promise<{ directory: ProtocolDirectory; mergedRows: number; fields: CollectionFieldConflict[] }> {
  const keep = (reason: UpdateConflict["reason"]) => {
    context.conflicts.push({ path, reason });
    return { directory: { ...merged, collection: candidate.collection! }, mergedRows: 0, fields: [] };
  };
  const fingerprints = new Set([base, candidate, current].map((d) => d.collection?.modelFingerprint ?? null));
  if (fingerprints.size !== 1) return keep("collection-schema-conflict");
  try {
    const [b, c, u] = await Promise.all([base, candidate, current].map((d) => loadDirectoryCollection(d, context.file)));
    const tables: LogicalTables = {};
    let mergedRows = 0;
    const fields: CollectionFieldConflict[] = [];
    const byKey = (rows: readonly LogicalRow[] | undefined) => new Map((rows ?? []).map((row) => [logicalRowKey(row), row]));
    for (const model of u!.schema.models) {
      const result = mergeCollectionRows(model, byKey(b!.tables[model.name] as LogicalRow[]), byKey(c!.tables[model.name] as LogicalRow[]), byKey(u!.tables[model.name] as LogicalRow[]), (x, y, z) => {
        const lines = mergeLines(splitLines(x), splitLines(y), splitLines(z));
        return lines && !lines.approximate ? lines.lines.join("") : null;
      });
      tables[model.name] = [...result.rows.values()].filter((row): row is LogicalRow => row !== null);
      mergedRows += result.mergedRows;
      fields.push(...result.conflicts.map((conflict) => ({ ...conflict, path, table: model.name })));
    }
    const encoded = await encodeDirectoryCollection(merged, tables, context.file);
    for (const bytes of encoded.objects.values()) context.store(bytes);
    return { directory: encoded.directory, mergedRows, fields };
  } catch (error) {
    if (error instanceof ProtocolCollectionError) return keep(error.kind === "schema" ? "collection-schema-conflict" : "collection-constraint-conflict");
    throw error;
  }
}
