import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTransitionPayload, decodeWireDirectory, encodeWireDirectory, hashObject, updateRequestDigests, wireEntryObject,
  WireTransportError, WireUnsupportedOperation, WireUpdateConflict, type AcceptedUpdate, type CurrentTree, type TreeSnapshot,
  type UpdateRequest, type UpdateResponse, type UpdateResult } from "@overstory/protocol";
import { UpdateCoordinator, type UpdateTransport } from "@overstory/working-tree";
import { ChangeLog, FileControlStore } from "@overstory/working-tree/node";
import { appendSource, editorView, MemoryWorkingTree, readSource } from "../support/memory-working-tree.ts";

/** Executes `tests/fixtures/update-runner.json` against the TypeScript runner, as `RunnerVectorTests` does for Swift. */
interface Expectation { phase?: string; requests?: number; lastElements?: number; repeatsPrefix?: boolean; sameBody?: boolean; pending?: number; document?: string }
interface Step { append?: string; sync?: boolean; transport?: boolean; restart?: boolean; discardHeld?: boolean; expect?: Expectation }
interface Scenario { name: string; document: string; responses?: string[]; steps: Step[] }

const fixture = JSON.parse(await readFile(new URL("../fixtures/update-runner.json", import.meta.url), "utf8")) as { scenarios: Scenario[] };
const TREE = "tr_runner_vectors";

function snapshot(markdown: string): TreeSnapshot {
  const file = new TextEncoder().encode(markdown), fileHash = hashObject(file);
  const directory = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file: fileHash }] });
  return { root: hashObject(directory), objects: new Map([[fileHash, file], [hashObject(directory), directory]]) };
}

/** A scripted host: accepts every element as submitted and keeps receipts so an exact retry returns them, or refuses, fails, or loses the response. */
class VectorHost implements UpdateTransport {
  readonly requests: UpdateRequest[] = [];
  readonly digests: string[][] = [];
  private readonly objects = new Map<string, Uint8Array>();
  private readonly receipts = new Map<string, UpdateResult>();
  private root: string;
  private update = "up_initial";
  private accepted = 0;
  constructor(initial: TreeSnapshot, private readonly script: string[]) {
    this.root = initial.root;
    for (const [hash, bytes] of initial.objects) this.objects.set(hash, bytes);
  }

  async submitUpdates(tree: string, request: UpdateRequest): Promise<UpdateResponse> {
    this.requests.push(request);
    const digests = updateRequestDigests(tree, request);
    this.digests.push(digests);
    const action = this.script.shift() ?? "accept";
    if (action === "fail") throw new WireTransportError("connection lost", undefined);
    if (action === "reject") {
      const current = this.head(this.update, this.root, null);
      throw new WireUpdateConflict({ error: "conflict", message: "refused", retryable: false, details: { kind: "server-update", completed: [], failedIndex: 0,
        current, base: this.root as never, candidate: request.updates.at(-1)!.candidate as never, draft: { root: this.root as never, objects: [], deltas: [] }, conflicts: [] } });
    }
    if (action === "unsupported") throw new WireUnsupportedOperation({ error: "unsupported-operation" as never, message: "moveSource", retryable: false });
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
    if (action === "acceptThenFail") throw new WireTransportError("response lost", undefined);
    return { results, observedThrough: this.update };
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
      if (next.kind === "directory") for (const entry of decodeWireDirectory(bytes).entries) {
        const child = wireEntryObject(entry);
        if (child) pending.push(child);
      }
    }
  }
}

for (const scenario of fixture.scenarios) test(`runner vector: ${scenario.name}`, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "arbor-runner-vector-"));
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
      if (expected.sameBody) expect(host.digests.at(-1), label).toEqual(host.digests.at(-2));
      if (expected.pending !== undefined) expect((await coordinator.pendingChanges()).length, label).toBe(expected.pending);
      if (expected.document !== undefined) expect(readSource((await editorView(coordinator, working)).graph, "/note.md"), label).toBe(expected.document);
    }
  } finally {
    coordinator.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
