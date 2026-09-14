import { decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash, type WireDirectoryEntry } from "@arbor/wire";
import { selected, simplify, type Term } from "./algebra.ts";

type Entry = WireDirectoryEntry | null;
export interface TextRegion {
  id: string;
  path: string;
  kind: "text";
  terms: Term<Uint8Array>[];
  /** Unique common context, required to distinguish equal conflicts elsewhere. */
  context: { before: string | null; after: string | null };
  /** Exact byte ranges in each source object; private backend bookkeeping. */
  ranges: Map<ObjectHash, { start: number; end: number }>;
}
export interface EntryRegion {
  id: string;
  path: string;
  kind: "entry";
  terms: Term<Entry>[];
}
export type Region = TextRegion | EntryRegion;
export type Resolution = { conflict: string; take: number } | { conflict: string; bytes: Uint8Array };
export interface Objects {
  load(hash: ObjectHash): Uint8Array;
  put(bytes: Uint8Array): ObjectHash;
}

const bytesKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const entryKey = (entry: Entry): string => entry === null ? "null" : JSON.stringify(
  entry.file ? { name: entry.name, file: entry.file } : entry.directory
    ? { name: entry.name, directory: entry.directory } : { name: entry.name, tree: entry.tree },
);
const childPath = (parent: string, name: string): string => `${parent === "/" ? "" : parent}/${name}`;
const sorted = (entries: WireDirectoryEntry[]): WireDirectoryEntry[] => entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

function regionID(path: string, kind: string, values: unknown): string {
  return hashObject(new TextEncoder().encode(JSON.stringify([path, kind, values])));
}

interface Line { key: string; start: number; end: number }
function lines(bytes: Uint8Array): Line[] {
  const result: Line[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    if (bytes[index] === 13 && bytes[index + 1] === 10) index++;
    result.push({ key: bytesKey(bytes.subarray(start, index + 1)), start, end: index + 1 });
    start = index + 1;
  }
  if (start < bytes.length) result.push({ key: bytesKey(bytes.subarray(start)), start, end: bytes.length });
  return result;
}

/**
 * Conservative localization: only unique, ordered lines shared by every term
 * are anchors. Repeated context is left inside a larger region. Crossed anchors
 * (a possible move) deliberately yield a whole-file conflict, never guessed order.
 * This is linear in source size rather than an unbounded quadratic LCS table.
 */
function anchors(sources: Uint8Array[]): Line[][] {
  const indexes = sources.map((source) => {
    const index = new Map<string, Line | null>();
    for (const line of lines(source)) index.set(line.key, index.has(line.key) ? null : line);
    return index;
  });
  const result: Line[][] = [];
  for (const [key, line] of indexes[0]!) {
    if (!line) continue;
    const matches = indexes.map((index) => index.get(key));
    if (matches.some((match) => !match)) continue;
    const next = matches as Line[];
    const previous = result.at(-1);
    if (previous && next.some((match, index) => match.start < previous[index]!.end)) return [];
    result.push(next);
  }
  return result;
}

function textProjection(path: string, terms: Term<ObjectHash>[], objects: Objects, conflicts: Region[]): ObjectHash {
  const sources = terms.map((term) => objects.load(term.value));
  const common = anchors(sources);
  const positions = sources.map(() => 0);
  const output: Uint8Array[] = [];
  for (let index = 0; index <= common.length; index++) {
    const anchor = common[index];
    const ranges = new Map<ObjectHash, { start: number; end: number }>();
    const pieces = terms.map((term, side): Term<Uint8Array> => {
      const start = positions[side]!;
      const end = anchor?.[side]?.start ?? sources[side]!.length;
      ranges.set(term.value, { start, end });
      return { sign: term.sign, value: sources[side]!.subarray(start, end) };
    });
    const reduced = simplify(pieces, bytesKey);
    if (reduced.length > 1) {
      conflicts.push({
        id: regionID(path, "text", [index, reduced.map((term) => [term.sign, bytesKey(term.value)]), [...ranges]]),
        path, kind: "text", terms: reduced, ranges,
        context: { before: common[index - 1]?.[0]?.key ?? null, after: anchor?.[0]?.key ?? null },
      });
    }
    output.push(selected(reduced));
    if (anchor) {
      output.push(sources[0]!.subarray(anchor[0]!.start, anchor[0]!.end));
      anchor.forEach((line, side) => { positions[side] = line.end; });
    }
  }
  return objects.put(Buffer.concat(output));
}

/** Ordinary Wire directory graph plus separate review evidence. No marker bytes. */
export function project(roots: Term<ObjectHash>[], objects: Objects): { root: ObjectHash; conflicts: Region[] } {
  const conflicts: Region[] = [];
  function node(path: string, input: Term<Entry>[]): Entry {
    const terms = simplify(input, entryKey);
    if (terms.length === 1) return terms[0]!.value;
    if (terms.every((term) => term.value?.directory)) {
      const directories = terms.map((term) => decodeWireDirectory(objects.load(term.value!.directory!)));
      // Collection semantics remain the production merge policy's responsibility.
      // This experiment keeps a divergent collection directory as one alternative.
      if (directories.every((directory) => !directory.childrenSource)) {
        const names = new Set(directories.flatMap((directory) => directory.entries.map((entry) => entry.name)));
        const entries: WireDirectoryEntry[] = [];
        const byName = directories.map((directory) => new Map(directory.entries.map((entry) => [entry.name, entry])));
        for (const name of names) {
          const entry = node(childPath(path, name), terms.map((term, index) => ({ sign: term.sign, value: byName[index]!.get(name) ?? null })));
          if (entry) entries.push(entry);
        }
        return { name: selected(terms)!.name, directory: objects.put(encodeWireDirectory({ type: "directory", entries: sorted(entries) })) };
      }
    }
    if (path.endsWith(".md") && terms.every((term) => term.value?.file)) {
      const files = terms.map((term) => ({ sign: term.sign, value: term.value!.file! }));
      let utf8 = true;
      try { for (const term of files) new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(objects.load(term.value)); }
      catch { utf8 = false; }
      if (utf8) return { name: selected(terms)!.name, file: textProjection(path, files, objects, conflicts) };
    }
    conflicts.push({ id: regionID(path, "entry", terms.map((term) => [term.sign, entryKey(term.value)])), path, kind: "entry", terms });
    return selected(terms);
  }
  const root = node("/", roots.map((term) => ({ sign: term.sign, value: { name: "", directory: term.value } })))?.directory;
  if (!root) throw new Error("Projection must remain a directory");
  return { root, conflicts };
}

/**
 * Exact cancellation is not authorization to retire an existing disagreement.
 * An ordinary edit may replace the selected positive term. Every other signed
 * piece must remain visible in one distinct review region at the same path.
 * Ambiguous relocation/coalescing is rejected, not guessed. This deliberately
 * conservative guard is a spike result, not a proposed public intent protocol.
 */
export function preservesConflicts(previous: Region[], next: Region[]): boolean {
  const keys = (region: Region): Array<{ sign: 1 | -1; key: string }> => region.kind === "text"
    ? region.terms.map((term) => ({ sign: term.sign, key: bytesKey(term.value) }))
    : region.terms.map((term) => ({ sign: term.sign, key: entryKey(term.value) }));
  const used = new Set<string>();
  for (const before of previous) {
    const required = keys(before);
    required.splice(required.findIndex((term) => term.sign === 1), 1);
    const match = next.find((after) => {
      if (used.has(after.id) || before.path !== after.path || before.kind !== after.kind) return false;
      if (before.kind === "text" && after.kind === "text"
        && (before.context.before !== after.context.before || before.context.after !== after.context.after)) return false;
      const remaining = keys(after);
      for (const term of required) {
        const index = remaining.findIndex((other) => other.sign === term.sign && other.key === term.key);
        if (index < 0) return false;
        remaining.splice(index, 1);
      }
      return true;
    });
    if (!match) return false;
    used.add(match.id);
  }
  return true;
}

/** Apply explicit choices to EVERY term, retiring just the selected regions. */
export function resolveRegions(roots: Term<ObjectHash>[], regions: Region[], choices: Resolution[], objects: Objects): Term<ObjectHash>[] {
  if (!choices.length) throw new Error("Resolution requires a choice");
  const byID = new Map(regions.map((region) => [region.id, region]));
  const seen = new Set<string>();
  const entries = new Map<string, Entry>();
  const text = new Map<string, Array<{ region: TextRegion; replacement: Uint8Array }>>();
  for (const choice of choices) {
    const region = byID.get(choice.conflict);
    if (!region || seen.has(choice.conflict)) throw new Error("Unknown or duplicate conflict");
    seen.add(choice.conflict);
    if ("take" in choice && (!Number.isSafeInteger(choice.take) || region.terms[choice.take]?.sign !== 1)) throw new Error("Choose a positive alternative");
    if (region.kind === "entry") {
      if (!("take" in choice)) throw new Error("Structural resolution requires an existing alternative");
      entries.set(region.path, region.terms[choice.take]!.value);
    } else {
      const replacement = "bytes" in choice ? choice.bytes : region.terms[choice.take]!.value;
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(replacement);
      const edits = text.get(region.path) ?? [];
      edits.push({ region, replacement });
      text.set(region.path, edits);
    }
  }
  function rewrite(path: string, entry: Entry): Entry {
    if (entries.has(path)) return entries.get(path)!;
    if (!entry) return null;
    if (entry.directory) {
      const directory = decodeWireDirectory(objects.load(entry.directory));
      const names = new Set(directory.entries.map((child) => child.name));
      // A selected structural alternative may add a path missing from this term.
      for (const target of entries.keys()) {
        const slash = target.lastIndexOf("/");
        if ((target.slice(0, slash) || "/") === path) names.add(target.slice(slash + 1));
      }
      const existing = new Map(directory.entries.map((child) => [child.name, child]));
      const children: WireDirectoryEntry[] = [];
      for (const name of names) {
        const child = rewrite(childPath(path, name), existing.get(name) ?? null);
        if (child) children.push(child);
      }
      return { name: entry.name, directory: objects.put(encodeWireDirectory({ ...directory, entries: sorted(children) })) };
    }
    const edits = text.get(path);
    if (!edits?.length) return entry;
    if (!entry.file) throw new Error("Text resolution lost its source");
    const bytes = objects.load(entry.file);
    const patches = edits.map(({ region, replacement }) => {
      const range = region.ranges.get(entry.file!);
      if (!range) throw new Error("Text resolution lost its range");
      return { ...range, replacement };
    }).sort((a, b) => a.start - b.start);
    const parts: Uint8Array[] = [];
    let cursor = 0;
    for (const patch of patches) {
      if (patch.start < cursor) throw new Error("Overlapping resolutions");
      parts.push(bytes.subarray(cursor, patch.start), patch.replacement);
      cursor = patch.end;
    }
    parts.push(bytes.subarray(cursor));
    return { name: entry.name, file: objects.put(Buffer.concat(parts)) };
  }
  return simplify(roots.map((term) => {
    const root = rewrite("/", { name: "", directory: term.value })?.directory;
    if (!root) throw new Error("Resolution must keep a directory root");
    return { sign: term.sign, value: root };
  }), (hash) => hash);
}
