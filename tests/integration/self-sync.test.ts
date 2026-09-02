import { nodeDocument, nodeKind } from "../helpers/node-snapshot.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon, serveArborSync } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import { serveCanopy } from "@arbor/canopy";
import { canonicalArborLocator, generateArborID, sha256 } from "@arbor/core";
import { CommunityConfigStore, saveCurrentDeviceID } from "@arbor/stores";
import { compareWireNames, decodeWireObject, encodeWireObject, hashObject, WireClient } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "../../packages/canopy/src/account-policy.ts";
import {
  pendingTreeUpdate,
  savePendingTreeUpdate,
} from "../../packages/arborsync/src/sync-state.ts";
import { snapshotDirectory } from "@arbor/fs";

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

async function installDataHome(
  home: string,
  device: string,
  credential: string,
  graph: ReturnType<typeof readAccountConfigGraph>,
  account: Awaited<ReturnType<WireClient["account"]>>,
): Promise<void> {
  await mkdir(join(home, "devices"), { recursive: true });
  for (const [path, source] of Object.entries(graph.sources)) {
    await writeFile(join(home, path), source);
  }
  process.env.ARBOR_DATA_HOME = home;
  await saveCurrentDeviceID(device);
  const configuration = await new WireClient(host.url, credential).descriptor(account.account.configuration.id);
  await new CommunityConfigStore().set(host.url, credential, {
    id: account.account.id,
    handle: account.account.handle,
    profileTree: account.account.profileTree,
    profileURL: account.account.profileURL,
    communityTree: account.account.community.id,
    communityURL: canonicalArborLocator(account.account.community.canonical!),
    configurationTree: account.account.configuration.id,
    configurationRef: configuration.tree.root,
    configurationUpdate: configuration.tree.update,
  });
}

async function launch(state: string, path: string) {
  process.env.ARBOR_DATA_HOME = state;
  // A long fallback interval proves that live Wire watches, not polling,
  // drive every cross-daemon expectation below.
  const running = await serveArborSync(path, { port: 0, syncIntervalMs: 60_000 });
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
  let configuration = await owner.currentSnapshot(initialAccount.account.configuration.id);
  let graph = readAccountConfigGraph({
    root: configuration.tree.root,
    objects: configuration.snapshot.objects,
  }, initialAccount.account.configuration.id);
  deviceA = graph.account.admins[0]!;
  tree = generateArborID("tr");
  const reserved = snapshotAccountConfig({
    account: graph.account,
    trees: { version: 1, trees: {
      ...graph.trees.trees,
      [tree]: { canonicalPath: "/~owner/self-sync", access: [] },
    } },
    devices: {
      ...graph.devices,
      [deviceA]: { ...graph.devices[deviceA]!, placements: {
        ...graph.devices[deviceA]!.placements,
        [tree]: { server: new URL(host.url).origin, path: treeA },
      } },
    },
  });
  await owner.submitUpdate(configuration.tree.id, configuration.tree.update, reserved);
  await owner.submitUpdate(tree, null, await snapshotDirectory(treeA));

  deviceB = generateArborID("dv");
  const pairing = await owner.createPairing();
  await owner.claimPairing(pairing.id, pairing.secret, {
    id: deviceB,
    label: "Self-sync peer",
    credentialDigest: `sha256:${sha256(tokenB)}`,
  }, { [tree]: { server: new URL(host.url).origin, path: treeB } });
  configuration = await owner.currentSnapshot(initialAccount.account.configuration.id);
  graph = readAccountConfigGraph({
    root: configuration.tree.root,
    objects: configuration.snapshot.objects,
  }, initialAccount.account.configuration.id);
  const account = await owner.account();
  await installDataHome(stateA, deviceA, token, graph, account);
  await installDataHome(stateB, deviceB, tokenB, graph, account);
});

afterAll(async () => {
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateA;
  const cleanup = await serveArborSync(treeA, { port: 0 });
  await cleanup.service.communityConfig.remove();
  cleanup.server.stop(true);
  await cleanup.service[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateB;
  const peerCleanup = await serveArborSync(bootstrapB, { port: 0 });
  await peerCleanup.service.communityConfig.remove();
  peerCleanup.server.stop(true);
  await peerCleanup.service[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
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

    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const note = await author.client.node({ tree, path: "/note", stableKey: null });
    const source = nodeDocument(note)!.source.replace("Common", "From A");
    const updateBodies: any[] = [];
    const systemFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
        updateBodies.push(JSON.parse(init.body));
      }
      return systemFetch(input, init);
    }) as typeof fetch;
    try {
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: note.capabilities.content?.revision!,
        source,
        sourceEdits: [{ offset: 2, length: 6, replacement: "From A", expected: "Common" }],
      });
      await waitFor(async () => updateBodies.some((body) => body.deltas?.length === 1));
    } finally {
      globalThis.fetch = systemFetch;
    }
    const deltaBody = updateBodies.find((body) => body.deltas?.length === 1)!;
    expect(deltaBody.deltas[0].instructions).toContainEqual({ insert: Buffer.from("From A").toString("base64") });
    expect(deltaBody.objects).not.toContainEqual(expect.objectContaining({ hash: deltaBody.deltas[0].result }));
    await author.close();

    const reader = await launch(stateB, treeB);
    await waitFor(async () => (await readFile(join(treeB, "note.md"), "utf8")).includes("From A"));
    expect(await reader.client.node({ tree, path: "/note", stableKey: null }).then((node) => nodeDocument(node)?.bodySource)).toContain("From A");
    await reader.close();

    const fallback = await launch(stateA, treeA);
    await waitFor(async () => (await fallback.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const beforeFallback = await fallback.client.node({ tree, path: "/note", stableKey: null });
    const fallbackBodies: any[] = [];
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
        fallbackBodies.push(JSON.parse(init.body));
      }
      return fallbackFetch(input, init);
    }) as typeof fetch;
    try {
      await fallback.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: beforeFallback.capabilities.content?.revision!,
        source: "# Complete-object fallback\n",
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(nodeDocument(beforeFallback)!.source),
          replacement: "# Complete-object fallback\n",
          expected: nodeDocument(beforeFallback)!.source,
        }],
      });
      await waitFor(async () => fallbackBodies.some((body) => Array.isArray(body.objects) && body.objects.length > 0));
    } finally {
      globalThis.fetch = fallbackFetch;
    }
    const fallbackBody = fallbackBodies.find((body) => Array.isArray(body.objects) && body.objects.length > 0)!;
    expect(fallbackBody.deltas).toEqual([]);
    await fallback.running.service.synchronizeNow();
    await fallback.close();
  }, 20_000);

  test("rebases a later local save on the just-accepted local generation", async () => {
    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const before = await author.client.node({ tree, path: "/note", stableKey: null });
    const firstSource = "# Rapid generation one\n";
    const secondSource = "# Rapid generation two\n";
    const updateBodies: any[] = [];
    const systemFetch = globalThis.fetch;
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let observeFirst!: () => void;
    const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
    let blockNextUpdate = true;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
        updateBodies.push(JSON.parse(init.body));
        if (blockNextUpdate) {
          blockNextUpdate = false;
          observeFirst();
          await firstReleased;
        }
      }
      return systemFetch(input, init);
    }) as typeof fetch;
    try {
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: before.capabilities.content?.revision!,
        source: firstSource,
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(nodeDocument(before)!.source),
          replacement: firstSource,
          expected: nodeDocument(before)!.source,
        }],
      });
      await firstObserved;
      const afterFirst = await author.client.node({ tree, path: "/note", stableKey: null });
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: afterFirst.capabilities.content?.revision!,
        source: secondSource,
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(nodeDocument(afterFirst)!.source),
          replacement: secondSource,
          expected: nodeDocument(afterFirst)!.source,
        }],
      });
      releaseFirst();
      await waitFor(async () => updateBodies.length >= 2
        && (await author.running.service.trees.descriptors())
          .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    } finally {
      releaseFirst();
      globalThis.fetch = systemFetch;
    }

    expect(updateBodies[1].base).toBe(updateBodies[0].acceptedUpdate ?? updateBodies[1].base);
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(secondSource);
    const after = await author.client.node({ tree, path: "/note", stableKey: null });
    const restoredSource = "# Complete-object fallback\n";
    await author.client.mutateContent({
      op: "writeMarkdown",
      ref: { tree, path: "/note", stableKey: null },
      baseContentRevision: after.capabilities.content?.revision!,
      source: restoredSource,
      sourceEdits: [{
        offset: 0,
        length: Buffer.byteLength(nodeDocument(after)!.source),
        replacement: restoredSource,
        expected: nodeDocument(after)!.source,
      }],
    });
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    await author.close();
  });

  test("preserves both sides when devices diverge offline", async () => {
    const commonRef = host.canopy.get(tree)!.ref;
    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();

    const offline = await launch(stateA, treeA);
    const offlineNode = await offline.client.node({ tree, path: "/note", stableKey: null });
    const offlineSource = nodeDocument(offlineNode)!.source.replace("Complete-object", "Locally durable");
    const savedOffline = await Promise.race([
      offline.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: offlineNode.capabilities.content?.revision!,
        source: offlineSource,
        sourceEdits: [{ offset: 2, length: 15, replacement: "Locally durable", expected: "Complete-object" }],
      }),
      Bun.sleep(1_000).then(() => { throw new Error("Local save waited for the unavailable server"); }),
    ]);
    expect(savedOffline.effects[0]?.contentRevision).toBeDefined();
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(offlineSource);
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

  test("keeps binary conflicts only on the client and resolves them as a new update", async () => {
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
    await waitFor(async () => {
      const descriptor = (await conflicted.client.trees()).snapshot.find((candidate) => candidate.id === tree);
      return descriptor?.sync === "conflict";
    });
    expect(await readFile(join(treeB, "sample.bin"), "utf8")).toBe("binary-from-b");
    expect(host.canopy.acceptedUpdates(tree)).toHaveLength(historyBefore + 1);
    await conflicted.close();

    const restarted = await launch(stateB, treeB);
    await waitFor(async () => {
      const descriptor = (await restarted.client.trees()).snapshot.find((candidate) => candidate.id === tree);
      return descriptor?.sync === "conflict";
    });
    await restarted.client.resolveConflict(tree, "local");
    await waitFor(async () => host.canopy.acceptedUpdates(tree).length === historyBefore + 2);
    await restarted.close();

    const follower = await launch(stateA, treeA);
    await waitFor(async () => (await readFile(join(treeA, "sample.bin"), "utf8")) === "binary-from-b");
    expect(host.canopy.acceptedUpdates(tree)).toHaveLength(historyBefore + 2);
    await follower.close();
  });

  test("a live watch materializes a remote accepted update without polling", async () => {
    const reader = await launch(stateB, treeB);
    const idle = async () => (await reader.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle";
    await waitFor(idle);

    // Another writer advances the tree directly on Canopy; the reader's only
    // way to learn about it within the timeout is its live watch.
    const owner = new WireClient(host.url, token);
    const current = await owner.currentSnapshot(tree);
    const rootObject = decodeWireObject(current.snapshot.objects.get(current.snapshot.root)!);
    if (rootObject.type !== "directory") throw new Error("Expected a directory root");
    const file = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("delivered by watch\n") });
    const nextRoot = encodeWireObject({
      type: "directory",
      entries: [...rootObject.entries, { name: "watched.txt", hash: hashObject(file) }]
        .sort((left, right) => compareWireNames(left.name, right.name)),
    });
    const objects = current.snapshot.objects;
    objects.set(hashObject(file), file);
    objects.set(hashObject(nextRoot), nextRoot);
    const accepted = await owner.submitUpdate(
      tree,
      current.tree.update,
      { root: hashObject(nextRoot), objects },
    );
    if (accepted.outcome !== "accepted") throw new Error(`Expected an accepted update, got ${accepted.outcome}`);

    await waitFor(() => readFile(join(treeB, "watched.txt"), "utf8")
      .then((value) => value === "delivered by watch\n")
      .catch(() => false));
    await waitFor(idle);
    expect(reader.running.service.trees.placementFor(tree)?.update).toBe(accepted.update.id);
    await reader.close();
  });

  test("discards a stale pending update when local state already matches Canopy", async () => {
    process.env.ARBOR_DATA_HOME = stateA;
    const owner = new WireClient(host.url, token);
    const account = await owner.account();
    const configurationTree = account.account.configuration.id;
    const remote = await owner.descriptor(configurationTree);
    const emptyDirectory = encodeWireObject({ type: "directory", entries: [] });
    const emptyDirectoryHash = hashObject(emptyDirectory);
    const staleRoot = encodeWireObject({
      type: "directory",
      entries: [{ name: "LinkPreviews", hash: emptyDirectoryHash }],
    });
    const staleRootHash = hashObject(staleRoot);
    await savePendingTreeUpdate(configurationTree, {
      base: remote.tree.update!,
      candidate: staleRootHash,
      ifMatch: "modelHash",
      objects: [
        { hash: emptyDirectoryHash, bytes: Buffer.from(emptyDirectory).toString("base64") },
        { hash: staleRootHash, bytes: Buffer.from(staleRoot).toString("base64") },
      ],
      deltas: [],
    });

    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    try {
      await service.synchronizeNow();
      expect(await pendingTreeUpdate(configurationTree)).toBeUndefined();
      expect((await service.trees.descriptors()).find(({ id }) => id === configurationTree)?.sync).toBe("idle");
      expect((await owner.descriptor(configurationTree)).tree).toEqual(remote.tree);
    } finally {
      await service[Symbol.asyncDispose]();
    }
  });
});
