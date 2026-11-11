import { composeSourceEdits, deriveTrace, entryTimeOf, type ObjectHash, decodeProtocolPage, encodeProtocolPage, type PlainSourceEdit, objectDelta, applyObjectDelta, encodeObjectDeltaJSON, encodeWireBody, decodeBase64, decodeProtocolDirectory, encodeProtocolDirectory, encodeBase64, arrangeSources, decodeTreeSnapshotJSON, hashObject, protocolObjectReferences, type ProtocolDirectoryEntry, type ProtocolObjectKind, type SourceOperation } from "@ovst/protocol";
import type { LocalUpdate } from "./local-change.ts";
import { UpdateValidationError } from "./control.ts";
import type { LocalChange } from "./local-change.ts";

/** Immutable wire identity plus the durable local records/results it covers. */
export interface ChangePublication {
  changes: string[];
  update: LocalUpdate;
  operations: Record<string, Record<string, string>>;
}
const identity = (prefix: string, changes: string[]) => prefix + hashObject(new TextEncoder().encode(JSON.stringify(changes))).replace("sha256:", "");

type Frame = NonNullable<LocalUpdate["trace"]>[number];

/** Compose the same original span through repeated pure moves, by provenance
 * coordinates. Equal text at a different position never identifies that span. */
function movePublication(records: LocalChange[]): ChangePublication | undefined {
  const first = records[0]!, last = records.at(-1)!;
  const frames = records.flatMap(record => record.update.trace ?? []);
  const frame = composeMoves(frames, decodeTreeSnapshotJSON(first.graph).objects, decodeTreeSnapshotJSON(last.candidate).objects, "move");
  if (!frame || frame.after !== last.candidate.root) return;
  const changes = records.map(record => record.change), known = new Set(first.graph.objects.map(object => object.hash));
  return { changes, update: { change: identity("moves-", changes), at: last.update.at, candidate: frame.after, resolves: [], deltas: [],
    objects: last.candidate.objects.filter(object => !known.has(object.hash)), trace: [frame] },
    operations: Object.fromEntries(records.map(record => [record.change, Object.fromEntries(record.update.trace!.flatMap(frame => frame.operations).map(op => [op.key, "move"]))])) };
}

const pureMove = (frame: Frame) => frame.operations.length === 1 && frame.operations[0]!.kind === "moveSource";

/** The one move a run of single-move frames amounts to, when every frame moves
 * the same original span: `start` holds the run's first tree, `end` its last. */
function composeMoves(frames: Frame[], start: Map<string, Uint8Array>, end: Map<string, Uint8Array>, key: string): Frame | undefined {
  if (frames.length < 2 || !frames.every(pureMove)) return;
  type Span = [number, number];
  const reference = (value: any): { path: string; object: string; range: Span } | undefined => {
    if (value?.material?.kind !== "basis" || !Array.isArray(value.range) || value.range.length !== 2 || value.range[1] <= value.range[0]) return;
    return { path: value.material.path, object: value.material.object, range: value.range };
  };
  const original = reference((frames[0]!.operations[0] as any).source);
  if (!original) return;
  const bytes = start.get(original.object);
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
  let anchor: Span | undefined, side: "before" | "after" | undefined, root = frames[0]!.before;
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
  if (!anchor || !side) return;
  const final = render(pieces);
  if (!end.has(hashObject(final))) return;
  const moved = arrangeSources(new Map([[original.path, bytes]]), [{source: {path: original.path, range: original.range}, anchor: {path: original.path, range: anchor}, side}], []).get(original.path);
  if (!moved || hashObject(moved) !== hashObject(final)) return;
  const ref = (range: Span) => ({ material: { kind: "basis" as const, path: original.path, object: original.object }, range });
  return { before: frames[0]!.before, after: root, operations: [{ key, kind: "moveSource", source: ref(original.range), at: ref(anchor), side }] };
}

/** Concatenate proven frames under one fresh identity, preserving result names
 * through an explicit mapping. Snapshots, resolutions and trace limits are
 * boundaries. Repeated pure moves additionally collapse to one operation, and
 * runs of plain edits to one frame of the edits they amount to; the trace
 * limits apply to the result. */
export function publication(records: LocalChange[], previous: ChangePublication[]): ChangePublication | undefined {
  const first = records[0], last = records.at(-1);
  if (!first || !last || records.some((record, i) => record.tree !== first.tree || !record.update.trace || (records.length > 1 && (record.update.resolves.length || record.update.ifCurrent !== undefined)) || (i > 0 && (record.basis.kind !== "authored" || record.basis.change !== records[i-1]!.change || records[i-1]!.candidate.root !== record.graph.root)))) return;
  const moved = !first.update.resolves.length && first.update.ifCurrent === undefined ? movePublication(records) : undefined;
  if (moved) return moved;
  const frames = records.flatMap(record => record.update.trace!);
  if (!frames.length) return;
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
  const renamed = records.flatMap(record => record.update.trace!.map(frame => ({...frame, operations: frame.operations.map(op => ({...rewrite(op), key: names[record.change]![op.key]}) as SourceOperation)})));
  const trace = composePlainRuns(renamed, records, change, names);
  if (trace.length > 64 || trace.reduce((n, frame) => n + frame.operations.length, 0) > 1024) return;
  // A coalesced update is as late as its last record; each entry keeps the
  // time its own record stamped (data model §6).
  return { changes, operations: names, update: { change, at: last.update.at, candidate: last.candidate.root, resolves: first.update.resolves, ...(first.update.ifCurrent !== undefined ? {ifCurrent: first.update.ifCurrent} : {}), deltas,
    trace,
    objects: [...objects.values()].filter(object => !known.has(object.hash)).sort((a,b) => a.hash.localeCompare(b.hash)) } };
}


/** A frame is plain when every operation is a lineage-free `editSource` over
 * `basis` material of one path with a range (as `compactTrace` in
 * local-change.ts and `LocalChange.plainEdits` in Swift define it). */
function plainFrame(frame: Frame): { path: string; object: string; edits: PlainSourceEdit[] } | undefined {
  let path: string | undefined, object: string | undefined;
  const edits: PlainSourceEdit[] = [];
  for (const op of frame.operations) {
    if (op.kind !== "editSource" || op.lineage?.length || op.source.material.kind !== "basis" || op.source.within?.length || !op.source.range) return;
    const material = op.source.material;
    if ((path !== undefined && path !== material.path) || (object !== undefined && object !== material.object)) return;
    path = material.path; object = material.object;
    edits.push({ offset: op.source.range[0], length: op.source.range[1] - op.source.range[0], replacement: op.text });
  }
  if (path === undefined || object === undefined) return;
  return { path, object, edits: edits.sort((a, b) => a.offset - b.offset) };
}

/** Merge 002 case 1: plain edits across local records. Each run of adjacent
 * plain frames over one path becomes one frame of edits stated over the
 * run's first basis (`composeSourceEdits`), so a typing burst publishes as
 * the edits it amounts to rather than one frame per keystroke.
 *
 * Identity: inserted text that a later frame deleted never reaches the
 * published account; basis bytes deleted and retyped stay a replacement, so
 * equal bytes never stand in for their origin. A run is kept as it is when
 * any operation result in it is referenced (its published name would no
 * longer exist), when its end trees are not held, or when the composed frame
 * does not take the run's first tree exactly to its last. Composed
 * operations are named `edit-<k>-<i>`, `k` the run's first frame index, and
 * the originals they replace leave the publication's name mapping. */
function composePlainRuns(frames: Frame[], records: LocalChange[], change: string, names: Record<string, Record<string, string>>): Frame[] {
  const referenced = new Set<string>();
  (function visit(value: any): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    if (value.kind === "operation" && value.change === change) referenced.add(value.operation);
    Object.values(value).forEach(visit);
  })(frames);
  const trees = new Map<string, Map<string, Uint8Array>>();
  const tree = (root: string) => {
    if (trees.has(root)) return trees.get(root);
    for (const record of records) for (const graph of [record.graph, record.candidate]) if (graph.root === root) {
      const objects = decodeTreeSnapshotJSON(graph).objects; trees.set(root, objects); return objects;
    }
  };
  const result: Frame[] = [], removed = new Set<string>();
  let index = 0;
  while (index < frames.length) {
    const first = plainFrame(frames[index]!), moving = pureMove(frames[index]!);
    let end = index + 1;
    if (first) while (end < frames.length) {
      const next = plainFrame(frames[end]!);
      if (!next || next.path !== first.path) break;
      end++;
    }
    else if (moving) while (end < frames.length && pureMove(frames[end]!)) end++;
    const run = frames.slice(index, end), free = run.length > 1 && !run.some(frame => frame.operations.some(op => referenced.has(op.key)));
    const start = free ? tree(run[0]!.before) : undefined, finish = free ? tree(run.at(-1)!.after) : undefined;
    const moved = moving && start && finish ? composeMoves(run, start, finish, `move-${index}`) : undefined;
    const composed = first && free ? composeRun(run, first.path, first.object, index, tree) : moved && moved.after === run.at(-1)!.after ? [moved] : undefined;
    if (composed) { result.push(...composed); for (const frame of run) for (const op of frame.operations) removed.add(op.key); }
    else result.push(...run);
    index = end;
  }
  // A burst that cancels completely keeps its frames: an empty trace states nothing.
  if (!result.length) return frames;
  if (removed.size) for (const map of Object.values(names)) for (const [key, name] of Object.entries(map)) if (removed.has(name)) delete map[key];
  return result;
}

function composeRun(run: Frame[], path: string, object: string, index: number, tree: (root: string) => Map<string, Uint8Array> | undefined): Frame[] | undefined {
  const before = run[0]!.before, after = run.at(-1)!.after;
  const start = tree(before), finish = tree(after);
  if (!start || !finish) return;
  let edits: PlainSourceEdit[];
  try { edits = composeSourceEdits(run.map(frame => plainFrame(frame)!.edits)); } catch { return; }
  // Verify: the composed edits take the path's content in the first tree to
  // the last tree, and nothing else differs.
  const parts = path.slice(1).split("/"), directories: Array<{ hash: string; value: ReturnType<typeof decodeProtocolDirectory> }> = [];
  let hash = before;
  for (const [i, part] of parts.entries()) {
    const bytes = start.get(hash); if (!bytes) return;
    const value = decodeProtocolDirectory(bytes); directories.push({ hash, value });
    const entry = value.entries.find(entry => entry.name === part);
    if (!entry) return;
    if (i < parts.length - 1) { if (!entry.directory) return; hash = entry.directory; continue; }
    const content = entry.file ?? entry.page;
    if (content !== object) return;
    const stored = start.get(content); if (!stored) return;
    const page = entry.page !== undefined ? decodeProtocolPage(stored) : undefined;
    const source = page ? page.body : stored;
    const produced = applyPlainEdits(source, edits); if (!produced) return;
    let next = page ? hashObject(encodeProtocolPage({ ...page, body: produced })) : hashObject(produced);
    // The run's last tree says when the entry changed.
    let times: { created: number; modified: number } | undefined, at = after;
    for (const [i, part] of parts.entries()) {
      const bytes = finish.get(at); if (!bytes) return;
      const found = decodeProtocolDirectory(bytes).entries.find(entry => entry.name === part);
      if (i < parts.length - 1) { if (!found?.directory) return; at = found.directory; continue; }
      if (found?.created === undefined) return;
      times = { created: found.created, modified: found.modified };
    }
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const directory = directories[depth]!.value;
      const entries = directory.entries.map((item): ProtocolDirectoryEntry => item.name !== parts[depth] ? item : depth === parts.length - 1
        ? (page ? { name: item.name, page: next, ...times! } : { name: item.name, file: next, ...times! }) : { name: item.name, directory: next });
      next = hashObject(encodeProtocolDirectory({ ...directory, entries }));
    }
    if (next !== after) return;
    if (!edits.length) return [];
    return [{ before, after, operations: edits.map((edit, i) => ({ key: `edit-${index}-${i}`, kind: "editSource" as const,
      source: { material: { kind: "basis" as const, path, object }, range: [edit.offset, edit.offset + edit.length] as [number, number] }, text: edit.replacement })) }];
  }
}

function applyPlainEdits(source: Uint8Array, edits: PlainSourceEdit[]): Uint8Array | undefined {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.offset < cursor || edit.offset + edit.length > source.length) return;
    chunks.push(source.subarray(cursor, edit.offset), encoder.encode(edit.replacement));
    cursor = edit.offset + edit.length;
  }
  chunks.push(source.subarray(cursor));
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
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
  // A crossed file or page, by its object; the entry keeps its kind.
  function file(root: string, path: string): string { return content(root, path).object; }
  function content(root: string, path: string): { object: string; created: number; modified: number } {
    const parts = path.slice(1).split("/"); let hash = root;
    for (const [i, part] of parts.entries()) {
      const entry = directory(hash).entries.find(entry => entry.name === part);
      if (i === parts.length - 1 && (entry?.file ?? entry?.page) !== undefined) return { object: (entry!.file ?? entry!.page)!, created: entry!.created!, modified: entry!.modified! };
      if (!entry?.directory) throw new UpdateValidationError("Publication branch requires existing files");
      hash = entry.directory;
    }
    throw new UpdateValidationError("Invalid publication branch path");
  }
  const replacements = [...crossed].sort().map(path => ({path, before: file(split.candidate.root, path), after: content(end.candidate.root, path)}));
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
          const {object, created, modified} = replacement.after;
          value.entries = value.entries.map((entry): ProtocolDirectoryEntry => entry.name !== parts[depth] ? entry : depth === parts.length - 1
            ? (entry.page !== undefined ? {name: entry.name, page: object, created, modified} : {name: entry.name, file: object, created, modified}) : {name: entry.name, directory: replace(entry.directory!, depth + 1)});
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


/** Only the final candidate's new objects travel. The authority regenerates
 * every intermediate frame's objects by executing the frames (spec 10 §2.2),
 * so a batch of N edits to one page must not send N whole copies of it.
 * The value of an added or replaced entry is kept, because execution reads
 * it rather than producing it. Snapshots and resolutions are left as
 * they are. */
export function dropIntermediates(update: LocalUpdate, candidate: LocalChange["candidate"]): LocalUpdate {
  if (!update.trace || update.resolves.length || !update.objects.length) return update;
  const envelopes = new Map(update.objects.map(object => [object.hash, object.bytes]));
  const after = decodeTreeSnapshotJSON(candidate).objects, deltas = new Set(update.deltas.map(delta => delta.result));
  // What the request carries: whole objects and delta results. Anything else
  // the final root reaches is already the host's, and so is all it reaches.
  const carried = (hash: string) => { const bytes = envelopes.get(hash); return bytes !== undefined ? decodeBase64(bytes) : deltas.has(hash) ? after.get(hash) : undefined; };
  // An added or replaced entry's value is the one object an operation
  // names that execution cannot produce; it travels with what it reaches.
  const kept = new Set<string>(), stack: Array<{ kind: ProtocolObjectKind; hash: string }> = [{ kind: "directory", hash: update.candidate }];
  for (const frame of update.trace) for (const operation of frame.operations) {
    if (operation.kind !== "addEntry" && operation.kind !== "replaceEntry") continue;
    const value = operation.value as { file?: string; page?: string; directory?: string };
    if (value.file) stack.push({ kind: "file", hash: value.file });
    else if (value.page) stack.push({ kind: "page", hash: value.page });
    else if (value.directory) stack.push({ kind: "directory", hash: value.directory });
  }
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (kept.has(next.hash)) continue;
    const bytes = carried(next.hash);
    if (!bytes) continue;
    kept.add(next.hash);
    stack.push(...protocolObjectReferences(next.kind, bytes));
  }
  return { ...update, objects: update.objects.filter(object => kept.has(object.hash)) };
}

/** Compress final reachable envelopes against the element's basis graph.
 * Transport matching never establishes semantic provenance. */
export function compactTransport(update: LocalUpdate, basis: LocalChange["graph"], candidate: LocalChange["candidate"]): LocalUpdate {
  update = dropIntermediates(update, candidate);
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
      const content = entry.file ?? entry.page;
      if (content) { const old = prior.get(entry.name); visit(old?.file ?? old?.page, content, false); }
      else if (entry.directory) visit(prior.get(entry.name)?.directory, entry.directory, true);
    }
  }
  visit(basis.root, candidate.root, true);
  return {...update, objects: [...envelopes.values()].sort((a,b) => a.hash.localeCompare(b.hash)), deltas};
}

/**
 * `update` with its frames replayed from `basis` at its own `at`, as the host
 * replays them (data model §6): every entry the update touches is stamped
 * with the update's time, so a batch of edits made at different times
 * carries the last one's time throughout, and an update after one that was
 * restamped continues from that root. The objects the new roots reach that
 * the update does not already carry are added; intermediate frames' objects,
 * which the host regenerates, are not. Undefined when the frames cannot be
 * replayed here (row operations, which need a collection replay), so the
 * update goes as it is.
 */
export async function restampUpdate(update: LocalUpdate, basis: string, load: (hash: string) => Promise<Uint8Array>): Promise<{ update: LocalUpdate; generated: Map<string, Uint8Array> } | undefined> {
  if (!update.trace?.length) return;
  let derived: Awaited<ReturnType<typeof deriveTrace>>;
  try {
    derived = await deriveTrace(basis as ObjectHash, update.trace.map(frame => ({ operations: frame.operations })), load as (hash: ObjectHash) => Promise<Uint8Array>, entryTimeOf(update.at));
  } catch {
    // Unsupported here (UnsupportedDerivation) or not reproducible: sent as it is.
    return;
  }
  // What the update carries and the new root still reaches stays; the new
  // directories the replay made are added whole. Walk only new or carried
  // objects: anything else the host already holds, with all it reaches.
  const envelopes = new Map(update.objects.map(object => [object.hash, object])), deltas = new Map(update.deltas.map(delta => [delta.result, delta]));
  const keptObjects = new Map<string, { hash: string; bytes: string }>(), keptDeltas = new Set<string>(), seen = new Set<string>();
  const stack: Array<{ kind: ProtocolObjectKind; hash: string }> = [{ kind: "directory", hash: derived.root }];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (seen.has(next.hash)) continue;
    seen.add(next.hash);
    const envelope = envelopes.get(next.hash), made = derived.generated.get(next.hash as ObjectHash);
    let bytes: Uint8Array | undefined;
    if (envelope) { keptObjects.set(next.hash, envelope); bytes = decodeBase64(envelope.bytes); }
    else if (deltas.has(next.hash)) { keptDeltas.add(next.hash); bytes = made ?? await load(next.hash).catch(() => undefined); }
    // A new directory travels whole; new content was already carried, or is
    // the host's (unchanged by the restamp, which changes only directories).
    else if (made && next.kind === "directory") { keptObjects.set(next.hash, { hash: next.hash, bytes: encodeBase64(made) }); bytes = made; }
    if (bytes) stack.push(...protocolObjectReferences(next.kind, bytes));
  }
  // Execution reads an added entry's value rather than producing it.
  for (const frame of derived.frames) for (const operation of frame.operations) {
    if (operation.kind !== "addEntry" && operation.kind !== "replaceEntry") continue;
    const value = operation.value as { file?: string; page?: string; directory?: string };
    for (const hash of [value.file, value.page, value.directory]) {
      const envelope = hash ? envelopes.get(hash) : undefined;
      if (envelope) keptObjects.set(envelope.hash, envelope);
    }
  }
  const objects = [...keptObjects.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  return {
    update: { ...update, candidate: derived.root, trace: derived.frames.map(frame => ({ before: frame.before, after: frame.after, operations: [...frame.operations] })), objects,
      deltas: update.deltas.filter(delta => keptDeltas.has(delta.result)) },
    generated: derived.generated as Map<string, Uint8Array>,
  };
}
