import { composeSourceEdits, validateSourceEditCandidate, UnsupportedSourceEdit, type PlainSourceEdit, type ObjectHash, type SourceFrame, type SourceOperation as AuthoredOperation } from "@overstory/protocol";
export {
  executeExactSourceEdits,
  validateSourceEditCandidate,
  validateSourceTrace,
  UnsupportedSourceEdit,
  type SourceEditEvidence,
  type SourceFrame,
} from "@overstory/protocol";

function invalid(message: string): never { throw new Error(`Invalid source edit: ${message}`); }

/** Collapse a chain of plain edits into one frame from the first `before` to
 * the last `after`, by the same rule the clients' `compactTrace` applies:
 * every frame's operations must be lineage-free `editSource` operations over
 * `basis` material with a range; per path, the generations compose through
 * `composeSourceEdits` (`@overstory/protocol`), which needs no intermediate bytes; the
 * composed operations are keyed `edit-0-<i>` in output order (paths in first
 * appearance order) and name each path's object in the first frame. The
 * composed frame is then executed and must reproduce the same result, so a
 * composed trace is never weaker evidence than the chain. Anything that would
 * need its references rebased (lineage, copies, operation material) is
 * refused rather than guessed. `docs/overstory-spec/conformance/source-admission-queue.json`
 * holds the vectors shared with both clients. */
export async function composeFrames(
  frames: readonly SourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<SourceFrame> {
  if (!frames.length) invalid("trace has no frames");
  if (frames.length === 1) return frames[0]!;
  const byPath = new Map<string, { object: ObjectHash; generations: PlainSourceEdit[][] }>();
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    if (previous && previous.after !== frame.before) invalid("frame does not follow its basis");
    const edits = new Map<string, PlainSourceEdit[]>();
    for (const operation of frame.operations) {
      if (operation.kind !== "editSource" || operation.lineage?.length || operation.source.material.kind !== "basis" || operation.source.within?.length || !operation.source.range)
        throw new UnsupportedSourceEdit("Composition needs lineage-free basis edits");
      const { path, object } = operation.source.material;
      const entry = byPath.get(path) ?? { object, generations: [] };
      byPath.set(path, entry);
      const list = edits.get(path) ?? [];
      list.push({ offset: operation.source.range[0], length: operation.source.range[1] - operation.source.range[0], replacement: operation.text });
      edits.set(path, list);
    }
    for (const [path, entry] of byPath) {
      const list = (edits.get(path) ?? []).sort((a, b) => a.offset - b.offset);
      entry.generations.push(list);
    }
  }
  const operations: AuthoredOperation[] = [];
  // Plain edits that end where they started changed nothing; no evidence is
  // lost by stating none. Lineage and copies never reach this point.
  if (frames[0]!.before === frames.at(-1)!.after) return { before: frames[0]!.before, after: frames.at(-1)!.after, operations };
  for (const [path, { object, generations }] of byPath) {
    for (const edit of composeSourceEdits(generations)) {
      operations.push({ key: `edit-0-${operations.length}`, kind: "editSource",
        source: { material: { kind: "basis", path, object }, range: [edit.offset, edit.offset + edit.length] }, text: edit.replacement });
    }
  }
  const composed: SourceFrame = { before: frames[0]!.before, after: frames.at(-1)!.after, operations };
  if (!operations.length) {
    if (composed.before !== composed.after) invalid("composed frame carries no operations");
    return composed;
  }
  // The exact intermediate bytes make this deterministic; prove it rather than
  // assume it, so a composed trace is never weaker evidence than the chain.
  await validateSourceEditCandidate(composed.before, composed.after, composed.operations, load);
  return composed;
}
