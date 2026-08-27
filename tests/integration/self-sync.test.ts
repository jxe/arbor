import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSync } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import { serveCanopy } from "@arbor/canopy";
import { generateArborID, sha256 } from "@arbor/core";
import { CommunityConfigStore, saveCurrentDeviceID } from "@arbor/stores";
import { snapshotDirectory, WireClient } from "@arbor/wire";
import { readAccountConfigGraph, snapshotAccountConfig } from "../../packages/canopy/src/account-policy.ts";

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
  const configuration = await new WireClient(host.url, credential).ref(account.account.configuration.id);
  await new CommunityConfigStore().set(host.url, credential, {
    id: account.account.id,
    handle: account.account.handle,
    profileTree: account.account.profileTree,
    profileURL: account.account.profileURL,
    communityTree: account.account.community.id,
    communityURL: account.account.community.canonical!.locator,
    configurationTree: account.account.configuration.id,
    configurationRef: configuration.snapshot.ref,
    configurationUpdate: configuration.snapshot.update,
  });
}

async function launch(state: string, path: string) {
  process.env.ARBOR_DATA_HOME = state;
  const running = await serveArborSync(path, { port: 0 });
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
    root: configuration.snapshot.root,
    objects: new Map(configuration.snapshot.objects.map(({ hash, bytes }) => [hash, bytes])),
  }, initialAccount.account.configuration.id);
  deviceA = graph.account.admins[0]!;
  tree = generateArborID("tr");
  const reserved = snapshotAccountConfig({
    account: graph.account,
    trees: { version: 1, trees: {
      ...graph.trees.trees,
      [tree]: { kind: "shared-subtree", canonicalPath: "/~owner/self-sync", access: [] },
    } },
    devices: {
      ...graph.devices,
      [deviceA]: { ...graph.devices[deviceA]!, placements: {
        ...graph.devices[deviceA]!.placements,
        [tree]: { server: new URL(host.url).origin, path: treeA },
      } },
    },
  });
  await owner.submitUpdate(
    configuration.tree.id,
    { root: configuration.tree.ref, update: configuration.tree.update },
    reserved,
  );
  await owner.activateTree(tree, await snapshotDirectory(treeA));

  deviceB = generateArborID("dv");
  const pairing = await owner.createPairing();
  await owner.claimPairing(pairing.id, pairing.secret, {
    id: deviceB,
    label: "Self-sync peer",
    credentialDigest: `sha256:${sha256(tokenB)}`,
  }, { [tree]: { server: new URL(host.url).origin, path: treeB } });
  configuration = await owner.currentSnapshot(initialAccount.account.configuration.id);
  graph = readAccountConfigGraph({
    root: configuration.snapshot.root,
    objects: new Map(configuration.snapshot.objects.map(({ hash, bytes }) => [hash, bytes])),
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
    const source = note.document!.source.replace("Common", "From A");
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
        baseContentRevision: note.contentRevision!,
        source,
        sourceEdits: [{ offset: 2, length: 6, replacement: "From A", expected: "Common" }],
      });
      await waitFor(async () => updateBodies.some((body) => body.filePatches?.length === 1));
    } finally {
      globalThis.fetch = systemFetch;
    }
    const patchBody = updateBodies.find((body) => body.filePatches?.length === 1)!;
    expect(patchBody.returnSnapshot).toBe("if-result-differs");
    expect(patchBody.filePatches[0].edits).toEqual([
      { offset: 2, length: 6, bytes: Buffer.from("From A").toString("base64") },
    ]);
    expect(patchBody.objects).not.toContainEqual(expect.objectContaining({ hash: patchBody.filePatches[0].result }));
    await author.close();

    const reader = await launch(stateB, treeB);
    await waitFor(async () => (await readFile(join(treeB, "note.md"), "utf8")).includes("From A"));
    expect(await reader.client.node({ tree, path: "/note", stableKey: null }).then((node) => node.document?.bodySource)).toContain("From A");
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
        baseContentRevision: beforeFallback.contentRevision!,
        source: "# Complete-object fallback\n",
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(beforeFallback.document!.source),
          replacement: "# Complete-object fallback\n",
          expected: beforeFallback.document!.source,
        }],
      });
      await waitFor(async () => fallbackBodies.some((body) => Array.isArray(body.objects) && body.objects.length > 0));
    } finally {
      globalThis.fetch = fallbackFetch;
    }
    const fallbackBody = fallbackBodies.find((body) => Array.isArray(body.objects) && body.objects.length > 0)!;
    expect(fallbackBody.filePatches).toBeUndefined();
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
        baseContentRevision: before.contentRevision!,
        source: firstSource,
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(before.document!.source),
          replacement: firstSource,
          expected: before.document!.source,
        }],
      });
      await firstObserved;
      const afterFirst = await author.client.node({ tree, path: "/note", stableKey: null });
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: afterFirst.contentRevision!,
        source: secondSource,
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(afterFirst.document!.source),
          replacement: secondSource,
          expected: afterFirst.document!.source,
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

    expect(updateBodies[1].base.root).toBe(updateBodies[0].candidate);
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(secondSource);
    const after = await author.client.node({ tree, path: "/note", stableKey: null });
    const restoredSource = "# Complete-object fallback\n";
    await author.client.mutateContent({
      op: "writeMarkdown",
      ref: { tree, path: "/note", stableKey: null },
      baseContentRevision: after.contentRevision!,
      source: restoredSource,
      sourceEdits: [{
        offset: 0,
        length: Buffer.byteLength(after.document!.source),
        replacement: restoredSource,
        expected: after.document!.source,
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
    const offlineSource = offlineNode.document!.source.replace("Complete-object", "Locally durable");
    const savedOffline = await Promise.race([
      offline.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: offlineNode.contentRevision!,
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
});
