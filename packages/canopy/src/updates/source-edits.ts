import { decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash } from "@arbor/wire";
import type { SourceOperation as AuthoredOperation, MaterialRef } from "@arbor/wire";

type Edit = Extract<AuthoredOperation, { kind: "editSource" }>;
/** Validated creation coordinates; bind these to (tree, change, operation) on commit. */
export interface SourceEditEvidence {
  operation: string;
  path: string;
  source: { object: ObjectHash; range: [number, number] };
  text: string;
  lineage: Array<{ source: { object: ObjectHash; range: [number, number] }; range: [number, number] }>;
}
export class UnsupportedSourceEdit extends Error {}
interface Selection { path: string; object: ObjectHash; bytes: Uint8Array; range: [number, number] }
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function invalid(message: string): never { throw new Error(`Invalid source edit: ${message}`); }
function boundaries(bytes: Uint8Array, range: [number, number]) {
  if (!range.every(Number.isSafeInteger) || range[0] < 0 || range[1] < range[0] || range[1] > bytes.length) invalid("range outside source");
  decoder.decode(bytes); // Binary and malformed UTF-8 are not text selections.
  for (const offset of range) if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) invalid("range splits UTF-8 scalar");
}
function components(path: string): string[] {
  if (!path.startsWith("/")) invalid("path is not absolute");
  const parts = path === "/" ? [] : path.slice(1).split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p) || p.normalize("NFC") !== p)) invalid("invalid path");
  return parts;
}

/** Pure authored-basis execution. Does not accept updates, reconcile peers or write objects.
 * Callers must bind baseRoot to an authorized accepted state of the same tree.
 * This first slice handles basis selections and disjoint edits, not retained outputs.
 */
export async function executeExactSourceEdits(
  baseRoot: ObjectHash,
  operations: readonly AuthoredOperation[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; evidence: SourceEditEvidence[] }> {
  const cache = new Map<ObjectHash, Uint8Array>();
  async function read(hash: ObjectHash) {
    const known = cache.get(hash);
    if (known) return known;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) invalid("object hash mismatch");
    cache.set(hash, bytes);
    return bytes;
  }
  async function select(ref: MaterialRef): Promise<Selection> {
    if (ref.material.kind !== "basis") throw new UnsupportedSourceEdit("Retained operation and alternative references are not enabled");
    const baseParts = components(ref.material.path);
    const within = ref.within ?? [];
    if (within.length) components("/" + within.join("/"));
    let object = baseRoot, kind: "file" | "directory" = "directory";
    const parts = [...baseParts, ...within];
    for (let index = 0; index <= parts.length; index++) {
      if (index === baseParts.length && object !== ref.material.object) invalid("basis object does not match path");
      if (index === parts.length) break;
      if (kind !== "directory") invalid("selector descends through a file");
      const entry = decodeWireDirectory(await read(object)).entries.find(e => e.name === parts[index]);
      if (!entry) invalid("path absent from basis");
      if (entry.tree) invalid("selection crosses tree boundary");
      object = (entry.file ?? entry.directory)!;
      kind = entry.file ? "file" : "directory";
    }
    if (kind !== "file") invalid("source selection is not a file");
    const bytes = await read(object);
    const range: [number, number] = ref.range ?? [0, bytes.length];
    boundaries(bytes, range);
    return { path: "/" + parts.join("/"), object, bytes, range };
  }
  const groups = new Map<string, Array<{ selected: Selection; text: Uint8Array; index: number }>>();
  const evidence: SourceEditEvidence[] = [];
  const keys = new Set<string>();
  for (const operation of operations) {
    if (operation.kind !== "editSource") throw new UnsupportedSourceEdit(`Operation ${operation.kind} is not enabled in exact source execution`);
    const edit: Edit = operation;
    if (keys.has(edit.key)) invalid("duplicate operation key");
    keys.add(edit.key);
    const selected = await select(edit.source), text = encoder.encode(edit.text);
    if (decoder.decode(text) !== edit.text) invalid("replacement is not scalar text");
    const lineage: SourceEditEvidence["lineage"] = [];
    let priorEnd = 0, priorSourceEnd = selected.range[0];
    for (const mapping of edit.lineage ?? []) {
      boundaries(text, mapping.range);
      if (mapping.range[0] < priorEnd) invalid("overlapping replacement lineage");
      priorEnd = mapping.range[1];
      const source = await select(mapping.source);
      // An edit can preserve selected material; borrowing another occurrence is
      // copy intent and cannot be smuggled into a preservation claim.
      if (source.path !== selected.path || source.range[0] < selected.range[0] || source.range[1] > selected.range[1]) throw new UnsupportedSourceEdit("Lineage outside the replaced selection requires causal source execution");
      if (!Buffer.from(source.bytes.subarray(...source.range)).equals(Buffer.from(text.subarray(...mapping.range)))) invalid("lineage changes bytes");
      if (source.range[0] < priorSourceEnd) throw new UnsupportedSourceEdit("Reordered or reused lineage requires causal source execution");
      priorSourceEnd = source.range[1];
      lineage.push({ source: { object: source.object, range: source.range }, range: mapping.range });
    }
    const group = groups.get(selected.path) ?? [];
    group.push({ selected, text, index: evidence.length });
    groups.set(selected.path, group);
    evidence.push({ operation: edit.key, path: selected.path, source: { object: selected.object, range: selected.range }, text: edit.text, lineage });
  }
  const generated = new Map<ObjectHash, Uint8Array>();
  const replacements = new Map<string, ObjectHash>();
  for (const [path, edits] of groups) {
    edits.sort((a, b) => a.selected.range[0] - b.selected.range[0] || a.index - b.index);
    const chunks: Uint8Array[] = [];
    let cursor = 0, priorStart = -1;
    for (const { selected, text } of edits) {
      if (selected.range[0] < cursor || selected.range[0] === priorStart) throw new UnsupportedSourceEdit("Overlapping or same-anchor edits require causal source execution");
      chunks.push(selected.bytes.subarray(cursor, selected.range[0]), text);
      priorStart = selected.range[0]; cursor = selected.range[1];
    }
    chunks.push(edits[0]!.selected.bytes.subarray(cursor));
    const bytes = new Uint8Array(Buffer.concat(chunks)), hash = hashObject(bytes);
    generated.set(hash, bytes); replacements.set(path, hash);
  }
  async function rebuild(hash: ObjectHash, path: string): Promise<ObjectHash> {
    const directory = decodeWireDirectory(await read(hash));
    let changed = false;
    for (const entry of directory.entries) {
      const child = path + "/" + entry.name;
      if (![...replacements.keys()].some(p => p === child || p.startsWith(child + "/"))) continue;
      const next = entry.file ? replacements.get(child)! : entry.directory ? await rebuild(entry.directory, child) : undefined;
      if (next && next !== (entry.file ?? entry.directory)) {
        if (entry.file) entry.file = next; else entry.directory = next;
        changed = true;
      }
    }
    if (!changed) return hash;
    const bytes = encodeWireDirectory(directory), result = hashObject(bytes);
    generated.set(result, bytes); return result;
  }
  return { root: await rebuild(baseRoot, ""), generated, evidence };
}

/** Verify the complete candidate, including every untouched path and source byte. */
export async function validateSourceEditCandidate(
  baseRoot: ObjectHash,
  candidate: ObjectHash,
  operations: readonly AuthoredOperation[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
) {
  const result = await executeExactSourceEdits(baseRoot, operations, load);
  if (result.root !== candidate) invalid("operations do not explain candidate");
  return result;
}

/** One tree-root to tree-root step of authored evidence, as the merge engine
 * sees it. Basis references name objects in this frame's `before` tree. */
export interface SourceFrame {
  before: ObjectHash;
  after: ObjectHash;
  operations: readonly AuthoredOperation[];
}

/** Validate a chain of frames. Each frame must follow its predecessor's result
 * and must reproduce its own `after` exactly; objects a frame generates are
 * available to the frames that follow it. Operation keys stay unique across the
 * whole trace, because they name contributions of one change. */
export async function validateSourceTrace(
  frames: readonly SourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; evidence: SourceEditEvidence[] }> {
  if (!frames.length) invalid("trace has no frames");
  const generated = new Map<ObjectHash, Uint8Array>();
  const evidence: SourceEditEvidence[] = [];
  const keys = new Set<string>();
  const read = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    if (previous && previous.after !== frame.before) invalid("frame does not follow its basis");
    if (!frame.operations.length) invalid("frame carries no operations");
    for (const operation of frame.operations) {
      if (keys.has(operation.key)) invalid("duplicate operation key");
      keys.add(operation.key);
    }
    const result = await validateSourceEditCandidate(frame.before, frame.after, frame.operations, read);
    for (const [hash, bytes] of result.generated) generated.set(hash, bytes);
    evidence.push(...result.evidence);
  }
  return { root: frames.at(-1)!.after, generated, evidence };
}

/** Collapse a chain into one frame from the first `before` to the last `after`.
 * Frame-local basis references only survive composition when later frames do
 * not touch what earlier frames changed; the composed frame is then executed
 * and must reproduce the same result. Anything that would need its references
 * rebased (lineage, copies, or a second edit of the same file) is refused
 * rather than guessed. */
export async function composeFrames(
  frames: readonly SourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<SourceFrame> {
  if (!frames.length) invalid("trace has no frames");
  if (frames.length === 1) return frames[0]!;
  const paths = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    if (previous && previous.after !== frame.before) invalid("frame does not follow its basis");
    const touched: string[] = [];
    for (const operation of frame.operations) {
      if (operation.kind !== "editSource" || operation.lineage?.length || operation.source.material.kind !== "basis")
        throw new UnsupportedSourceEdit("Composition needs lineage-free basis edits");
      const path = operation.source.material.path;
      if (paths.has(path))
        throw new UnsupportedSourceEdit("Composition needs frames over disjoint paths");
      touched.push(path);
    }
    for (const path of touched) paths.add(path);
  }
  const composed: SourceFrame = {
    before: frames[0]!.before,
    after: frames.at(-1)!.after,
    operations: frames.flatMap((frame) => [...frame.operations]),
  };
  // The exact intermediate bytes make this deterministic; prove it rather than
  // assume it, so a composed trace is never weaker evidence than the chain.
  await validateSourceEditCandidate(composed.before, composed.after, composed.operations, load);
  return composed;
}
