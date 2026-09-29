import { objectDelta, applyObjectDelta, encodeObjectDeltaJSON, encodeWireBody, decodeBase64, decodeProtocolDirectory, encodeProtocolDirectory, encodeBase64, arrangeSources, decodeTreeSnapshotJSON, hashObject, type CandidateUpdateJSON, type SourceOperation } from "@overstory/protocol";
import { UpdateValidationError } from "./control.ts";
import type { LocalChange } from "./local-change.ts";

/** Immutable wire identity plus the durable local records/results it covers. */
export interface ChangePublication {
  changes: string[];
  update: CandidateUpdateJSON;
  operations: Record<string, Record<string, string>>;
}
const identity = (prefix: string, changes: string[]) => prefix + hashObject(new TextEncoder().encode(JSON.stringify(changes))).replace("sha256:", "");

/** Compose the same original span through repeated pure moves, by provenance
 * coordinates. Equal text at a different position never identifies that span. */
function movePublication(records: LocalChange[]): ChangePublication | undefined {
  const first = records[0]!, last = records.at(-1)!;
  const frames = records.flatMap(record => record.update.trace ?? []);
  if (frames.length < 2 || frames.some(frame => frame.operations.length !== 1 || frame.operations[0]!.kind !== "moveSource")) return;
  type Span = [number, number];
  const reference = (value: any): { path: string; object: string; range: Span } | undefined => {
    if (value?.material?.kind !== "basis" || !Array.isArray(value.range) || value.range.length !== 2 || value.range[1] <= value.range[0]) return;
    return { path: value.material.path, object: value.material.object, range: value.range };
  };
  const original = reference((frames[0]!.operations[0] as any).source);
  if (!original) return;
  const bytes = decodeTreeSnapshotJSON(first.graph).objects.get(original.object);
  if (!bytes || original.range[1] > bytes.length) return;
  let pieces: Span[] = [[0, bytes.length]];
  function select([a, b]: Span, source: Span[]): Span[] {
    let offset = 0;
    const out: Span[] = [];
    for (const [start, end] of source) {
      const lo = Math.max(a, offset), hi = Math.min(b, offset + end - start);
      if (lo < hi) out.push([start + lo - offset, start + hi - offset]);
      offset += end - start;
    }
    return out;
  }
  function contiguous(spans: Span[]): Span | undefined {
    if (!spans.length || spans.some((span, i) => i > 0 && spans[i - 1]![1] !== span[0])) return;
    return [spans[0]![0], spans.at(-1)![1]];
  }
  const render = (spans: Span[]) => {
    const result = new Uint8Array(bytes.length);
    let offset = 0;
    for (const [a, b] of spans) { result.set(bytes.subarray(a, b), offset); offset += b - a; }
    return result;
  };
  let anchor: Span | undefined, side: "before" | "after" | undefined, root = first.graph.root;
  for (const frame of frames) {
    const op = frame.operations[0]!;
    if (op.kind !== "moveSource") return;
    const source = reference(op.source), target = reference(op.at);
    if (!source || !target || frame.before !== root || source.path !== original.path || target.path !== original.path || source.object !== target.object
        || source.range[1] > bytes.length || target.range[1] > bytes.length || hashObject(render(pieces)) !== source.object) return;
    const selected = contiguous(select(source.range, pieces)), mapped = contiguous(select(target.range, pieces));
    if (!selected || selected[0] !== original.range[0] || selected[1] !== original.range[1] || !mapped
        || (mapped[0] < original.range[1] && original.range[0] < mapped[1])) return;
    let at = op.side === "before" ? target.range[0] : target.range[1];
    if (at > source.range[0] && at < source.range[1]) return;
    const moved = select(source.range, pieces), rest = [...select([0, source.range[0]], pieces), ...select([source.range[1], bytes.length], pieces)];
    const width = source.range[1] - source.range[0];
    if (at >= source.range[1]) at -= width;
    pieces = [...select([0, at], rest), ...moved, ...select([at, bytes.length - width], rest)];
    anchor = mapped; side = op.side; root = frame.after;
  }
  if (!anchor || !side || root !== last.candidate.root) return;
  const final = render(pieces), graph = decodeTreeSnapshotJSON(last.candidate);
  if (!graph.objects.has(hashObject(final))) return;
  const moved = arrangeSources(new Map([[original.path, bytes]]), [{source: {path: original.path, range: original.range}, anchor: {path: original.path, range: anchor}, side}], []).get(original.path);
  if (!moved || hashObject(moved) !== hashObject(final)) return;
  const ref = (range: Span) => ({ material: { kind: "basis" as const, path: original.path, object: original.object }, range });
  const changes = records.map(record => record.change), known = new Set(first.graph.objects.map(object => object.hash));
  return { changes, update: { change: identity("moves-", changes), candidate: root, resolves: [], deltas: [],
    objects: last.candidate.objects.filter(object => !known.has(object.hash)),
    trace: [{ before: first.graph.root, after: root, operations: [{ key: "move", kind: "moveSource", source: ref(original.range), at: ref(anchor), side }] }] },
    operations: Object.fromEntries(records.map(record => [record.change, Object.fromEntries(record.update.trace!.flatMap(frame => frame.operations).map(op => [op.key, "move"]))])) };
}

/** Concatenate proven frames under one fresh identity, preserving result names
 * through an explicit mapping. Snapshots, resolutions and trace limits are
 * boundaries. Repeated pure moves additionally collapse to one operation. */
export function publication(records: LocalChange[], previous: ChangePublication[]): ChangePublication | undefined {
  const first = records[0], last = records.at(-1);
  if (!first || !last || records.some((record, i) => record.tree !== first.tree || !record.update.trace || (records.length > 1 && (record.update.resolves.length || record.update.ifCurrent !== undefined)) || (i > 0 && (record.basis.kind !== "authored" || record.basis.change !== records[i-1]!.change || records[i-1]!.candidate.root !== record.graph.root)))) return;
  const moved = !first.update.resolves.length && first.update.ifCurrent === undefined ? movePublication(records) : undefined;
  if (moved) return moved;
  const frames = records.flatMap(record => record.update.trace!);
  if (!frames.length || frames.length > 64 || frames.reduce((n, frame) => n + frame.operations.length, 0) > 1024) return;
  const changes = records.map(record => record.change), change = identity("batch-", changes);
  const names: Record<string, Record<string, string>> = {};
  let count = 0;
  for (const record of records) names[record.change] = Object.fromEntries(record.update.trace!.flatMap(frame => frame.operations).map(op => [op.key, `op-${count++}`]));
  function rewrite(value: any): any {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    let fields = value;
    if (fields.kind === "operation") {
      const group = previous.find(group => group.changes.includes(fields.change));
      if (names[fields.change]?.[fields.operation]) fields = {...fields, change, operation: names[fields.change]![fields.operation]};
      else if (group?.operations[fields.change]?.[fields.operation]) fields = {...fields, change: group.update.change, operation: group.operations[fields.change]![fields.operation]};
    }
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, rewrite(item)]));
  }
  const known = new Set(first.graph.objects.map(object => object.hash));
  const objects = new Map(records.flatMap(record => record.update.objects).map(object => [object.hash, object]));
  // Deltas must reach the final candidate. Intermediate versions remain
  // envelopes when a later frame still needs their material.
  const finalObjects = new Set(last.candidate.objects.map(object => object.hash));
  const deltas = first.update.deltas.filter(delta => !objects.has(delta.result) && finalObjects.has(delta.result));
  for (const delta of first.update.deltas) if (!finalObjects.has(delta.result)) {
    const object = first.candidate.objects.find(object => object.hash === delta.result);
    if (!object) return;
    objects.set(object.hash, object);
  }
  return { changes, operations: names, update: { change, candidate: last.candidate.root, resolves: first.update.resolves, ...(first.update.ifCurrent !== undefined ? {ifCurrent: first.update.ifCurrent} : {}), deltas,
    trace: records.flatMap(record => record.update.trace!.map(frame => ({...frame, operations: frame.operations.map(op => ({...rewrite(op), key: names[record.change]![op.key]}) as SourceOperation)}))),
    objects: [...objects.values()].filter(object => !known.has(object.hash)).sort((a,b) => a.hash.localeCompare(b.hash)) } };
}

/** A branch captured inside a frozen batch can cross its remaining frames only
 * when both sides read and write disjoint existing files. This is a commutation
 * proof from operations, not a byte-equality rebase. Original records stay intact.
 * Each transported record gets a new, durable wire identity. */
export function branchPublications(group: ChangePublication, shared: number, branch: LocalChange[], records: Map<string, LocalChange>): ChangePublication[] | undefined {
  const members = group.changes.map(change => records.get(change));
  if (members.some(record => !record) || shared <= 0 || shared >= members.length || !branch.length) return;
  function paths(record: LocalChange): Set<string> | undefined {
    if (!record.update.trace?.length || record.update.resolves.length || record.update.ifCurrent !== undefined) return;
    const result = new Set<string>();
    function visit(value: any): boolean {
      if (!value || typeof value !== "object") return true;
      if (value.material) {
        if (value.material.kind !== "basis" || typeof value.material.path !== "string" || !value.range) return false;
        result.add(value.material.path);
      }
      return Object.values(value).every(visit);
    }
    for (const frame of record.update.trace) for (const op of frame.operations) {
      if (!["editSource", "moveSource", "copySource"].includes(op.kind) || !visit(op)) return;
    }
    return result.size ? result : undefined;
  }
  const crossed = new Set<string>();
  for (const record of members.slice(shared)) {
    const footprint = paths(record!); if (!footprint) return;
    for (const path of footprint) crossed.add(path);
  }
  for (const record of branch) {
    const footprint = paths(record); if (!footprint || [...footprint].some(path => crossed.has(path))) return;
  }
  const end = members.at(-1)!, split = members[shared - 1]!;
  if (branch[0]!.graph.root !== split.candidate.root) return;
  const objects = new Map([...members as LocalChange[], ...branch].flatMap(record =>
    [record.graph, record.candidate].flatMap(graph => [...decodeTreeSnapshotJSON(graph).objects])));
  const directory = (hash: string) => decodeProtocolDirectory(objects.get(hash)!);
  function file(root: string, path: string): string {
    const parts = path.slice(1).split("/"); let hash = root;
    for (const [i, part] of parts.entries()) {
      const entry = directory(hash).entries.find(entry => entry.name === part);
      if (i === parts.length - 1 && entry?.file !== undefined) return entry.file;
      if (!entry?.directory) throw new UpdateValidationError("Publication branch requires existing files");
      hash = entry.directory;
    }
    throw new UpdateValidationError("Invalid publication branch path");
  }
  const replacements = [...crossed].sort().map(path => ({path, before: file(split.candidate.root, path), after: file(end.candidate.root, path)}));
  const result: ChangePublication[] = [];
  for (const record of branch) {
    const supplied = new Map(record.update.objects.map(object => [object.hash, object]));
    for (const delta of record.update.deltas) {
      const object = record.candidate.objects.find(object => object.hash === delta.result);
      if (!object) return;
      supplied.set(object.hash, object);
    }
    function lift(root: string): string {
      for (const replacement of replacements) {
        if (file(root, replacement.path) !== replacement.before) throw new UpdateValidationError("Publication branch changed crossed material");
        const parts = replacement.path.slice(1).split("/");
        function replace(hash: string, depth: number): string {
          const value = directory(hash);
          value.entries = value.entries.map(entry => entry.name !== parts[depth] ? entry : depth === parts.length - 1
            ? {name: entry.name, file: replacement.after} : {name: entry.name, directory: replace(entry.directory!, depth + 1)});
          const bytes = encodeProtocolDirectory(value), next = hashObject(bytes);
          objects.set(next, bytes); supplied.set(next, {hash: next, bytes: encodeBase64(bytes)});
          return next;
        }
        root = replace(root, 0);
      }
      return root;
    }
    const trace = record.update.trace!.map(frame => ({...frame, before: lift(frame.before), after: lift(frame.after)}));
    const change = identity("continuation-", [group.update.change, record.change]);
    result.push({changes: [record.change], operations: {[record.change]: Object.fromEntries(trace.flatMap(frame => frame.operations).map(op => [op.key, op.key]))},
      update: {...record.update, change, candidate: trace.at(-1)!.after, trace, deltas: [], objects: [...supplied.values()].sort((a,b) => a.hash.localeCompare(b.hash))}});
  }
  if (result[0]!.update.trace![0]!.before !== group.update.candidate) return;
  return result;
}


/** Compress final reachable envelopes against the request's accepted basis.
 * Transport matching never establishes semantic provenance. */
export function compactTransport(update: CandidateUpdateJSON, basis: LocalChange["graph"], candidate: LocalChange["candidate"]): CandidateUpdateJSON {
  if (!update.objects.length) return update;
  const before = decodeTreeSnapshotJSON(basis).objects, after = decodeTreeSnapshotJSON(candidate).objects;
  const envelopes = new Map(update.objects.map(object => [object.hash, object])), deltas = [...update.deltas], visited = new Set<string>();
  function visit(old: string | undefined, next: string, directory: boolean): void {
    if (visited.has(next)) return;
    visited.add(next);
    if (before.has(next)) { envelopes.delete(next); return; }
    const base = old && before.get(old), envelope = envelopes.get(next);
    if (base && envelope && base.length <= 64 * 1024 * 1024) {
      const bytes = decodeBase64(envelope.bytes);
      if (bytes.length <= 64 * 1024 * 1024 && bytes.length) {
        const delta = {base: old!, result: next, instructions: objectDelta(base, bytes)};
        if (hashObject(applyObjectDelta(base, delta)) !== next) throw new UpdateValidationError("Invalid publication transport delta");
        const encoded = encodeObjectDeltaJSON(delta);
        if (encodeWireBody(delta, "cbor").length < encodeWireBody({hash: next, bytes}, "cbor").length) { envelopes.delete(next); deltas.push(encoded); }
      }
    }
    if (!directory) return;
    const entries = decodeProtocolDirectory(after.get(next)!).entries;
    const prior = new Map(old && before.has(old) ? decodeProtocolDirectory(before.get(old)!).entries.map(entry => [entry.name, entry]) : []);
    for (const entry of entries) {
      if (entry.file) visit(prior.get(entry.name)?.file, entry.file, false);
      else if (entry.directory) visit(prior.get(entry.name)?.directory, entry.directory, true);
    }
  }
  visit(basis.root, candidate.root, true);
  return {...update, objects: [...envelopes.values()].sort((a,b) => a.hash.localeCompare(b.hash)), deltas};
}
