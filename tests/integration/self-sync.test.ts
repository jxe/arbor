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
import { CanopyAccountStore, generateArborID, sha256, type CandidateUpdate, compareWireNames, decodeUpdateRequestJSON, decodeWireDirectory, encodeCandidateUpdateJSON, encodeWireDirectory, hashObject, WireClient } from "@overstory/protocol";
import { readAccountConfigGraph, snapshotAccountConfig } from "@overstory/protocol";
import { retireEarlierSyncState } from "@overstory/client";
import { snapshotJSON } from "@overstory/working-tree";
import { ChangeLog } from "@overstory/working-tree/node";
import { folderStateRoot } from "../../packages/arborsync/src/folder-sync.ts";
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
  let graph = readAccountConfigGraph({
    root: configuration.snapshot.root,
    objects: configuration.snapshot.objects,
  }, initialAccount.account.configuration.id);
  deviceA = Object.values(graph.devices).find(device => device.administrator)!.id;
  tree = generateArborID("tr");
  const reserved = snapshotAccountConfig({
    account: graph.account,
    resources: {
      ...graph.resources,
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
  graph = readAccountConfigGraph({
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


test("an earlier sync state with pending work is refused and never rewritten; a clean one is retired", async () => {
  process.env.ARBOR_DATA_HOME = stateA;
  const id = generateArborID("tr");
  const directory = join(stateA, ".state", "sync");
  const path = join(directory, `${Buffer.from(id).toString("base64url")}.json`);
  await mkdir(directory, { recursive: true });
  const original = JSON.stringify({ pending: { base: "up_old", change: "c", candidate: "sha256:0", trace: null, objects: [], deltas: [] } });
  await writeFile(path, original);
  try {
    await expect(retireEarlierSyncState(id)).rejects.toThrow("earlier Arbor Sync");
    expect(await readFile(path, "utf8")).toBe(original);
  } finally { await rm(path); }
  await writeFile(path, JSON.stringify({ accepted: { root: "sha256:0", hashes: [] } }));
  await retireEarlierSyncState(id);
  await expect(readFile(path, "utf8")).rejects.toThrow();
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
      expect(await conflicted.running.service.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
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
    // Two folder changes are published as one chain: the first attempt fails
    // in transit, so reconnection repeats it and appends the second (spec 09
    // rule 10). That exact request is held until a peer with the same
    // credential has submitted it and extended it.
    const systemFetch = globalThis.fetch;
    let failing = false;
    const daemonBodies: any[] = [];
    const daemonResponses: any[] = [];
    let releaseDaemon!: () => void;
    const daemonReleased = new Promise<void>((resolve) => { releaseDaemon = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
        if (failing) throw new TypeError("connection lost");
        const body = JSON.parse(init.body);
        // Only the daemon's first chain is held; the peer's own request passes.
        if (body.updates?.length >= 2 && !daemonBodies.length) {
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
      await waitFor(idle);
      const historyBefore = host.canopy.acceptedUpdates(tree).length;
      failing = true;
      await writeFile(join(treeA, "chain-one.txt"), "chain one\n");
      await author.running.service.synchronizeNow().catch(() => {});
      expect((await author.running.service.trees.descriptors()).find(({ id }) => id === tree)?.sync).toBe("offline");
      await writeFile(join(treeA, "chain-two.txt"), "chain two\n");
      failing = false;
      const syncing = author.running.service.synchronizeNow();
      await waitFor(async () => daemonBodies.length === 1, 10_000);
      const chain = decodeUpdateRequestJSON(daemonBodies[0]);

      // The peer's successor adds one file on top of the chain's final root.
      const chainEnd = await resolveSnapshot(await snapshotDirectory(treeA));
      expect(chainEnd.root).toBe(chain.updates.at(-1)!.candidate);
      const chainRoot = decodeWireDirectory(chainEnd.objects.get(chainEnd.root)!);
      const extraFile = new TextEncoder().encode("peer successor\n");
      const successorRoot = encodeWireDirectory({
        type: "directory",
        entries: [...chainRoot.entries, { name: "peer-successor.txt", file: hashObject(extraFile) }]
          .sort((left, right) => compareWireNames(left.name, right.name)),
      });
      const successor: CandidateUpdate = { change: crypto.randomUUID(), trace: null,
        candidate: hashObject(successorRoot), resolves: [], deltas: [],
        objects: [{ hash: hashObject(extraFile), bytes: extraFile }, { hash: hashObject(successorRoot), bytes: successorRoot }],
      };
      const peer = new WireClient(host.url, token);
      const peerResponse = await peer.submitUpdates(tree, { base: chain.base, updates: [...chain.updates, successor] });
      expect(peerResponse.results).toHaveLength(chain.updates.length + 1);
      const successorAccepted = peerResponse.results.at(-1)!;
      expect(successorAccepted.outcome).toBe("accepted");
      expect(successorAccepted.update.root).toBe(successor.candidate);

      releaseDaemon();
      await syncing;
      await waitFor(() => readFile(join(treeA, "peer-successor.txt"), "utf8")
        .then((value) => value === "peer successor\n")
        .catch(() => false), 5_000);
      await waitFor(idle);

      // Canopy replayed the daemon's chain by digest: no merge, no new update.
      expect(host.canopy.acceptedUpdates(tree).length).toBe(historyBefore + chain.updates.length + 1);
      expect(await author.running.service.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
      expect(author.running.service.trees.placementFor(tree)?.update).toBe(successorAccepted.update.id);
      expect(daemonResponses).toHaveLength(1);
      expect(daemonResponses[0].results.map((result: any) => result.requestDigest))
        .toEqual(peerResponse.results.slice(0, chain.updates.length).map((result) => result.requestDigest));
      expect(daemonResponses[0].results.every((result: any) => !result.reconciliation)).toBe(true);
    } finally {
      releaseDaemon();
      globalThis.fetch = systemFetch;
      await author.close();
    }
  }, 30_000);

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
      // An accepted update's cursor is its id.
      const metadataCursor = metadata.id;
      await daemon.synchronizeNow();
      expect(daemon.trees.placementFor(tree)?.cursor).toBe(metadataCursor);
      expect((await daemon.trees.descriptors()).find(d => d.id === tree)).toMatchObject({ conflicted: true, sync: "idle" });
      await writeFile(join(treeA, "unresolved-sync.txt"), "An ordinary edit while review is unavailable.\n");
      await daemon.synchronizeNow();
      expect(await daemon.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
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

  test("a refused change is held across restart until discarded, and the folder returns to the accepted state", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const owner = new WireClient(host.url, token);
    const account = await owner.account();
    const configurationTree = account.account.configuration.id;
    const remote = await owner.descriptor(configurationTree);
    const accepted = await owner.snapshot(configurationTree, remote.tree.root);
    // A change the host refuses: an account configuration path it does not allow.
    const extra = encodeWireDirectory({ type: "directory", entries: [] }), extraHash = hashObject(extra);
    const rootDirectory = decodeWireDirectory(accepted.objects.get(accepted.root)!);
    const staleRoot = encodeWireDirectory({ type: "directory", entries: [...rootDirectory.entries, { name: "LinkPreviews", directory: extraHash }]
      .sort((left, right) => compareWireNames(left.name, right.name)) });
    const staleRootHash = hashObject(staleRoot);
    const spine = new Map([...accepted.objects].filter(([, bytes]) => { try { decodeWireDirectory(bytes); return true; } catch { return false; } }));
    const change = `folder-refused-${crypto.randomUUID()}`;
    const log = new ChangeLog(configurationTree, folderStateRoot(configurationTree));
    await log.retain({ change, tree: configurationTree, basis: { kind: "accepted", root: remote.tree.root, update: remote.tree.update },
      graph: snapshotJSON({ root: accepted.root, objects: spine }), sourcePath: null, document: null,
      candidate: snapshotJSON({ root: staleRootHash, objects: new Map([...spine].filter(([hash]) => hash !== accepted.root).concat([[staleRootHash, staleRoot], [extraHash, extra]])) }),
      update: encodeCandidateUpdateJSON({ change, candidate: staleRootHash, trace: null, resolves: [], deltas: [],
        objects: [{ hash: staleRootHash, bytes: staleRoot }, { hash: extraHash, bytes: extra }].sort((left, right) => left.hash.localeCompare(right.hash)) }) });

    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      expect(await service.syncPresentation(configurationTree)).toMatchObject({ state: "held", pending: 1 });
      expect((await service.trees.descriptors()).find(({ id }) => id === configurationTree)?.sync).toBe("conflict");
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await service[Symbol.asyncDispose]();
    }
    const restarted = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await restarted.synchronizeNow();
      expect(await restarted.syncPresentation(configurationTree)).toMatchObject({ state: "held", pending: 1 });
      await restarted.discardHeldChanges(configurationTree);
      expect(await restarted.syncPresentation(configurationTree)).toMatchObject({ state: "current", pending: 0 });
      expect((await restarted.trees.descriptors()).find(({ id }) => id === configurationTree)?.sync).toBe("idle");
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await restarted[Symbol.asyncDispose]();
    }
  });
});
