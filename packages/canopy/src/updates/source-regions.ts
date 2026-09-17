import { hashObject, type ObjectHash } from "@arbor/wire";
import type { SourceEditEvidence } from "./source-edits.ts";

export interface RegionContribution { change: string; edit: SourceEditEvidence }
export interface SourceRegion {
  /** Coordinates in the immutable shared source, never in a chosen projection. */
  range: [number, number];
  alternatives: Array<{ change: string; text: string; operations: string[] }>;
}
export interface SourceRegions {
  path: string;
  object: ObjectHash;
  regions: SourceRegion[];
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Partition verified same-basis edits into connected regions. This is correspondence,
 * not a format rule: multiple alternatives stay distinct even when bytes agree.
 * The caller supplies one tree-scoped physical occurrence and its exact source.
 * No snapshot alignment, lineage inference or accepted-state mutation happens here.
 */
export function partitionSourceRegions(
  path: string, object: ObjectHash, source: Uint8Array, contributions: readonly RegionContribution[],
): SourceRegions {
  if (hashObject(source) !== object) throw new Error("Source region object mismatch");
  decoder.decode(source);
  const keys = new Map<string, Set<string>>();
  const sorted = [...contributions].sort((a, b) =>
    a.edit.source.range[0] - b.edit.source.range[0] ||
    a.edit.source.range[1] - b.edit.source.range[1] ||
    compare(a.change, b.change) || compare(a.edit.operation, b.edit.operation));
  for (const { change, edit } of sorted) {
    const [start, end] = edit.source.range;
    if (edit.path !== path || edit.source.object !== object) throw new Error("Source region basis mismatch");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length ||
        [start, end].some(offset => offset < source.length && (source[offset]! & 0xc0) === 0x80)) throw new Error("Invalid source region range");
    if (decoder.decode(encoder.encode(edit.text)) !== edit.text) throw new Error("Invalid source region text");
    const seen = keys.get(change) ?? new Set<string>();
    if (seen.has(edit.operation)) throw new Error("Duplicate source region contribution");
    seen.add(edit.operation); keys.set(change, seen);
  }
  const groups: RegionContribution[][] = [];
  let end = -1, lastStart = -1;
  for (const contribution of sorted) {
    const [start, stop] = contribution.edit.source.range;
    // Same anchors are coupled, including insertion + replacement. An insertion
    // at a preceding replacement's end is independent, matching exact execution.
    if (start >= end && start !== lastStart) groups.push([]);
    groups.at(-1)!.push(contribution);
    end = Math.max(end, stop); lastStart = start;
  }
  return { path, object, regions: groups.map(group => {
    const range: [number, number] = [group[0]!.edit.source.range[0], group.reduce((end, c) => Math.max(end, c.edit.source.range[1]), 0)];
    const byChange = new Map<string, SourceEditEvidence[]>();
    for (const { change, edit } of group) {
      const edits = byChange.get(change) ?? []; edits.push(edit); byChange.set(change, edits);
    }
    const alternatives = [...byChange].sort(([a], [b]) => compare(a, b)).map(([change, edits]) => {
      let cursor = range[0], priorStart = -1;
      const chunks: Uint8Array[] = [];
      for (const edit of edits) {
        const [start, stop] = edit.source.range;
        if (start < cursor || start === priorStart) throw new Error("Overlapping edits in one authored change");
        chunks.push(source.subarray(cursor, start), encoder.encode(edit.text));
        cursor = stop; priorStart = start;
      }
      chunks.push(source.subarray(cursor, range[1]));
      return { change, text: decoder.decode(Buffer.concat(chunks)), operations: edits.map(edit => edit.operation) };
    });
    return { range, alternatives };
  }) };
}

/** Explicitly choose each ambiguous region; single-contribution regions are kept.
 * Region indices are transient layout positions, not public decision identities.
 */
export function projectSourceRegions(source: Uint8Array, layout: SourceRegions, choices: ReadonlyMap<number, string>): Uint8Array {
  if (hashObject(source) !== layout.object) throw new Error("Source region object mismatch");
  for (const index of choices.keys()) if (!Number.isInteger(index) || index < 0 || index >= layout.regions.length) throw new Error("Unknown source region");
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  layout.regions.forEach((region, index) => {
    const choice = choices.get(index);
    const alternative = choice === undefined && region.alternatives.length === 1
      ? region.alternatives[0] : region.alternatives.find(a => a.change === choice);
    if (!alternative) throw new Error("Source region requires an explicit valid choice");
    chunks.push(source.subarray(cursor, region.range[0]), encoder.encode(alternative.text));
    cursor = region.range[1];
  });
  chunks.push(source.subarray(cursor));
  return new Uint8Array(Buffer.concat(chunks));
}
