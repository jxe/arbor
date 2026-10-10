import type { OverstoryBlock } from "../index.ts";
import { blockFingerprint } from "./markdown.ts";

export interface MergeConflict {
  index: number;
  base?: OverstoryBlock;
  local?: OverstoryBlock;
  disk?: OverstoryBlock;
}

export interface MergeResult {
  blocks: OverstoryBlock[];
  conflicts: MergeConflict[];
}

export function mergeBlocks(base: OverstoryBlock[], local: OverstoryBlock[], disk: OverstoryBlock[]): MergeResult {
  const max = Math.max(base.length, local.length, disk.length);
  const blocks: OverstoryBlock[] = [];
  const conflicts: MergeConflict[] = [];
  for (let index = 0; index < max; index += 1) {
    const before = base[index];
    const ours = local[index];
    const theirs = disk[index];
    const beforeHash = before ? blockFingerprint(before) : null;
    const oursHash = ours ? blockFingerprint(ours) : null;
    const theirsHash = theirs ? blockFingerprint(theirs) : null;
    if (oursHash === theirsHash) {
      if (ours) blocks.push(ours);
    } else if (oursHash === beforeHash) {
      if (theirs) blocks.push(theirs);
    } else if (theirsHash === beforeHash) {
      if (ours) blocks.push(ours);
    } else {
      conflicts.push({ index, base: before, local: ours, disk: theirs });
      if (ours) blocks.push(ours);
      if (theirs && !ours) blocks.push(theirs);
    }
  }
  return { blocks, conflicts };
}
