import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceAdmissionPublisher, SourceAdmissionQueue, prepareSourceAdmission } from "@overstory/client";
import { decodeTreeSnapshotJSON, encodeWireDirectory, hashObject, updateRequestDigests,
  type CurrentTree, type TreeSnapshot, type UpdateRequest, type UpdateResponse } from "@overstory/protocol";

function graph(source: string): TreeSnapshot {
  const bytes = Buffer.from(source), file = hashObject(bytes);
  const directory = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file }] });
  return { root: hashObject(directory), objects: new Map([[file, bytes], [hashObject(directory), directory]]) };
}
async function scenario(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "source-publisher-"));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function first() {
  const initial = graph("base");
  return prepareSourceAdmission({ tree: "tree", change: "a", basis: { kind: "accepted", root: initial.root, update: "r1" },
    graph: initial, sourcePath: "/note.md", intent: { basis: { tree: "tree", path: "/note", revision: "r1", source: "base" },
      edits: [{ offset: 0, length: 4, replacement: "mine" }], source: "mine" } });
}
function transport() {
  const peer = graph("peer"), requests: UpdateRequest[] = [];
  const current = { tree: { id: "tree", root: peer.root, update: "current", conflicted: true }, observedThrough: "cursor" } as CurrentTree;
  return { peer, current, requests,
    async submitUpdates(tree: string, request: UpdateRequest): Promise<UpdateResponse> {
      requests.push(structuredClone(request));
      return { observedThrough: "old-cursor", results: updateRequestDigests(tree, request).map((requestDigest, index) => ({
        outcome: "accepted", requestDigest, update: { id: `receipt-${index}`, tree, root: peer.root, previous: null,
          conflicted: true, acceptedAt: 1, subject: null } })) };
    },
    async descriptor() { return current; },
    async snapshot() { return peer; },
  };
}

test("restart after failed installation retries original request and settles accepted ambiguity", async () => scenario(async root => {
  const queue = new SourceAdmissionQueue("tree", root), record = first(), wire = transport();
  await queue.retain(record);
  const publisher = new SourceAdmissionPublisher(queue, wire, async () => { throw new Error("disk unavailable"); });
  await expect(publisher.publishNext()).rejects.toThrow("disk unavailable");
  expect(await publisher.pending()).toEqual(["a"]);
  const installed: string[] = [];
  const reopened = new SourceAdmissionPublisher(new SourceAdmissionQueue("tree", root), wire, async (current, snapshot) => {
    expect(current.tree.conflicted).toBe(true);
    expect(snapshot.root).toBe(wire.peer.root);
    installed.push(current.tree.update);
  });
  expect(await reopened.publishNext()).toBe(true);
  expect(wire.requests[1]).toEqual(wire.requests[0]);
  expect(installed).toEqual(["current"]);
  expect(await reopened.publishNext()).toBe(false);
}));

test("hidden successor repeats immutable predecessor after peer projection is installed", async () => scenario(async root => {
  const queue = new SourceAdmissionQueue("tree", root), a = first(), wire = transport();
  await queue.retain(a);
  let admit = true;
  const publisher = new SourceAdmissionPublisher(queue, wire, async () => {
    if (!admit) return;
    admit = false;
    await queue.retain(prepareSourceAdmission({ tree: "tree", change: "b", basis: { kind: "authored", change: "a" },
      graph: decodeTreeSnapshotJSON(a.candidate), sourcePath: "/note.md",
      intent: { basis: { tree: "tree", path: "/note", revision: "local-a", source: "mine" },
        edits: [{ offset: 4, length: 0, replacement: " again" }], source: "mine again" } }));
  });
  await publisher.publishNext();
  expect(await publisher.pending()).toEqual(["b"]);
  await publisher.publishNext();
  expect(wire.requests[1]!.base).toBe("r1");
  expect(wire.requests[1]!.updates.map(update => update.change)).toEqual(["a", "b"]);
  expect(wire.requests[1]!.updates[0]!.objects).toEqual([]);
  expect(wire.requests[1]!.updates[0]!.deltas).toEqual([]);
  expect(updateRequestDigests("tree", wire.requests[1]!)[0]).toBe(updateRequestDigests("tree", wire.requests[0]!)[0]);
  expect(await publisher.pending()).toEqual([]);
}));

test("bad receipts, old rejections and corrupt settlement never discard retained intent", async () => scenario(async root => {
  const queue = new SourceAdmissionQueue("tree", root), wire = transport();
  await queue.retain(first());
  let installs = 0;
  const publisher = new SourceAdmissionPublisher(queue, { ...wire, async submitUpdates() { throw new Error("legacy 409"); } }, async () => { installs++; });
  await expect(publisher.publishNext()).rejects.toThrow("legacy 409");
  const bad = new SourceAdmissionPublisher(queue, { ...wire, async submitUpdates() { return { results: [], observedThrough: "cursor" }; } }, async () => { installs++; });
  await expect(bad.publishNext()).rejects.toThrow("receipt");
  expect(installs).toBe(0);
  expect(await bad.pending()).toEqual(["a"]);
  await writeFile(bad.path, '{"tree":"different","changes":["a"]}');
  await expect(bad.publishNext()).rejects.toThrow("settlements");
  expect((await queue.retained()).map(record => record.change)).toEqual(["a"]);
}));

test("captured source admits offline after a watch-equivalent advance without relabeling its basis", async () => scenario(async root => {
  const { SourceDocumentSession } = await import("@overstory/client");
  const queue = new SourceAdmissionQueue("tree", root), wire = transport();
  let offline = false;
  const initial = graph("base");
  const reader = { async descriptor() { return { ...wire.current, tree: { ...wire.current.tree, update: "r1", root: initial.root as CurrentTree["tree"]["root"] } }; },
    async snapshot() { if (offline) throw new Error("offline"); return initial; } };
  const publisher = new SourceAdmissionPublisher(queue, wire, async () => {});
  const session = new SourceDocumentSession(queue, publisher, reader, "/note", "/note.md");
  const captured = await session.snapshot();
  offline = true;
  const intent = { basis: captured, edits: [{ offset: 0, length: 4, replacement: "offline" }], source: "offline" };
  const acknowledged = await session.admit(intent);
  expect(acknowledged.source).toBe("offline");
  expect((await queue.retained())[0]!.basis).toEqual({ kind: "accepted", root: initial.root, update: "r1" });
  expect(await session.admit(intent)).toEqual(acknowledged);
  expect(await queue.retained()).toHaveLength(1);
}));

test("publication selection agrees with the shared client-machine vectors", async () => {
  const { publicationTip } = await import("../../packages/client/src/update-machine.ts");
  const fixture = await Bun.file(new URL("../fixtures/source-publication.json", import.meta.url)).json();
  for (const scenario of fixture.scenarios)
    expect(publicationTip(scenario.records, new Set<string>(scenario.accepted)) ?? null).toBe(scenario.tip);
});

function successor(parent: ReturnType<typeof first>, change: string, source: string, next: string) {
  return prepareSourceAdmission({ tree: "tree", change, basis: { kind: "authored", change: parent.change },
    graph: decodeTreeSnapshotJSON(parent.candidate), sourcePath: "/note.md",
    intent: { basis: { tree: "tree", path: "/note", revision: parent.change, source },
      edits: [{ offset: source.length, length: 0, replacement: next.slice(source.length) }], source: next } });
}

test("a queued chain publishes together; work admitted after an uncertain attempt waits for its exact retry", async () => scenario(async root => {
  const queue = new SourceAdmissionQueue("tree", root), a = first(), wire = transport();
  const b = successor(a, "b", "mine", "mine b");
  const c = successor(b, "c", "mine b", "mine b c");
  await queue.retain([a, b, c]);
  const publisher = new SourceAdmissionPublisher(queue, wire, async () => { throw Error("lost installation"); });
  await expect(publisher.publishNext()).rejects.toThrow("lost installation");
  expect(wire.requests[0]!.updates.map(u => u.change)).toEqual(["a", "b", "c"]);
  const d = successor(c, "d", "mine b c", "mine b c d");
  await queue.retain(d);
  const reopened = new SourceAdmissionPublisher(new SourceAdmissionQueue("tree", root), wire, async () => {});
  await reopened.publishNext();
  expect(wire.requests[1]).toEqual(wire.requests[0]);
  expect(await reopened.pending()).toEqual(["d"]);
  await reopened.publishNext();
  expect(wire.requests[2]!.updates.map(u => u.change)).toEqual(["a", "b", "c", "d"]);
  expect(await reopened.pending()).toEqual([]);
}));
