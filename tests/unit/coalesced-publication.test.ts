import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { applyTransitionPayload, decodeCandidateUpdateJSON, applySourceChange, decodeBase64, encodeBase64, decodeTreeSnapshotJSON, encodeProtocolDirectory, hashObject, type TreeSnapshot, type SourceMove, type SourceOperation } from "@overstory/protocol";
import { prepareSourceChange, type LocalChange } from "@overstory/working-tree";
import { encodeAttempt } from "../../packages/working-tree/src/control.ts";
import { compactTransport, branchPublications, publication } from "../../packages/working-tree/src/publication.ts";
import { Fixture } from "./canopyd-merge/fixture.ts";

const vectors = JSON.parse(await readFile(new URL("../fixtures/coalesced-publication.json", import.meta.url), "utf8")) as { cases: Array<{
  name: string; source: string; frames: number; kinds: SourceOperation["kind"][];
  steps: Array<{ source: string; moves?: SourceMove[]; edits?: Array<{range: [number, number]; replacement: string}> }>;
}> };
function records(value: typeof vectors.cases[number]): LocalChange[] {
  const bytes = new TextEncoder().encode(value.source), file = hashObject(bytes);
  const directory = encodeProtocolDirectory({type: "directory", entries: [{name: "note.md", file}]}), root = hashObject(directory);
  let graph: TreeSnapshot = {root, objects: new Map([[file, bytes], [root, directory]])}, source = value.source;
  const result: LocalChange[] = [];
  for (const [index, step] of value.steps.entries()) {
    const edits = (step.edits ?? []).map(edit => ({offset: edit.range[0], length: edit.range[1] - edit.range[0], replacement: edit.replacement}));
    expect(applySourceChange(source, edits, step.moves)).toBe(step.source);
    const record = prepareSourceChange({change: `c${index}`, tree: "tr_publication", graph, sourcePath: "/note.md",
      basis: index ? {kind: "authored", change: `c${index-1}`} : {kind: "accepted", root: graph.root, update: "up_initial"},
      intent: {basis: {tree: "tr_publication", path: "/note", revision: `r${index}`, source}, edits, moves: step.moves, source: step.source}});
    result.push(record); graph = decodeTreeSnapshotJSON(record.candidate); source = step.source;
  }
  return result;
}
for (const value of vectors.cases) test(`one publication: ${value.name}`, async () => {
  const local = records(value), before = structuredClone(local), published = publication(local, [])!;
  expect(published).toBeDefined();
  expect(published.changes).toEqual(local.map(record => record.change));
  expect(published.update.trace).toHaveLength(value.frames);
  expect(published.update.trace!.flatMap(frame => frame.operations.map(op => op.kind))).toEqual(value.kinds);
  expect(local).toEqual(before);
  expect(publication(local, [])).toEqual(published);
  if (value.kinds.length === 1 && value.kinds[0] === "moveSource") {
    const wireBytes = (updates: unknown[]) => decodeBase64(encodeAttempt("tr_publication", {root: local[0]!.graph.root, update: "up_initial"}, {base: "up_initial", updates}).body).length;
    expect(wireBytes([published.update])).toBeLessThan(wireBytes(local.map(record => record.update)));
  }
  // Execute the actual compiled frames in the host's merge engine.
  const f = new Fixture();
  for (const record of local) for (const [hash, bytes] of decodeTreeSnapshotJSON(record.candidate).objects) f.objects.set(hash, bytes);
  for (const [hash, bytes] of decodeTreeSnapshotJSON(local[0]!.graph).objects) f.objects.set(hash, bytes);
  const request = f.request(local[0]!.graph.root, published.update.candidate, [], published.update.change);
  request.incoming.trace = published.update.trace!;
  const accepted = await f.run(request);
  expect(accepted.decisions).toEqual([]);
  expect(f.content(accepted.result.object, "note.md")).toBe(value.steps.at(-1)!.source);
});

for (const value of vectors.cases.filter(value => value.kinds.length === 1 && value.kinds[0] === "moveSource")) {
  for (const reverse of [false, true]) test(`peer edit follows coalesced origin: ${value.name}, peer ${reverse ? "last" : "first"}`, async () => {
    const local = records(value), published = publication(local, [])!;
    const op = published.update.trace![0]!.operations[0]!;
    if (op.kind !== "moveSource") throw Error("Expected move");
    const offset = op.source.range![0];
    const f = new Fixture(), baseRoot = local[0]!.graph.root;
    for (const record of local) for (const [hash, bytes] of decodeTreeSnapshotJSON(record.candidate).objects) f.objects.set(hash, bytes);
    for (const [hash, bytes] of decodeTreeSnapshotJSON(local[0]!.graph).objects) f.objects.set(hash, bytes);
    const base = (await f.run(f.request(baseRoot, baseRoot, [{key: "start", kind: "editSource", source: f.ref("/note.md", value.source, [0, 0]), text: ""}], "start"))).result;
    const peerSource = value.source.slice(0, offset) + "@" + value.source.slice(offset + 1);
    const peer = f.request(base, f.tree({"note.md": peerSource}), [{key: "peer", kind: "editSource", source: f.ref("/note.md", value.source, [offset, offset + 1]), text: "@"}], "peer");
    const move = f.request(base, published.update.candidate, [], published.update.change);
    move.incoming.trace = published.update.trace!;
    const first = await f.run(reverse ? move : peer), next = reverse ? peer : move;
    next.current = first.result;
    const merged = await f.run(next);
    let expected = peerSource;
    for (const step of value.steps) expected = applySourceChange(expected, [], step.moves);
    expect(merged.decisions).toEqual([]);
    expect(f.content(merged.result.object, "note.md")).toBe(expected);
  });
}

test("operation results are renamed within and across publications without losing guards", async () => {
  const local = records(vectors.cases[0]!);
  const first = local[0]!.update.trace![0]!.operations[0]!;
  const next = local[1]!.update.trace![0]!.operations[0]!;
  if (first.kind !== "moveSource" || next.kind !== "moveSource") throw Error("Expected moves");
  next.source = {material: {kind: "operation", change: local[0]!.change, operation: first.key}, range: [0, first.source.range![1] - first.source.range![0]]};
  const combined = publication(local, [])!;
  const combinedMove = combined.update.trace![1]!.operations[0]!;
  if (combinedMove.kind !== "moveSource") throw Error("Expected move");
  expect(combinedMove.source.material).toEqual({kind: "operation", change: combined.update.change, operation: combined.operations[local[0]!.change]![first.key]!});
  const f = new Fixture();
  for (const record of local) for (const graph of [record.graph, record.candidate]) for (const [hash, bytes] of decodeTreeSnapshotJSON(graph).objects) f.objects.set(hash, bytes);
  const request = f.request(local[0]!.graph.root, combined.update.candidate, [], combined.update.change);
  request.incoming.trace = combined.update.trace!;
  const accepted = await f.run(request);
  expect(accepted.decisions).toEqual([]);
  expect(f.content(accepted.result.object, "note.md")).toBe(vectors.cases[0]!.steps.at(-1)!.source);

  const prior = publication([local[0]!], [])!;
  local[1]!.update.ifCurrent = "up_guard";
  const later = publication([local[1]!], [prior])!;
  const laterMove = later.update.trace![0]!.operations[0]!;
  if (laterMove.kind !== "moveSource") throw Error("Expected move");
  expect(laterMove.source.material).toEqual({kind: "operation", change: prior.update.change, operation: prior.operations[local[0]!.change]![first.key]!});
  expect(later.update.ifCurrent).toBe("up_guard");
  expect(publication(local, [])).toBeUndefined();
});

test("generic frame limits remain boundaries and accepted-base deltas remain compact", () => {
  let source = "A".repeat(4096) + "\n";
  const initial = source;
  const steps = Array.from({length: 65}, (_, i) => {
    const text = i % 2 ? "A" : "B";
    source = text + source.slice(1);
    return {source, edits: [{range: [0, 1] as [number, number], replacement: text}]};
  });
  const local = records({name: "long edits", source: initial, steps, frames: 65, kinds: []});
  expect(publication(local, [])).toBeUndefined();
  const partial = publication(local.slice(0, 64), [])!;
  expect(partial.update.trace).toHaveLength(64);
  const first = local[0]!;
  const result = hashObject(new TextEncoder().encode(steps[0]!.source));
  first.update.objects = first.update.objects.filter(object => object.hash !== result);
  first.update.deltas = [{base: hashObject(new TextEncoder().encode(initial)), result,
    instructions: [{insert: encodeBase64(new TextEncoder().encode("B"))}, {copy: {offset: 1, length: initial.length - 1}}]}];
  for (const delta of local[0]!.update.deltas) {
    expect(partial.update.deltas.some(item => item.result === delta.result) || partial.update.objects.some(item => item.hash === delta.result)).toBe(true);
  }
  const short = publication(local.slice(0, 2), [])!;
  expect(short.update.deltas).toEqual([]);
  expect(short.update.objects.some(object => object.hash === result)).toBe(true);
  expect(publication([first], [])!.update.deltas).toEqual(first.update.deltas);
});


test("branches inside frozen batches commute only across disjoint source footprints", async () => {
  const f = new Fixture();
  const initial = f.tree({"a.md": "A", "b.md": "B", "c.md": "C"});
  const graph = {root: initial, objects: new Map(f.objects)};
  function edit(change: string, parent: LocalChange | undefined, path: string, source: string, next: string): LocalChange {
    return prepareSourceChange({change, tree: "tr_publication", graph: parent ? decodeTreeSnapshotJSON(parent.candidate) : graph,
      basis: parent ? {kind: "authored", change: parent.change} : {kind: "accepted", root: initial, update: "up_initial"}, sourcePath: path,
      intent: {basis: {tree: "tr_publication", path, revision: change, source}, edits: [{offset: 0, length: source.length, replacement: next}], source: next}});
  }
  const a = edit("a", undefined, "/a.md", "A", "AA"), b = edit("b", a, "/b.md", "B", "BB"), c = edit("c", a, "/c.md", "C", "CC");
  const d = edit("d", c, "/c.md", "CC", "CCC");
  const records = new Map([a,b,c,d].map(record => [record.change, record]));
  const group = publication([a,b], [])!, original = structuredClone([...records.values()]);
  const continuations = branchPublications(group, 1, [c,d], records)!;
  expect(continuations).toHaveLength(2);
  expect(continuations[0]!.update.trace![0]!.before).toBe(group.update.candidate);
  expect(continuations[1]!.update.trace![0]!.before).toBe(continuations[0]!.update.candidate);
  expect([...records.values()]).toEqual(original);
  expect(branchPublications(JSON.parse(JSON.stringify(group)), 1, [c,d], records)).toEqual(continuations);
  for (const record of records.values()) for (const snapshot of [record.graph, record.candidate]) for (const [hash, bytes] of decodeTreeSnapshotJSON(snapshot).objects) f.objects.set(hash, bytes);
  for (const update of continuations.map(value => value.update)) for (const object of update.objects) f.objects.set(object.hash, decodeBase64(object.bytes));
  const request = f.request(initial, group.update.candidate, [], group.update.change);
  request.incoming.trace = group.update.trace!;
  let accepted = await f.run(request);
  for (const continuation of continuations) {
    const next = f.request(accepted.result, continuation.update.candidate, [], continuation.update.change);
    next.incoming.trace = continuation.update.trace!;
    accepted = await f.run(next);
    expect(accepted.decisions).toEqual([]);
  }
  expect(f.content(accepted.result.object, "a.md")).toBe("AA");
  expect(f.content(accepted.result.object, "b.md")).toBe("BB");
  expect(f.content(accepted.result.object, "c.md")).toBe("CCC");
  // Matching bytes are insufficient: even a net-zero edit overlaps origins.
  const overlap = edit("overlap", a, "/b.md", "B", "B");
  expect(branchPublications(group, 1, [overlap], records)).toBeUndefined();
  const guarded = structuredClone(c); guarded.update.ifCurrent = "up_guard";
  expect(branchPublications(group, 1, [guarded], records)).toBeUndefined();
  const operationRef = structuredClone(c);
  (operationRef.update.trace![0]!.operations[0] as any).source.material = {kind: "operation", change: "a", operation: "edit-0-0"};
  expect(branchPublications(group, 1, [operationRef], records)).toBeUndefined();
});


test("fifty moves in a large document use compact accepted-base deltas, including a new accepted basis", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/move-publication-payload.json", import.meta.url), "utf8"));
  const source = fixture.selected + fixture.neighbor.repeat(fixture.moves) + "x".repeat(fixture.tailBytes);
  let current = source;
  const steps = Array.from({length: fixture.moves}, (_, i) => {
    const start = i * fixture.neighbor.length, end = start + fixture.selected.length;
    const moves: SourceMove[] = [{source: [start, end], anchor: [end, end + fixture.neighbor.length], side: "after"}];
    current = applySourceChange(current, [], moves);
    return {source: current, moves};
  });
  const local = records({name: "large move", source, steps, frames: 1, kinds: ["moveSource"]});
  for (const offset of [0, 1]) {
    const published = publication(local.slice(offset), [])!;
    const compact = compactTransport(published.update, local[offset]!.graph, local.at(-1)!.candidate);
    const updates = [compact];
    const oldUpdates = [published.update];
    const encoded = encodeAttempt("tr_publication", {root: local[offset]!.graph.root, update: "up_initial"}, {base: "up_initial", updates});
    const old = encodeAttempt("tr_publication", {root: local[offset]!.graph.root, update: "up_initial"}, {base: "up_initial", updates: oldUpdates});
    expect(encoded.requestDigests).toEqual(old.requestDigests);
    expect(decodeBase64(encoded.body).length).toBeLessThan(fixture.maximumRequestBytes);
    expect(decodeBase64(encoded.body).length).toBeLessThan(decodeBase64(old.body).length / 10);
    const basis = decodeTreeSnapshotJSON(local[offset]!.graph);
    const reconstructed = applyTransitionPayload(basis.objects, decodeCandidateUpdateJSON(compact));
    expect(reconstructed.get(compact.candidate)).toEqual(decodeTreeSnapshotJSON(local.at(-1)!.candidate).objects.get(compact.candidate));
    expect(compact.deltas.every(delta => basis.objects.has(delta.base))).toBe(true);
    console.log(`move payload (${offset ? "new accepted basis" : "whole burst"}): ${decodeBase64(old.body).length} -> ${decodeBase64(encoded.body).length} bytes`);
  }
});
