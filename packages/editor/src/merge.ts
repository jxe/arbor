import type { ArborBlock } from "@arbor/core";
import { blockFingerprint } from "./markdown.ts";

export interface MergeConflict {
  index: number;
  base?: ArborBlock;
  local?: ArborBlock;
  disk?: ArborBlock;
}

export interface MergeResult {
  blocks: ArborBlock[];
  conflicts: MergeConflict[];
}

export function mergeBlocks(base: ArborBlock[], local: ArborBlock[], disk: ArborBlock[]): MergeResult {
  const max = Math.max(base.length, local.length, disk.length);
  const blocks: ArborBlock[] = [];
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
