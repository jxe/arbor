import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTransitionPayload, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, updateRequestDigests, protocolEntryObject,
  ProtocolTransportError, ProtocolUnsupportedOperation, ProtocolUpdateConflict, type AcceptedUpdate, type CurrentTree, type TreeSnapshot,
  decodeUpdateRequestJSON, decodeTreeSnapshotJSON, type UpdateRequest, type UpdateResponse, type UpdateResult, type WireEncoding, encodeBase64, encodeUpdateRequestJSON, encodeTreeSnapshotJSON, encodeCandidateUpdateJSON } from "@ovst/protocol";
import { prepareSourceChange, type LocalChange, UpdateCoordinator, type UpdateTransport } from "@ovst/working-tree";
import { publication } from "../../packages/working-tree/src/publication.ts";
import { attemptRequest, type UpdateAttempt } from "../../packages/working-tree/src/control.ts";
import { ChangeLog, FileControlStore } from "@ovst/working-tree/node";
import { appendSource, editorView, MemoryWorkingTree, readSource } from "../support/memory-working-tree.ts";

/** Executes `tests/fixtures/update-runner.json` against the TypeScript runner, as `RunnerVectorTests` does for Swift. */
interface Expectation { phase?: string; requests?: number; lastElements?: number; repeatsPrefix?: boolean; sameBody?: boolean; sameDigests?: boolean; lastEncoding?: WireEncoding; pending?: number; document?: string }
interface Step { append?: string; sync?: boolean; transport?: boolean; restart?: boolean; restartWithJSONAttempt?: boolean; discardHeld?: boolean; expect?: Expectation }
interface Scenario { name: string; document: string; responses?: string[]; steps: Step[] }

const fixture = JSON.parse(await readFile(new URL("../fixtures/update-runner.json", import.meta.url), "utf8")) as { scenarios: Scenario[] };
const TREE = "tr_runner_vectors";

function snapshot(markdown: string): TreeSnapshot {
  const file = new TextEncoder().encode(markdown), fileHash = hashObject(file);
  const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "note.md", file: fileHash }] });
  return { root: hashObject(directory), objects: new Map([[fileHash, file], [hashObject(directory), directory]]) };
}

/** A scripted host: accepts every element as submitted and keeps receipts so an exact retry returns them, or refuses, fails, or loses the response. */
class VectorHost implements UpdateTransport {
  readonly requests: UpdateRequest[] = [];
  readonly digests: string[][] = [];
  readonly encodings: Array<WireEncoding | undefined> = [];
  private readonly objects = new Map<string, Uint8Array>();
  private readonly receipts = new Map<string, UpdateResult>();
  private root: string;
  private update = "up_initial";
  private accepted = 0;
  constructor(initial: TreeSnapshot, private readonly script: string[]) {
    this.root = initial.root;
    for (const [hash, bytes] of initial.objects) this.objects.set(hash, bytes);
  }

  async submitUpdates(tree: string, request: UpdateRequest, options: { encoding?: WireEncoding } = {}): Promise<UpdateResponse> {
    this.requests.push(request);
    this.encodings.push(options.encoding);
    const digests = updateRequestDigests(tree, request);
    this.digests.push(digests);
    const action = this.script.shift() ?? "accept";
    if (action === "fail") throw new ProtocolTransportError("connection lost", undefined);
    if (action === "reject") {
      const current = this.head(this.update, this.root, null);
      throw new ProtocolUpdateConflict({ error: "conflict", message: "refused", retryable: false, details: { kind: "server-update", completed: [], failedIndex: 0,
        current, conflicts: [] } });
    }
    if (action === "unsupported") throw new ProtocolUnsupportedOperation({ error: "unsupported-operation" as never, message: "moveSource", retryable: false });
    const results: UpdateResult[] = [];
    for (const [index, element] of request.updates.entries()) {
      const complete = applyTransitionPayload(this.objects, element);
      for (const [hash, bytes] of complete) this.objects.set(hash, bytes);
      this.reachable(element.candidate);
      const receipt = this.receipts.get(digests[index]!);
      if (receipt) { results.push(receipt); continue; }
      const update = this.head(`up_${++this.accepted}`, element.candidate, { id: this.update, root: this.root });
      const result: UpdateResult = { outcome: "accepted", update, requestDigest: digests[index]! as never };
      this.receipts.set(digests[index]!, result);
      results.push(result);
      this.root = element.candidate;
      this.update = update.id;
    }
    if (action === "acceptThenFail") throw new ProtocolTransportError("response lost", undefined);
    return { results, head: { update: this.update, root: this.root as never, conflicted: false, observedThrough: this.update } };
  }

  async descriptor(tree: string): Promise<CurrentTree> {
    return { tree: { id: tree, kind: "ordinary", access: "write", canonical: null, root: this.root, update: this.update, conflicted: false } as never, observedThrough: this.update };
  }

  async object(_tree: string, hash: string): Promise<Uint8Array> {
    const bytes = this.objects.get(hash);
    if (!bytes) throw new Error(`Host has no ${hash}`);
    return bytes;
  }

  private head(id: string, root: string, previous: AcceptedUpdate["previous"]): AcceptedUpdate {
    return { id, tree: TREE, root: root as never, previous: previous as never, acceptedAt: 1_800_000_000_000, subject: null, conflicted: false };
  }

  private reachable(root: string): void {
    const pending = [{ hash: root, kind: "directory" as "file" | "directory" }];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const bytes = this.objects.get(next.hash);
      if (!bytes) throw new Error(`Candidate object ${next.hash} is missing`);
      if (next.kind === "directory") for (const entry of decodeProtocolDirectory(bytes).entries) {
        const child = protocolEntryObject(entry);
        if (child) pending.push(child);
      }
    }
  }
}

for (const scenario of fixture.scenarios) test(`runner vector: ${scenario.name}`, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-runner-vector-"));
  const initial = snapshot(scenario.document);
  const host = new VectorHost(initial, [...(scenario.responses ?? [])]);
  const working = new MemoryWorkingTree({ base: { root: initial.root, update: "up_initial", cursor: "up_initial" }, snapshot: initial });
  const log = new ChangeLog(TREE, stateRoot);
  const open = () => new UpdateCoordinator(TREE, log, new FileControlStore(stateRoot), host, working,
    { publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000 });
  let coordinator = open();
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${scenario.name} / step ${index + 1}`;
      if (step.append !== undefined) {
        const text = step.append;
        await appendSource(coordinator, log, working, "/note.md", source => ({ offset: new TextEncoder().encode(source).length, length: 0, replacement: text }));
      }
      if (step.sync) await coordinator.syncOnce();
      if (step.transport !== undefined) await coordinator.setTransportAvailable(step.transport);
      if (step.restart) { coordinator.close(); coordinator = open(); }
      if (step.restartWithJSONAttempt) {
        coordinator.close();
        await rewriteAttemptAsJSON(new FileControlStore(stateRoot).path);
        coordinator = open();
      }
      if (step.discardHeld) await coordinator.discardHeldChanges();
      const expected = step.expect;
      if (!expected) continue;
      if (expected.phase) {
        await coordinator.start();
        expect(coordinator.state.kind, label).toBe(expected.phase as never);
      }
      if (expected.requests !== undefined) expect(host.requests.length, label).toBe(expected.requests);
      if (expected.lastElements !== undefined) expect(host.requests.at(-1)!.updates.length, label).toBe(expected.lastElements);
      if (expected.repeatsPrefix) {
        const previous = host.digests.at(-2)!, last = host.digests.at(-1)!;
        expect(last.length, label).toBeGreaterThan(previous.length);
        expect(last.slice(0, previous.length), label).toEqual(previous);
      }
      if (expected.sameBody || expected.sameDigests) expect(host.digests.at(-1), label).toEqual(host.digests.at(-2));
      if (expected.lastEncoding) expect(host.encodings.at(-1), label).toBe(expected.lastEncoding);
      if (expected.pending !== undefined) expect((await coordinator.pendingChanges()).length, label).toBe(expected.pending);
      if (expected.document !== undefined) expect(readSource((await editorView(coordinator, working)).graph, "/note.md"), label).toBe(expected.document);
    }
  } finally {
    coordinator.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

/** Rewrite a persisted attempt as a client wrote it before bodies could be CBOR: base64 of the JSON text, no content type. */
async function rewriteAttemptAsJSON(path: string): Promise<void> {
  const control = JSON.parse(await readFile(path, "utf8")) as { attempt: UpdateAttempt };
  const { contentType: _contentType, ...attempt } = control.attempt;
  const body = encodeBase64(new TextEncoder().encode(JSON.stringify(encodeUpdateRequestJSON(attemptRequest(control.attempt)))));
  await writeFile(path, JSON.stringify({ ...control, attempt: { ...attempt, body } }));
}

/** Holds the first POST until released, as `FirstRequestGate` does for Swift. */
class GatedHost extends VectorHost {
  sent = 0;
  held?: UpdateRequest;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  open(): void { this.release(); }
  override async submitUpdates(tree: string, request: UpdateRequest, options: { encoding?: WireEncoding } = {}): Promise<UpdateResponse> {
    this.sent += 1;
    if (this.sent === 1) {
      this.held = request;
      await this.gate;
    }
    return super.submitUpdates(tree, request, options);
  }
}

for (const lost of [false, true]) test(`watch acceptance reuses the in-flight POST${lost ? ", replaying only when its response is lost" : ""}`, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-watch-before-post-"));
  const initial = snapshot("# Note\n\nBase\n");
  const host = new GatedHost(initial, [lost ? "acceptThenFail" : "accept"]);
  const working = new MemoryWorkingTree({ base: { root: initial.root, update: "up_initial", cursor: "up_initial" }, snapshot: initial });
  const log = new ChangeLog(TREE, stateRoot);
  const coordinator = new UpdateCoordinator(TREE, log, new FileControlStore(stateRoot), host, working,
    { publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000 });
  try {
    await appendSource(coordinator, log, working, "/note.md", (source) => ({ offset: new TextEncoder().encode(source).length, length: 0, replacement: "Local\n" }));
    const syncing = coordinator.syncOnce().catch(() => {});
    while (!host.held) await Bun.sleep(5);
    // The host has not answered; its watch already reports the request accepted.
    const candidate = host.held.updates.at(-1)!.candidate;
    const observation = coordinator.observe({
      kind: "tree.update", cursor: "up_1" as never, tree: TREE,
      access: "write", canonical: null,
      transition: {
        update: { id: "up_1", tree: TREE, root: candidate, previous: { id: "up_0", root: candidate }, acceptedAt: 1, subject: null, conflicted: false },
        objects: [], deltas: [], requestDigest: updateRequestDigests(TREE, host.held).at(-1) as never,
      },
    });
    while (coordinator.state.kind !== "accepted-pending-apply") await Bun.sleep(5);
    await Bun.sleep(50);
    expect(host.sent).toBe(1);
    host.open();
    const presentation = await observation;
    await syncing;
    expect(presentation.state).toBe("current");
    expect(host.sent).toBe(lost ? 2 : 1);
    expect(host.requests.at(-1)).toEqual(host.held);
    expect(await coordinator.pendingChanges()).toEqual([]);
    expect((await working.accepted())?.root).toBe(candidate);
  } finally {
    coordinator.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test.each(["resolution", "guard", "ordinary"] as const)("unchanged-root %s preserves its publication semantics", async kind => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-unchanged-resolution-"));
  const initial = snapshot("Already reconciled\r\n"), host = new VectorHost(initial, []);
  const working = new MemoryWorkingTree({ base: { root: initial.root, update: "up_initial" }, snapshot: initial });
  const log = new ChangeLog(TREE, stateRoot);
  const coordinator = new UpdateCoordinator(TREE, log, new FileControlStore(stateRoot), host, working,
    { publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000 });
  try {
    const graph = encodeTreeSnapshotJSON(initial);
    const resolves = kind === "resolution" ? [{ state: "up_initial", conflict: "choice", alternatives: ["left", "right"] }] : [];
    await log.retain({ change: "keep-current", tree: TREE, basis: { kind: "accepted", root: initial.root, update: "up_initial" },
      graph, candidate: graph, sourcePath: null, document: null,
      update: encodeCandidateUpdateJSON({ change: "keep-current", candidate: initial.root, trace: null, resolves,
        ...(kind === "guard" ? { ifCurrent: "up_initial" } : {}), objects: [], deltas: [] }) });
    await coordinator.noteLocalChange();
    await coordinator.syncOnce();
    expect(host.requests).toHaveLength(kind === "ordinary" ? 0 : 1);
    expect(working.base?.root).toBe(initial.root);
    expect(working.base?.update).toBe(kind === "ordinary" ? "up_initial" : "up_1");
    if (kind !== "ordinary") {
      expect(host.requests[0]!.updates[0]!.resolves).toEqual(resolves);
      expect(host.requests[0]!.updates[0]!.ifCurrent).toBe(kind === "guard" ? "up_initial" : undefined);
    }
    expect(await coordinator.pendingChanges()).toHaveLength(0);
  } finally { coordinator.close(); await rm(stateRoot, { recursive: true, force: true }); }
});


for (const frozen of [false, true]) test(`branched publication ${frozen ? "recovers a frozen interior basis after restart" : "ends batching at a known branch point"}`, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-branch-batch-"));
  const objects = new Map<string, Uint8Array>();
  const entries = ["a", "b", "c"].map(name => { const bytes = new TextEncoder().encode(name), file = hashObject(bytes); objects.set(file, bytes); return {name: name + ".md", file}; });
  const bytes = encodeProtocolDirectory({type: "directory", entries}), root = hashObject(bytes); objects.set(root, bytes);
  const initial = {root, objects}, host = new VectorHost(initial, frozen ? ["accept", "acceptThenFail"] : []);
  const working = new MemoryWorkingTree({base: {root, update: "up_initial"}, snapshot: initial});
  const log = new ChangeLog(TREE, stateRoot), store = new FileControlStore(stateRoot);
  function edit(change: string, parent: LocalChange | undefined, path: string, source: string): LocalChange {
    return prepareSourceChange({change, tree: TREE, basis: parent ? {kind: "authored", change: parent.change} : {kind: "accepted", root, update: "up_initial"},
      graph: parent ? decodeTreeSnapshotJSON(parent.candidate) : initial, sourcePath: path,
      intent: {basis: {tree: TREE, path, revision: change, source}, edits: [{offset: 0, length: 1, replacement: source.toUpperCase()}], source: source.toUpperCase()}});
  }
  const a = edit("a", undefined, "/a.md", "a"), b = edit("b", a, "/b.md", "b"), c = edit("c", a, "/c.md", "c");
  for (const record of [a,b,c]) await log.retain(record);
  if (frozen) {
    await log.compact(new Set([a.change, b.change]), false, [[a.change, b.change]]);
    expect((await log.retained()).map(record => record.change)).toEqual(["a", "b", "c"]);
    const group = publication([a,b], [])!;
    const response = await host.submitUpdates(TREE, decodeUpdateRequestJSON({base: "up_initial", updates: [group.update]}));
    await working.install({root: group.update.candidate, update: response.head.update}, {root: group.update.candidate, object: hash => host.object(TREE, hash), snapshot: async () => decodeTreeSnapshotJSON(b.candidate)});
    await store.write({schema: 5, settled: [a.change,b.change], publications: [group]}, "current");
  }
  let coordinator = new UpdateCoordinator(TREE, log, store, host, working, {publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000});
  try {
    await coordinator.syncOnce();
    if (frozen) {
      const attempt = (await store.load()).attempt!;
      expect(attempt).toBeDefined();
      coordinator.close();
      coordinator = new UpdateCoordinator(TREE, log, store, host, working, {publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000});
      await coordinator.syncOnce();
      expect(host.digests.at(-1)).toEqual(attempt.requestDigests);
    }
    expect((await coordinator.pendingChanges()).length).toBe(0);
    const last = host.requests.at(-1)!;
    if (frozen) {
      expect(last.updates[0]!.change).toBe(host.requests[0]!.updates[0]!.change);
      expect(host.digests.at(-1)![0]).toBe(host.digests[0]![0]);
      expect(last.updates[1]!.change.startsWith("continuation-")).toBe(true);
      expect(readSource(working.graph(), "/b.md")).toBe("B");
      expect(readSource(working.graph(), "/c.md")).toBe("C");
    } else expect(host.requests[0]!.updates.map(update => update.change)).toEqual(["a", "b"]);
    expect(readSource(working.graph(), "/a.md")).toBe("A");
  } finally { coordinator.close(); await rm(stateRoot, {recursive: true, force: true}); }
});


test("source activity holds automatic publication across slow admission and overlapping editors", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-active-source-"));
  const initial = snapshot("Base\n"), host = new VectorHost(initial, []);
  const working = new MemoryWorkingTree({base: {root: initial.root, update: "up_initial"}, snapshot: initial});
  const log = new ChangeLog(TREE, stateRoot);
  const coordinator = new UpdateCoordinator(TREE, log, new FileControlStore(stateRoot), host, working, {publicationDelayMs: 20});
  try {
    await coordinator.sourceActivity("editor-one", true);
    await appendSource(coordinator, log, working, "/note.md", source => ({offset: source.length, length: 0, replacement: "One\n"}));
    await Bun.sleep(60);
    expect(host.requests).toHaveLength(0);
    await coordinator.sourceActivity("editor-two", true);
    await coordinator.sourceActivity("editor-one", false);
    await appendSource(coordinator, log, working, "/note.md", source => ({offset: source.length, length: 0, replacement: "Two\n"}));
    await Bun.sleep(60);
    expect(host.requests).toHaveLength(0);
    await coordinator.sourceActivity("editor-two", false);
    await Bun.sleep(5);
    expect(host.requests).toHaveLength(0);
    const deadline = Date.now() + 2000;
    while (coordinator.state.kind !== "current" && Date.now() < deadline) await Bun.sleep(5);
    expect(coordinator.state.kind).toBe("current");
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]!.updates).toHaveLength(1);
  } finally { coordinator.close(); await rm(stateRoot, {recursive: true, force: true}); }
});


test("a successor to an in-flight edit sends deltas against its settled candidate", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-chained-deltas-"));
  const initial = snapshot("a".repeat(70_000));
  const host = new GatedHost(initial, []);
  const working = new MemoryWorkingTree({base: {root: initial.root, update: "up_initial"}, snapshot: initial});
  const log = new ChangeLog(TREE, stateRoot);
  const coordinator = new UpdateCoordinator(TREE, log, new FileControlStore(stateRoot), host, working,
    {publicationDelayMs: 3_600_000, publicationMaxDelayMs: 3_600_000});
  try {
    await appendSource(coordinator, log, working, "/note.md", () => ({offset: 0, length: 1, replacement: "X"}));
    const syncing = coordinator.syncOnce();
    while (!host.held) await Bun.sleep(5);
    await appendSource(coordinator, log, working, "/note.md", () => ({offset: 1, length: 1, replacement: "Y"}));
    host.open();
    await syncing;
    await coordinator.syncOnce();
    const request = host.requests.at(-1)!;
    expect(request.updates).toHaveLength(2);
    expect(request.updates[0]!.objects).toEqual([]);
    expect(request.updates[0]!.deltas).toEqual([]);
    expect(request.updates[1]!.deltas.length).toBeGreaterThan(0);
    expect(JSON.stringify(encodeUpdateRequestJSON(request)).length).toBeLessThan(5000);
    expect(host.digests.at(-1)![0]).toBe(host.digests[0]![0]);
    expect(await coordinator.pendingChanges()).toEqual([]);
  } finally { host.open(); coordinator.close(); await rm(stateRoot, {recursive: true, force: true}); }
});
