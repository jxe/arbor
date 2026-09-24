import { installAccountHome } from "../helpers/account-home.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon, serveArborSync } from "@overstory/arborsync";
import { ArborSyncRESTClient } from "@overstory/arborsync-client";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "../../packages/canopyd/src/updates/store.ts";
import { serveCanopy } from "@overstory/canopyd";
import { CanopyAccountStore, generateArborID, sha256, type CandidateUpdate, compareWireNames, decodeCandidateUpdateJSON, decodeWireDirectory, encodeWireDirectory, hashObject, WireClient } from "@overstory/protocol";
import { readAccountConfigGraphV2, snapshotAccountConfigV2 } from "../../packages/canopyd/src/account-policy-v2.ts";
import {
  appendPendingTreeSuccessor,
  pendingFromSnapshot,
  pendingTreeUpdate,
  savePendingTreeUpdate,
  treeConflict,
  updatesFromPending,
} from "@overstory/client";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";

const token = "self-sync-owner";
let sandbox: string;
let hostState: string;
let host: Awaited<ReturnType<typeof serveCanopy>>;
let hostPort: number;
let stateA: string;
let stateB: string;
let treeA: string;
let treeB: string;
let bootstrapB: string;
let tree: string;
let deviceA: string;
let deviceB: string;
const tokenB = "self-sync-peer-credential";

async function readAccepted(client: WireClient, treeID: string) {
  const descriptor = await client.descriptor(treeID);
  const snapshot = await client.snapshot(treeID, descriptor.tree.root);
  return { descriptor, snapshot };
}

async function launch(
  state: string,
  path: string,
  options: { faultInjector?: (stage: string) => void | Promise<void> } = {},
) {
  process.env.ARBOR_DATA_HOME = state;
  // A long fallback interval proves that live Wire watches, not polling,
  // drive every cross-daemon expectation below.
  const running = await serveArborSync(path, {
    port: 0,
    syncIntervalMs: 60_000,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  const client = new ArborSyncRESTClient({ baseURL: running.url, retryDelay: async () => {} });
  const close = async () => {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  };
  return { running, client, close };
}

async function waitFor(read: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for self-sync");
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-self-sync-"));
  hostState = join(sandbox, "host");
  stateA = join(sandbox, "home-a");
  stateB = join(sandbox, "home-b");
  treeA = join(sandbox, "tree-a");
  treeB = join(sandbox, "tree-b");
  bootstrapB = join(sandbox, "bootstrap-b");
  await Promise.all([hostState, stateA, stateB, treeA, bootstrapB].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(treeA, "_index.md"), "# Tree A\n");
  await writeFile(join(treeA, "note.md"), `# Common\n${"shared text\n".repeat(1_024)}`);
  host = await serveCanopy({
    dataRoot: hostState,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  hostPort = host.server.port!;

  const owner = new WireClient(host.url, token);
  const initialAccount = await owner.account();
  let configuration = await readAccepted(owner, initialAccount.account.configuration.id);
  let graph = readAccountConfigGraphV2({
    root: configuration.snapshot.root,
    objects: configuration.snapshot.objects,
  }, initialAccount.account.configuration.id);
  deviceA = Object.values(graph.devices).find(device => device.administrator)!.id;
  tree = generateArborID("tr");
  const reserved = snapshotAccountConfigV2({
    account: graph.account,
    trees: {
      ...graph.trees,
      [tree]: { canonical: `${host.url}/~owner/self-sync`, access: [] },
    },
    devices: graph.devices,
  });
  await owner.submitUpdate(configuration.descriptor.tree.id, configuration.descriptor.tree.update, reserved);
  await owner.submitUpdate(tree, null, await resolveSnapshot(await snapshotDirectory(treeA)));

  deviceB = generateArborID("dv");
  const pairing = await owner.createPairing();
  await owner.claimPairing(pairing.id, pairing.secret, {
    id: deviceB,
    label: "Self-sync peer",
    credentialDigest: `sha256:${sha256(tokenB)}`,
  });
  configuration = await readAccepted(owner, initialAccount.account.configuration.id);
  graph = readAccountConfigGraphV2({
    root: configuration.snapshot.root,
    objects: configuration.snapshot.objects,
  }, initialAccount.account.configuration.id);
  await installAccountHome(stateA, owner, deviceA, token, { [treeA]: tree });
  await installAccountHome(stateB, new WireClient(host.url, tokenB), deviceB, tokenB, { [treeB]: tree });
});

afterAll(async () => {
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateA;
  const cleanup = await serveArborSync(treeA, { port: 0 });
  for (const account of await CanopyAccountStore.list()) await new CanopyAccountStore(account.configurationTree).remove();
  cleanup.server.stop(true);
  await cleanup.service[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateB;
  const peerCleanup = await serveArborSync(bootstrapB, { port: 0 });
  for (const account of await CanopyAccountStore.list()) await new CanopyAccountStore(account.configurationTree).remove();
  peerCleanup.server.stop(true);
  await peerCleanup.service[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});


test("pending semantic identity survives persistence and appending a snapshot successor", async () => {
  process.env.ARBOR_DATA_HOME = stateA;
  const snapshot = await resolveSnapshot(await snapshotDirectory(treeA));
  const pending = pendingFromSnapshot("up_basis", snapshot);
  pending.trace = [{ before: snapshot.root, after: pending.candidate, operations: [
    { kind: "editSource", key: "edit", source: { material: { kind: "basis", path: "/note.md", object: snapshot.root } }, text: "x" },
  ] }];
  const id = generateArborID("tr");
  await savePendingTreeUpdate(id, appendPendingTreeSuccessor(pending, snapshot));
  const restored = (await pendingTreeUpdate(id))!;
  expect(restored.change).toBe(pending.change);
  expect(restored.trace).toEqual(pending.trace);
  const updates = updatesFromPending(restored);
  expect(updates).toHaveLength(2);
  expect(updates[1]!.change).not.toBe(pending.change);
  expect(updates[1]!.trace).toBeNull();
  expect(decodeCandidateUpdateJSON(updates[0]).trace).toEqual(pending.trace);
});

test("old pending requests fail closed and remain byte-for-byte recoverable", async () => {
  process.env.ARBOR_DATA_HOME = stateA;
  const id = generateArborID("tr");
  const snapshot = await resolveSnapshot(await snapshotDirectory(treeA));
  const {resolves: _resolves,...candidate} = pendingFromSnapshot("up_old",snapshot);
  const original = JSON.stringify({pending:{...candidate,ifMatch:"modelHash"}});
  const path = join(stateA,".state","sync",`${Buffer.from(id).toString("base64url")}.json`);
  await mkdir(join(stateA,".state","sync"),{recursive:true});
  await writeFile(path,original);
  try {
    await expect(pendingTreeUpdate(id)).rejects.toThrow();
    expect(await readFile(path,"utf8")).toBe(original);
  } finally { await rm(path); }
});

describe("private self-sync", () => {
  test("places one TreeID in two isolated Arbor homes and pulls edits", async () => {
    const first = await launch(stateA, treeA);
    expect((await first.client.trees()).snapshot.some((descriptor) => descriptor.id === tree)).toBe(true);
    await first.close();

    const second = await launch(stateB, bootstrapB);
    await waitFor(() => readFile(join(treeB, "note.md"), "utf8").then(() => true).catch(() => false));
    expect(await readFile(join(treeB, "note.md"), "utf8")).toBe(await readFile(join(treeA, "note.md"), "utf8"));
    await second.close();

    // The folder is the daemon's only local source: an edit on disk becomes
    // one filesystem candidate on the next pass.
    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const historyBefore = host.canopy.acceptedUpdates(tree).length;
    const source = (await readFile(join(treeA, "note.md"), "utf8")).replace("Common", "From A");
    await writeFile(join(treeA, "note.md"), source);
    await author.running.service.synchronizeNow();
    await waitFor(async () => host.canopy.acceptedUpdates(tree).length === historyBefore + 1
      && (await author.running.service.trees.descriptors())
        .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    expect(host.canopy.acceptedUpdates(tree).at(-1)?.previous).not.toBeNull();
    await author.close();

    const reader = await launch(stateB, treeB);
    await waitFor(async () => (await readFile(join(treeB, "note.md"), "utf8")).includes("From A"));
    expect(await readFile(join(treeB, "note.md"), "utf8")).toBe(source);
    await reader.close();

    const fallback = await launch(stateA, treeA);
    await waitFor(async () => (await fallback.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    await writeFile(join(treeA, "note.md"), "# Complete-object fallback\n");
    await fallback.running.service.synchronizeNow();
    await waitFor(async () => host.canopy.acceptedUpdates(tree).length === historyBefore + 2);
    await fallback.close();
  }, 20_000);

  test("preserves both sides when devices diverge offline", async () => {
    const commonRef = host.canopy.get(tree)!.ref;
    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();

    // A daemon pass with Canopy unreachable retains the local head durably
    // instead of failing or waiting for the server.
    const offline = await launch(stateA, treeA);
    const offlineSource = (await readFile(join(treeA, "note.md"), "utf8")).replace("Complete-object", "Locally durable");
    await writeFile(join(treeA, "note.md"), offlineSource);
    await Promise.race([
      offline.running.service.synchronizeNow().catch(() => {}),
      Bun.sleep(5_000).then(() => { throw new Error("An offline pass waited for the unavailable server"); }),
    ]);
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(offlineSource);
    expect((await offline.running.service.trees.descriptors()).find((descriptor) => descriptor.id === tree)?.sync).toBe("offline");
    await offline.close();

    await writeFile(join(treeA, "note.md"), "# Offline A\n");
    await writeFile(join(treeB, "note.md"), "# Offline B\n");

    host = await serveCanopy({
      dataRoot: hostState,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });

    const first = await launch(stateA, treeA);
    await waitFor(async () => host.canopy.get(tree)?.ref !== commonRef);
    await first.close();

    const second = await launch(stateB, treeB);
    await waitFor(async () => {
      const source = await readFile(join(treeB, "note.md"), "utf8");
      return source.includes("Offline A") && source.includes("Offline B");
    });
    await second.close();

    const converging = await launch(stateA, treeA);
    await waitFor(async () => {
      const source = await readFile(join(treeA, "note.md"), "utf8");
      return source.includes("Offline A") && source.includes("Offline B");
    });
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(await readFile(join(treeB, "note.md"), "utf8"));
    await converging.close();
  });

  test("accepts binary alternatives, keeps filesystem publication live, and resolves through Canopy", async () => {
    const preparing = await launch(stateA, treeA);
    await writeFile(join(treeA, "sample.bin"), "common-binary");
    const beforeCommon = host.canopy.currentUpdate(tree)!.id;
    await waitFor(async () => host.canopy.currentUpdate(tree)!.id !== beforeCommon);
    await preparing.close();

    const receiving = await launch(stateB, treeB);
    await waitFor(async () => readFile(join(treeB, "sample.bin"), "utf8")
      .then((value) => value === "common-binary")
      .catch(() => false));
    await receiving.close();
    const historyBefore = host.canopy.acceptedUpdates(tree).length;

    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();
    await writeFile(join(treeA, "sample.bin"), "binary-from-a");
    await writeFile(join(treeB, "sample.bin"), "binary-from-b");
    host = await serveCanopy({
      dataRoot: hostState,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });

    const winner = await launch(stateA, treeA);
    await waitFor(async () => host.canopy.acceptedUpdates(tree).length === historyBefore + 1);
    await winner.close();

    const conflicted = await launch(stateB, treeB);
    try {
      await waitFor(async () => {
        const descriptor = (await conflicted.client.trees()).snapshot.find(candidate => candidate.id === tree);
        return descriptor?.sync === "idle" && descriptor.conflicted === true;
      });
      expect(await readFile(join(treeB, "sample.bin"), "utf8")).toBe("binary-from-a");
      expect(host.canopy.acceptedUpdates(tree)).toHaveLength(historyBefore + 2);
      expect(await pendingTreeUpdate(tree)).toBeUndefined();
      expect(await treeConflict(tree)).toBeUndefined();
    } finally { await conflicted.close(); }

    const restarted = await launch(stateB, treeB);
    try {
      await waitFor(async () => (await restarted.client.trees()).snapshot
        .some(candidate => candidate.id === tree && candidate.sync === "idle" && candidate.conflicted));
      await writeFile(join(treeB, "during-review.txt"), "Editing continues\n");
      await restarted.running.service.synchronizeNow();
      await waitFor(async () => {
        const current = await new WireClient(host.url, token).descriptor(tree);
        const snapshot = await new WireClient(host.url, token).snapshot(tree, current.tree.root);
        return decodeWireDirectory(snapshot.objects.get(snapshot.root)!).entries.some(e => e.name === "during-review.txt");
      });
      const owner = new WireClient(host.url, token), current = await readAccepted(owner, tree);
      const page = await owner.conflicts(tree, current.descriptor.tree.update, current.snapshot.root);
      expect(page.decisions).toHaveLength(1);
      const decision = page.decisions[0]!;
      expect(decision.alternatives.map(a => a.value)).toContainEqual({ file: hashObject(new TextEncoder().encode("binary-from-b")) });
      const bytes = new TextEncoder().encode("binary-from-b"), file = hashObject(bytes);
      const directory = decodeWireDirectory(current.snapshot.objects.get(current.snapshot.root)!);
      directory.entries = directory.entries.map(e => e.name === "sample.bin" ? { name: e.name, file } : e);
      const encoded = encodeWireDirectory(directory), root = hashObject(encoded);
      current.snapshot.objects.set(file, bytes); current.snapshot.objects.set(root, encoded);
      await owner.submitUpdates(tree, { base: current.descriptor.tree.update, updates: [{
        change: crypto.randomUUID(), candidate: root, trace: null, deltas: [],
        resolves: [{ state: page.state, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }],
        objects: [...current.snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      }] });
      await waitFor(async () => (await readFile(join(treeB, "sample.bin"), "utf8")) === "binary-from-b");
      expect(host.canopy.currentUpdate(tree)!.conflicted).toBe(false);
    } finally { await restarted.close(); }

    const follower = await launch(stateA, treeA);
    try {
      await waitFor(async () => (await readFile(join(treeA, "sample.bin"), "utf8")) === "binary-from-b");
      expect(await readFile(join(treeA, "during-review.txt"), "utf8")).toBe("Editing continues\n");
      expect(host.canopy.currentUpdate(tree)!.conflicted).toBe(false);
    } finally { await follower.close(); }
  }, 15_000);

  test("a live watch materializes a remote accepted update without polling", async () => {
    const reader = await launch(stateB, treeB);
    const idle = async () => (await reader.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle";
    // Establish the initial accepted base and its live Wire watch. After this
    // setup pass, the remote update below must arrive without another poll.
    await reader.running.service.synchronizeNow();
    await waitFor(idle);
    const observedThrough = (await reader.client.trees()).observedThrough;
    const abort = new AbortController();
    const syncInvalidation = (async () => {
      for await (const event of reader.client.observe(observedThrough, abort.signal)) {
        if (event.tree === tree && event.change.origin === "sync") return event;
      }
      throw new Error("The local observation stream ended before sync invalidation");
    })();

    // Another writer advances the tree directly on Canopy; the reader's only
    // way to learn about it within the timeout is its live watch.
    const owner = new WireClient(host.url, token);
    const current = await readAccepted(owner, tree);
    const rootObject = decodeWireDirectory(current.snapshot.objects.get(current.snapshot.root)!);
    if (rootObject.type !== "directory") throw new Error("Expected a directory root");
    const file = new TextEncoder().encode("delivered by watch\n");
    const nextRoot = encodeWireDirectory({
      type: "directory",
      entries: [...rootObject.entries, { name: "watched.txt", file: hashObject(file) }]
        .sort((left, right) => compareWireNames(left.name, right.name)),
    });
    const objects = current.snapshot.objects;
    objects.set(hashObject(file), file);
    objects.set(hashObject(nextRoot), nextRoot);
    const accepted = await owner.submitUpdate(
      tree,
      current.descriptor.tree.update,
      { root: hashObject(nextRoot), objects },
    );
    if (accepted.outcome !== "accepted") throw new Error(`Expected an accepted update, got ${accepted.outcome}`);

    await waitFor(() => readFile(join(treeB, "watched.txt"), "utf8")
      .then((value) => value === "delivered by watch\n")
      .catch(() => false));
    await waitFor(idle);
    expect(reader.running.service.trees.placementFor(tree)?.update).toBe(accepted.update.id);
    const invalidation = await Promise.race([
      syncInvalidation,
      Bun.sleep(2_000).then(() => { throw new Error("Timed out waiting for sync invalidation"); }),
    ]);
    expect(invalidation.change.ref.path).toBe("/");
    abort.abort();
    await reader.close();
  });

  test("A same-credential peer that resubmits and extends the daemon's pending chain is replayed, not merged", async () => {
    // Establish the local accepted base, then leave a durable two-element
    // pending chain whose final root is exactly what is on disk, as if two
    // filesystem generations were authored while Canopy was unreachable.
    const warm = await launch(stateA, treeA);
    await waitFor(async () => (await warm.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const base = warm.running.service.trees.placementFor(tree)?.update;
    await warm.close();
    if (!base) throw new Error("Expected an accepted placement update for the author");
    process.env.ARBOR_DATA_HOME = stateA;
    await writeFile(join(treeA, "chain-one.txt"), "chain one\n");
    let pending = pendingFromSnapshot(base, await resolveSnapshot(await snapshotDirectory(treeA)));
    await writeFile(join(treeA, "chain-two.txt"), "chain two\n");
    const chainEnd = await resolveSnapshot(await snapshotDirectory(treeA));
    pending = appendPendingTreeSuccessor(pending, chainEnd);
    await savePendingTreeUpdate(tree, pending);
    const chain = updatesFromPending(pending);
    const chainLength = chain.length;
    expect(chainLength).toBe(2);

    // The peer's successor adds one file on top of the chain's final root.
    const chainRoot = decodeWireDirectory(chainEnd.objects.get(chainEnd.root)!);
    if (chainRoot.type !== "directory") throw new Error("Expected a directory root");
    const extraFile = new TextEncoder().encode("peer successor\n");
    const successorRoot = encodeWireDirectory({
      type: "directory",
      entries: [...chainRoot.entries, { name: "peer-successor.txt", file: hashObject(extraFile) }]
        .sort((left, right) => compareWireNames(left.name, right.name)),
    });
    const successorObjects = new Map(chainEnd.objects);
    successorObjects.set(hashObject(extraFile), extraFile);
    successorObjects.set(hashObject(successorRoot), successorRoot);
    const successor: CandidateUpdate = { change: crypto.randomUUID(), trace: null,
      candidate: hashObject(successorRoot),
      resolves: [],
      objects: [...successorObjects].map(([hash, bytes]) => ({ hash, bytes })),
      deltas: [],
    };

    // Hold the daemon's own resubmission of the chain (recognizable by its
    // length) until the peer has extended it, so the replay order is fixed.
    const historyBefore = host.canopy.acceptedUpdates(tree).length;
    const systemFetch = globalThis.fetch;
    const daemonBodies: any[] = [];
    const daemonResponses: any[] = [];
    let releaseDaemon!: () => void;
    const daemonReleased = new Promise<void>((resolve) => { releaseDaemon = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        if (body.base === pending.base && body.updates?.length === chainLength) {
          daemonBodies.push(body);
          await daemonReleased;
          const response = await systemFetch(input, init);
          daemonResponses.push(await response.clone().json());
          return response;
        }
      }
      return systemFetch(input, init);
    }) as typeof fetch;

    const author = await launch(stateA, treeA);
    const idle = async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle";
    try {
      await waitFor(async () => daemonBodies.length === 1, 10_000);

      const peer = new WireClient(host.url, token);
      const peerResponse = await peer.submitUpdates(tree, {
        base: pending.base,
        updates: [...chain.map((update) => decodeCandidateUpdateJSON(update)), successor],
      });
      expect(peerResponse.results).toHaveLength(chainLength + 1);
      const successorAccepted = peerResponse.results.at(-1)!;
      expect(successorAccepted.outcome).toBe("accepted");
      expect(successorAccepted.update.root).toBe(successor.candidate);
      expect(host.canopy.acceptedUpdates(tree).length).toBe(historyBefore + chainLength + 1);

      releaseDaemon();
      await author.running.service.synchronizeNow();
      await waitFor(() => readFile(join(treeA, "peer-successor.txt"), "utf8")
        .then((value) => value === "peer successor\n")
        .catch(() => false), 2_000);
      await waitFor(idle);

      // Canopy replayed the daemon's prefix by digest: no merge, no new update.
      expect(host.canopy.acceptedUpdates(tree).length).toBe(historyBefore + chainLength + 1);
      expect(await pendingTreeUpdate(tree)).toBeUndefined();
      expect(await treeConflict(tree)).toBeUndefined();
      expect((await author.running.service.trees.descriptors()).find(({ id }) => id === tree)?.sync).toBe("idle");
      expect(author.running.service.trees.placementFor(tree)?.update).toBe(successorAccepted.update.id);
      expect(daemonBodies).toHaveLength(1);
      expect(daemonResponses).toHaveLength(1);
      expect(daemonResponses[0].results.map((result: any) => result.requestDigest))
        .toEqual(peerResponse.results.slice(0, chainLength).map((result) => result.requestDigest));
      expect(daemonResponses[0].results.every((result: any) => !result.reconciliation)).toBe(true);
    } finally {
      releaseDaemon();
      globalThis.fetch = systemFetch;
      await author.close();
    }
  }, 20_000);

  test("filesystem sync persists unresolved metadata and an independent cursor without holding edits", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const daemon = await ArborSyncDaemon.openControl({ autoSync: false });
    const db = new Database(join(hostState, "canopy.sqlite3"));
    const store = new AcceptedUpdateStore(db);
    try {
      await daemon.synchronizeNow();
      const owner = new WireClient(host.url, token), initial = await readAccepted(owner, tree);
      const candidate = (text: string) => {
        const directory = decodeWireDirectory(initial.snapshot.objects.get(initial.snapshot.root)!);
        const bytes = new TextEncoder().encode(text), file = hashObject(bytes);
        directory.entries = directory.entries.filter(e => e.name !== "metadata.bin");
        directory.entries.push({ name: "metadata.bin", file }); directory.entries.sort((a,b) => compareWireNames(a.name,b.name));
        const encoded = encodeWireDirectory(directory), root = hashObject(encoded);
        return { root, objects: new Map([...initial.snapshot.objects, [file, bytes], [root, encoded]]) };
      };
      await owner.submitUpdate(tree, initial.descriptor.tree.update, candidate("left"));
      await daemon.synchronizeNow();
      const metadata = (await owner.submitUpdate(tree, initial.descriptor.tree.update, candidate("right"))).update;
      expect(metadata.conflicted).toBe(true);
      // Move the newest row's cursor (its ordinal) away from its id.
      const metadataCursor = String(Number(metadata.id) + 1000);
      db.run("UPDATE accepted_updates SET ordinal = ? WHERE id = ?", [Number(metadataCursor), metadata.id]);
      db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'accepted_updates'", [Number(metadataCursor)]);
      await daemon.synchronizeNow();
      expect(daemon.trees.placementFor(tree)?.cursor).toBe(metadataCursor);
      expect((await daemon.trees.descriptors()).find(d => d.id === tree)).toMatchObject({ conflicted: true, sync: "idle" });
      await writeFile(join(treeA, "unresolved-sync.txt"), "An ordinary edit while review is unavailable.\n");
      await daemon.synchronizeNow();
      expect(await pendingTreeUpdate(tree)).toBeUndefined();
      expect(await treeConflict(tree)).toBeUndefined();
      expect(store.current(tree)!.conflicted).toBe(true);
      expect(store.current(tree)!.previous!.id).toBe(metadata.id);
    } finally { await daemon[Symbol.asyncDispose](); db.close(); }
    const restarted = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      expect(restarted.trees.placementFor(tree)?.conflicted).toBe(true);
      await restarted.synchronizeNow();
      expect((await restarted.trees.descriptors()).find(d => d.id === tree)).toMatchObject({ conflicted: true, sync: "idle" });
    } finally { await restarted[Symbol.asyncDispose](); }
  });

  test("preserves rejected pending intent even when local projection already matches Canopy", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const owner = new WireClient(host.url, token);
    const account = await owner.account();
    const configurationTree = account.account.configuration.id;
    const remote = await owner.descriptor(configurationTree);
    const emptyDirectory = encodeWireDirectory({ type: "directory", entries: [] });
    const emptyDirectoryHash = hashObject(emptyDirectory);
    const staleRoot = encodeWireDirectory({
      type: "directory",
      entries: [{ name: "LinkPreviews", file: emptyDirectoryHash }],
    });
    const staleRootHash = hashObject(staleRoot);
    await savePendingTreeUpdate(configurationTree, { change: crypto.randomUUID(), trace: null,
      base: remote.tree.update!,
      candidate: staleRootHash,
      resolves: [],
      objects: [
        { hash: emptyDirectoryHash, bytes: Buffer.from(emptyDirectory).toString("base64") },
        { hash: staleRootHash, bytes: Buffer.from(staleRoot).toString("base64") },
      ],
      deltas: [],
    });

    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      const pendingBefore = await pendingTreeUpdate(configurationTree);
      await expect(service.synchronizeNow()).rejects.toThrow("Unsupported account configuration path");
      expect(await pendingTreeUpdate(configurationTree)).toEqual(pendingBefore);
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await service[Symbol.asyncDispose]();
    }
  });
});
