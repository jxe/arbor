import type { ObjectHash, ProtocolDirectory, ProtocolDirectoryEntry } from "../objects.ts";
import { applyObjectDelta } from "./apply.ts";
import { TreeReader, walkTreeDiff } from "./tree-diff.ts";
import type { ObjectDeltaInstruction, TransitionPayload } from "./types.ts";

interface Sent { bytes: Uint8Array; delta?: { base: ObjectHash; bytes: Uint8Array; instructions: ObjectDeltaInstruction[] } }

const loose = new TextDecoder("utf-8", { ignoreBOM: true });

function utf8(bytes: Uint8Array): string | undefined {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}

const short = (hash: ObjectHash) => `${hash.slice(0, 19)}…`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function lines(sign: string, text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  return parts.map((line) => `  ${sign} ${line}`);
}

/** A delta read against its base text: copies collapse to their size and base lines; inserts print, after the base bytes they replace. */
function deltaLines(base: Uint8Array, instructions: readonly ObjectDeltaInstruction[]): string[] {
  const starts = [0];
  for (let index = 0; index < base.byteLength; index += 1) if (base[index] === 0x0a) starts.push(index + 1);
  const lineAt = (offset: number) => {
    let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >> 1; if (starts[mid]! <= offset) low = mid + 1; else high = mid; }
    return low;
  };
  const out: string[] = [];
  let cursor = 0, inserts: Uint8Array[] = [];
  const replace = (end: number) => {
    if (end > cursor) out.push(...lines("-", loose.decode(base.subarray(cursor, end))));
    for (const bytes of inserts) out.push(...lines("+", loose.decode(bytes)));
    inserts = [];
  };
  for (const instruction of instructions) {
    if ("insert" in instruction) { inserts.push(instruction.insert); continue; }
    const { offset, length } = instruction.copy;
    replace(offset);
    const span = `lines ${lineAt(offset)}–${lineAt(offset + length - 1)}`;
    out.push(offset < cursor ? `  … ${length} bytes copied from ${span} …` : `  … ${length} unchanged bytes (${span}) …`);
    cursor = Math.max(cursor, offset + length);
  }
  replace(base.byteLength);
  return out;
}

function entryLabel(entry: ProtocolDirectoryEntry): string {
  return entry.directory ? `${entry.name}/` : entry.tree ? `${entry.name} → tree ${entry.tree}` : entry.name;
}

function directoryLines(before: ProtocolDirectory | undefined, after: ProtocolDirectory): string[] {
  const old = new Map((before?.entries ?? []).map((entry) => [entry.name, entry]));
  const next = new Map(after.entries.map((entry) => [entry.name, entry]));
  const out: string[] = [];
  for (const entry of after.entries) {
    const prior = old.get(entry.name);
    if (!prior) out.push(`  + ${entryLabel(entry)}`);
    else if (prior.file !== entry.file || prior.directory !== entry.directory || prior.tree !== entry.tree) {
      out.push(`  ~ ${entryLabel(entry)}${!!prior.directory !== !!entry.directory || !!prior.tree !== !!entry.tree ? ` (was ${entryLabel(prior)})` : ""}`);
    }
  }
  for (const entry of before?.entries ?? []) if (!next.has(entry.name)) out.push(`  - ${entryLabel(entry)}`);
  return out;
}

function form(sent: Sent, replaces: ObjectHash | undefined): string {
  if (sent.delta) return `delta from ${short(sent.delta.base)}, ${plural(sent.delta.instructions.length, "instruction")}, ${plural(sent.bytes.byteLength, "byte")}`;
  return `${replaces ? `whole, replaces ${short(replaces)}` : "new"}, ${plural(sent.bytes.byteLength, "byte")}`;
}

/**
 * A person-readable account of a transition payload from `before` to `after`,
 * built only from its own objects and deltas plus the objects `load` returns
 * from the basis. Paths come from walking `after` against `before`. File deltas
 * read against their base text, directories list the entries they add, remove
 * or change by name, and whole files print their text when it is UTF-8.
 */
export async function describeTransitionPayload(input: {
  before: ObjectHash;
  after: ObjectHash;
  payload: TransitionPayload;
  load(hash: ObjectHash): Promise<Uint8Array | undefined>;
}): Promise<string> {
  const { before, after, payload } = input;
  const sent = new Map<ObjectHash, Sent>();
  for (const object of payload.objects) sent.set(object.hash, { bytes: object.bytes });
  const basis = async (hash: ObjectHash) => {
    const bytes = sent.get(hash)?.bytes ?? await input.load(hash);
    if (!bytes) throw new Error(`Object is unavailable: ${hash}`);
    return bytes;
  };
  for (const delta of payload.deltas) {
    const base = await basis(delta.base);
    sent.set(delta.result, { bytes: applyObjectDelta(base, delta), delta: { base: delta.base, bytes: base, instructions: delta.instructions } });
  }
  const out = [
    `Basis      ${before}`,
    `Candidate  ${after}`,
    `${plural(payload.objects.length, "object")}, ${plural(payload.deltas.length, "delta")}`,
  ];
  const described = new Set<ObjectHash>();
  await walkTreeDiff(before, after, new TreeReader(basis), {
    directory: ({ path, before: prior, after: next }) => {
      const item = next && sent.get(next.hash);
      if (!next || !item || described.has(next.hash)) return;
      described.add(next.hash);
      out.push("", `directory ${path} (${form(item, prior?.hash)})`, ...directoryLines(prior?.directory, next.directory));
    },
    entry: ({ path, before: prior, after: next }) => {
      const item = next?.file ? sent.get(next.file) : undefined;
      if (next?.file && item && !described.has(next.file)) {
        described.add(next.file);
        out.push("", `file ${path} (${form(item, prior?.file ?? prior?.directory)})`);
        const base = item.delta && utf8(item.delta.bytes), text = utf8(item.bytes);
        if (item.delta) out.push(...(base !== undefined && text !== undefined
          ? deltaLines(item.delta.bytes, item.delta.instructions)
          : [`  binary: ${item.delta.instructions.reduce((sum, i) => sum + ("copy" in i ? i.copy.length : 0), 0)} bytes copied, ${item.delta.instructions.reduce((sum, i) => sum + ("insert" in i ? i.insert.byteLength : 0), 0)} bytes inserted`]));
        else out.push(...(text !== undefined ? lines("+", text) : ["  binary"]));
      }
      return !!next?.directory;
    },
  });
  for (const [hash, item] of sent) {
    if (!described.has(hash)) out.push("", `object ${hash} (${form(item, undefined)}) is not at a changed path`);
  }
  return out.join("\n");
}
