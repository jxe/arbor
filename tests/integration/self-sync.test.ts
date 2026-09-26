import { installAccountHome } from "../helpers/account-home.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon, serveArborSync } from "@overstory/arborsync";
import { ArborSyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "../../packages/canopyd/src/updates/store.ts";
import { serveHost } from "@overstory/canopyd";
import { HostAccountStore, generateArborID, sha256, type CandidateUpdate, compareProtocolNames, decodeUpdateRequestJSON, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, ProtocolClient } from "@overstory/protocol";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { retireEarlierSyncState } from "@overstory/client";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";

const token = "self-sync-owner";
let sandbox: string;
let hostState: string;
let host: Awaited<ReturnType<typeof serveHost>>;
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

async function readAccepted(client: ProtocolClient, treeID: string) {
  const descriptor = await client.descriptor(treeID);
  const snapshot = await client.snapshot(treeID, descriptor.tree.root);
  return { descriptor, snapshot };
}

async function launch(state: string, path: string) {
  process.env.ARBOR_DATA_HOME = state;
  // A long fallback interval proves that live protocol watches, not polling,
  // drive every cross-daemon expectation below.
  const running = await serveArborSync(path, {
    port: 0,
    syncIntervalMs: 60_000,
  });
  const client = new ArborSyncRESTClient({ baseURL: running.url });
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
  host = await serveHost({
    dataRoot: hostState,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  hostPort = host.server.port!;

  const owner = new ProtocolClient(host.url, token);
  const initialAccount = await owner.account();
  const profile = initialAccount.account.profileTree!;
  deviceA = Object.values((await readTreeConfig(owner, profile, "person")).values.devices!).find(device => device.administrator)!.id;
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(treeA)), { parent: { tree: profile, name: "self-sync", kind: "person" } });

  deviceB = generateArborID("dv");
  const pairing = await owner.createPairing();
  await owner.claimPairing(pairing.id, pairing.secret, {
    id: deviceB,
    label: "Self-sync peer",
    credentialDigest: `sha256:${sha256(tokenB)}`,
  });
  await installAccountHome(stateA, owner, deviceA, token, { [treeA]: tree });
  await installAccountHome(stateB, new ProtocolClient(host.url, tokenB), deviceB, tokenB, { [treeB]: tree });
});

afterAll(async () => {
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateA;
  const cleanup = await serveArborSync(treeA, { port: 0 });
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  cleanup.server.stop(true);
  await cleanup.service[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateB;
  const peerCleanup = await serveArborSync(bootstrapB, { port: 0 });
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
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

    host = await serveHost({
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
    host = await serveHost({
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
        const current = await new ProtocolClient(host.url, token).descriptor(tree);
        const snapshot = await new ProtocolClient(host.url, token).snapshot(tree, current.tree.root);
        return decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!).entries.some(e => e.name === "during-review.txt");
      });
      const owner = new ProtocolClient(host.url, token), current = await readAccepted(owner, tree);
      const page = await owner.conflicts(tree, current.descriptor.tree.update, current.snapshot.root);
      expect(page.decisions).toHaveLength(1);
      const decision = page.decisions[0]!;
      expect(decision.alternatives.map(a => a.value)).toContainEqual({ file: hashObject(new TextEncoder().encode("binary-from-b")) });
      const bytes = new TextEncoder().encode("binary-from-b"), file = hashObject(bytes);
      const directory = decodeProtocolDirectory(current.snapshot.objects.get(current.snapshot.root)!);
      directory.entries = directory.entries.map(e => e.name === "sample.bin" ? { name: e.name, file } : e);
      const encoded = encodeProtocolDirectory(directory), root = hashObject(encoded);
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
    // Establish the initial accepted base and its live protocol watch. After this
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
    const owner = new ProtocolClient(host.url, token);
    const current = await readAccepted(owner, tree);
    const rootObject = decodeProtocolDirectory(current.snapshot.objects.get(current.snapshot.root)!);
    if (rootObject.type !== "directory") throw new Error("Expected a directory root");
    const file = new TextEncoder().encode("delivered by watch\n");
    const nextRoot = encodeProtocolDirectory({
      type: "directory",
      entries: [...rootObject.entries, { name: "watched.txt", file: hashObject(file) }]
        .sort((left, right) => compareProtocolNames(left.name, right.name)),
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
      const chainRoot = decodeProtocolDirectory(chainEnd.objects.get(chainEnd.root)!);
      const extraFile = new TextEncoder().encode("peer successor\n");
      const successorRoot = encodeProtocolDirectory({
        type: "directory",
        entries: [...chainRoot.entries, { name: "peer-successor.txt", file: hashObject(extraFile) }]
          .sort((left, right) => compareProtocolNames(left.name, right.name)),
      });
      const successor: CandidateUpdate = { change: crypto.randomUUID(), trace: null,
        candidate: hashObject(successorRoot), resolves: [], deltas: [],
        objects: [{ hash: hashObject(extraFile), bytes: extraFile }, { hash: hashObject(successorRoot), bytes: successorRoot }],
      };
      const peer = new ProtocolClient(host.url, token);
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
      const owner = new ProtocolClient(host.url, token), initial = await readAccepted(owner, tree);
      const candidate = (text: string) => {
        const directory = decodeProtocolDirectory(initial.snapshot.objects.get(initial.snapshot.root)!);
        const bytes = new TextEncoder().encode(text), file = hashObject(bytes);
        directory.entries = directory.entries.filter(e => e.name !== "metadata.bin");
        directory.entries.push({ name: "metadata.bin", file }); directory.entries.sort((a,b) => compareProtocolNames(a.name,b.name));
        const encoded = encodeProtocolDirectory(directory), root = hashObject(encoded);
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

  test("a declined folder change is kept on disk across restart while the account folder keeps syncing, until restored", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const owner = new ProtocolClient(host.url, token);
    const configurationTree = (await owner.account()).account.configuration.id;
    const remote = await owner.descriptor(configurationTree);
    const checkout = join(stateA, "accounts", configurationTree);
    // A path the host refuses in an account configuration.
    await mkdir(join(checkout, "LinkPreviews"), { recursive: true });
    await writeFile(join(checkout, "LinkPreviews", "preview.txt"), "refused\n");

    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      expect(await service.syncPresentation(configurationTree)).toMatchObject({ state: "current", pending: 0 });
      const descriptor = (await service.trees.descriptors()).find(({ id }) => id === configurationTree);
      expect(descriptor?.sync).toBe("idle");
      expect(descriptor?.declined?.paths).toEqual(["/LinkPreviews"]);
      expect(await service.declinedChanges(configurationTree)).toMatchObject({ paths: ["/LinkPreviews"], points: ["/LinkPreviews"] });
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await service[Symbol.asyncDispose]();
    }
    const restarted = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await restarted.synchronizeNow();
      expect((await restarted.declinedChanges(configurationTree))?.points).toEqual(["/LinkPreviews"]);
      expect(await readFile(join(checkout, "LinkPreviews", "preview.txt"), "utf8")).toBe("refused\n");
      await restarted.restoreDeclined(configurationTree);
      expect(await restarted.declinedChanges(configurationTree)).toBeNull();
      await expect(readFile(join(checkout, "LinkPreviews", "preview.txt"), "utf8")).rejects.toThrow();
      await restarted.synchronizeNow();
      expect(await restarted.syncPresentation(configurationTree)).toMatchObject({ state: "current", pending: 0 });
      const descriptor = (await restarted.trees.descriptors()).find(({ id }) => id === configurationTree);
      expect(descriptor?.sync).toBe("idle");
      expect(descriptor?.declined).toBeUndefined();
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await restarted[Symbol.asyncDispose]();
    }
  });

  test("independent folder work publishes and remote work arrives while a declined path is kept", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const systemFetch = globalThis.fetch;
    let refusing = false;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (refusing && url.includes(`/.arbor/trees/${tree}/updates`)) {
        return Response.json({ error: "invalid-request", message: "refused for the test", retryable: false }, { status: 400 });
      }
      return systemFetch(input, init);
    }) as typeof fetch;
    const owner = new ProtocolClient(host.url, token);
    const hasEntry = async (name: string) => {
      const current = await readAccepted(owner, tree);
      return decodeProtocolDirectory(current.snapshot.objects.get(current.snapshot.root)!).entries.some((entry) => entry.name === name);
    };
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      refusing = true;
      await writeFile(join(treeA, "refused.txt"), "the host refuses this\n");
      await service.synchronizeNow();
      refusing = false;
      expect((await service.declinedChanges(tree))?.points).toEqual(["/refused.txt"]);

      // Independent work publishes with fresh identity; the declined file does not.
      await writeFile(join(treeA, "independent.txt"), "published while held\n");
      await service.synchronizeNow();
      expect(await hasEntry("independent.txt")).toBe(true);
      expect(await hasEntry("refused.txt")).toBe(false);

      // Remote work arrives while the path is declined, and the declined file is left alone.
      const current = await readAccepted(owner, tree);
      const root = decodeProtocolDirectory(current.snapshot.objects.get(current.snapshot.root)!);
      const remoteBytes = new TextEncoder().encode("from another client\n");
      const nextRoot = encodeProtocolDirectory({ type: "directory", entries: [...root.entries,
        { name: "remote.txt", file: hashObject(remoteBytes) }, { name: "refused.txt", file: hashObject(remoteBytes) }]
        .sort((left, right) => compareProtocolNames(left.name, right.name)) });
      current.snapshot.objects.set(hashObject(remoteBytes), remoteBytes);
      current.snapshot.objects.set(hashObject(nextRoot), nextRoot);
      await owner.submitUpdate(tree, current.descriptor.tree.update, { root: hashObject(nextRoot), objects: current.snapshot.objects });
      await service.synchronizeNow();
      expect(await readFile(join(treeA, "remote.txt"), "utf8")).toBe("from another client\n");
      expect(await readFile(join(treeA, "refused.txt"), "utf8")).toBe("the host refuses this\n");
      expect((await service.declinedChanges(tree))?.points).toEqual(["/refused.txt"]);

      // Resending publishes the declined file as the folder holds it now.
      await service.resendDeclined(tree);
      await service.synchronizeNow();
      expect(await service.declinedChanges(tree)).toBeNull();
      const after = await readAccepted(owner, tree);
      const entry = decodeProtocolDirectory(after.snapshot.objects.get(after.snapshot.root)!).entries.find((candidate) => candidate.name === "refused.txt");
      expect(entry?.file).toBe(hashObject(new TextEncoder().encode("the host refuses this\n")));
      expect(await service.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
    } finally {
      globalThis.fetch = systemFetch;
      await service[Symbol.asyncDispose]();
    }
  });

  test("a declined path is released when the folder is put back", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const systemFetch = globalThis.fetch;
    let refusing = false;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (refusing && url.includes(`/.arbor/trees/${tree}/updates`)) {
        return Response.json({ error: "invalid-request", message: "refused for the test", retryable: false }, { status: 400 });
      }
      return systemFetch(input, init);
    }) as typeof fetch;
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      refusing = true;
      await writeFile(join(treeA, "withdrawn.txt"), "never mind\n");
      await service.synchronizeNow();
      refusing = false;
      expect((await service.declinedChanges(tree))?.points).toEqual(["/withdrawn.txt"]);
      await rm(join(treeA, "withdrawn.txt"));
      await service.synchronizeNow();
      expect(await service.declinedChanges(tree)).toBeNull();
      expect((await service.trees.descriptors()).find(({ id }) => id === tree)?.declined).toBeUndefined();
    } finally {
      globalThis.fetch = systemFetch;
      await service[Symbol.asyncDispose]();
    }
  });
});

describe("ignore rules in a placed folder", () => {
  const owner = () => new ProtocolClient(host.url, token);
  const syncState = async (service: ArborSyncDaemon) => (await service.trees.descriptors()).find(({ id }) => id === tree)?.sync;

  /** The accepted text at a path, "<directory>" for a directory, or null. */
  async function acceptedFile(path: string): Promise<string | null> {
    const { snapshot } = await readAccepted(owner(), tree);
    let entry: { file?: string; directory?: string } | undefined = { directory: snapshot.root };
    for (const name of path.split("/").filter(Boolean)) {
      if (!entry?.directory) return null;
      const directory = decodeProtocolDirectory(snapshot.objects.get(entry.directory as never)!);
      entry = directory.type === "directory" ? directory.entries.find((candidate) => candidate.name === name) : undefined;
    }
    if (entry?.directory) return "<directory>";
    return entry?.file ? new TextDecoder().decode(snapshot.objects.get(entry.file as never)!) : null;
  }

  /** Another client's accepted update: set (or, with null, delete) files by path. */
  async function remoteChange(changes: Record<string, string | null>): Promise<void> {
    const client = owner();
    const current = await readAccepted(client, tree);
    const objects = new Map(current.snapshot.objects);
    const rewrite = (hash: string | undefined, names: string[], value: string | null): string => {
      const directory = hash ? decodeProtocolDirectory(objects.get(hash as never)!) : { type: "directory" as const, entries: [] };
      if (directory.type !== "directory") throw new Error("Expected a directory");
      const [name, ...rest] = names;
      const existing = directory.entries.find((entry) => entry.name === name);
      const entries = directory.entries.filter((entry) => entry.name !== name);
      if (rest.length) entries.push({ name: name!, directory: rewrite(existing?.directory, rest, value) as never });
      else if (value !== null) {
        const bytes = new TextEncoder().encode(value);
        objects.set(hashObject(bytes), bytes);
        entries.push({ name: name!, file: hashObject(bytes) });
      }
      const encoded = encodeProtocolDirectory({ ...directory, entries: entries.sort((a, b) => compareProtocolNames(a.name, b.name)) });
      objects.set(hashObject(encoded), encoded);
      return hashObject(encoded);
    };
    let root: string = current.snapshot.root;
    for (const [path, value] of Object.entries(changes)) root = rewrite(root, path.split("/").filter(Boolean), value);
    await client.submitUpdate(tree, current.descriptor.tree.update, { root: root as never, objects });
  }

  test("ignored, untracked content is never published, deleted by a pull, or scanned into a change", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    await writeFile(join(treeA, ".gitignore"), ".env\nbuild/\n");
    await writeFile(join(treeA, ".arborignore"), "draft.md\n");
    await writeFile(join(treeA, ".env"), "TOKEN=never-leaves\n");
    await mkdir(join(treeA, "build"), { recursive: true });
    await writeFile(join(treeA, "build", "out.bin"), "generated\n");
    await writeFile(join(treeA, "draft.md"), "---\nid: draft1\n---\nNot yet\n");
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      expect(await acceptedFile("/.gitignore")).toBe(".env\nbuild/\n");
      expect(await acceptedFile("/.arborignore")).toBe("draft.md\n");
      for (const path of ["/.env", "/build", "/draft.md"]) expect(await acceptedFile(path)).toBeNull();
      expect(await syncState(service)).toBe("idle");
      expect((await service.pendingUpdate(tree)).request).toBeNull();

      const before = host.canopy.acceptedUpdates(tree).length;
      await remoteChange({ "/remote-note.txt": "from elsewhere\n" });
      await service.synchronizeNow();
      expect(await readFile(join(treeA, "remote-note.txt"), "utf8")).toBe("from elsewhere\n");
      expect(await readFile(join(treeA, ".env"), "utf8")).toBe("TOKEN=never-leaves\n");
      expect(await readFile(join(treeA, "build", "out.bin"), "utf8")).toBe("generated\n");
      expect(await readFile(join(treeA, "draft.md"), "utf8")).toContain("Not yet");
      expect(host.canopy.acceptedUpdates(tree).length).toBe(before + 1);
      expect(await syncState(service)).toBe("idle");
    } finally {
      await service[Symbol.asyncDispose]();
    }
    const count = host.canopy.acceptedUpdates(tree).length;
    const restarted = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await restarted.synchronizeNow();
      expect(await syncState(restarted)).toBe("idle");
      expect((await restarted.pendingUpdate(tree)).request).toBeNull();
      expect(host.canopy.acceptedUpdates(tree).length).toBe(count);
    } finally {
      await restarted[Symbol.asyncDispose]();
    }
  }, 20_000);

  test("a tracked path stays synchronized when a rule matches it, until it is deleted", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await writeFile(join(treeA, "tracked.log"), "first\n");
      await service.synchronizeNow();
      expect(await acceptedFile("/tracked.log")).toBe("first\n");

      await writeFile(join(treeA, ".arborignore"), "draft.md\n*.log\n");
      await writeFile(join(treeA, "untracked.log"), "local only\n");
      await service.synchronizeNow();
      expect(await acceptedFile("/.arborignore")).toBe("draft.md\n*.log\n");
      expect(await acceptedFile("/tracked.log")).toBe("first\n");
      expect(await acceptedFile("/untracked.log")).toBeNull();

      // The watcher reports the ignored path; the folder still tracks it, so the edit publishes.
      // Let the scans the previous writes scheduled finish first, so only that report can publish it.
      await Bun.sleep(1_000);
      await writeFile(join(treeA, "tracked.log"), "second\n");
      await waitFor(async () => await acceptedFile("/tracked.log") === "second\n", 8_000);

      await remoteChange({ "/tracked.log": "third\n" });
      await service.synchronizeNow();
      expect(await readFile(join(treeA, "tracked.log"), "utf8")).toBe("third\n");
      expect(await syncState(service)).toBe("idle");

      await rm(join(treeA, "tracked.log"));
      await service.synchronizeNow();
      expect(await acceptedFile("/tracked.log")).toBeNull();
      const count = host.canopy.acceptedUpdates(tree).length;
      await writeFile(join(treeA, "tracked.log"), "recreated\n");
      await service.synchronizeNow();
      expect(await acceptedFile("/tracked.log")).toBeNull();
      expect(host.canopy.acceptedUpdates(tree).length).toBe(count);
      expect(await syncState(service)).toBe("idle");
      expect(await readFile(join(treeA, "tracked.log"), "utf8")).toBe("recreated\n");
    } finally {
      await service[Symbol.asyncDispose]();
    }
  }, 20_000);

  test("remote deletions and rule changes keep ignored local bytes, and a removed rule publishes what it uncovered", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await writeFile(join(treeA, "kept.tmp"), "tracked before its rule\n");
      await writeFile(join(treeA, "arrives.tmp2"), "tracked before a remote rule\n");
      await service.synchronizeNow();
      await writeFile(join(treeA, ".arborignore"), "draft.md\n*.log\n*.tmp\n");
      await service.synchronizeNow();
      expect(await acceptedFile("/kept.tmp")).toBe("tracked before its rule\n");

      // A remote deletion of a tracked path a rule matches leaves the bytes, now untracked.
      await remoteChange({ "/kept.tmp": null });
      await service.synchronizeNow();
      expect(await readFile(join(treeA, "kept.tmp"), "utf8")).toBe("tracked before its rule\n");
      expect(await acceptedFile("/kept.tmp")).toBeNull();
      expect(await syncState(service)).toBe("idle");

      // A rule arriving with a deletion keeps those bytes too; the rule it drops uncovers draft.md.
      await remoteChange({ "/.arborignore": "*.log\n*.tmp\n*.tmp2\n", "/arrives.tmp2": null });
      await service.synchronizeNow();
      expect(await readFile(join(treeA, "arrives.tmp2"), "utf8")).toBe("tracked before a remote rule\n");
      expect(await readFile(join(treeA, ".arborignore"), "utf8")).toBe("*.log\n*.tmp\n*.tmp2\n");
      await waitFor(async () => (await acceptedFile("/draft.md"))?.includes("Not yet") === true, 8_000);
      await service.synchronizeNow();
      expect(await acceptedFile("/arrives.tmp2")).toBeNull();
      expect(await acceptedFile("/kept.tmp")).toBeNull();
      expect(await acceptedFile("/.env")).toBeNull();
      expect(await syncState(service)).toBe("idle");
    } finally {
      await service[Symbol.asyncDispose]();
    }
  }, 20_000);

  test("an ignore file that is not UTF-8 applies no rules and does not stop synchronization", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    await mkdir(join(treeA, "bytes"), { recursive: true });
    await writeFile(join(treeA, "bytes", ".gitignore"), Buffer.from([0xff, 0x2a, 0x0a]));
    await writeFile(join(treeA, "bytes", "kept.txt"), "still content\n");
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      expect(await acceptedFile("/bytes/kept.txt")).toBe("still content\n");
      expect(await acceptedFile("/bytes/.gitignore")).not.toBeNull();
      expect(await syncState(service)).toBe("idle");
    } finally {
      await service[Symbol.asyncDispose]();
    }
  }, 20_000);
});
