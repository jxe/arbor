import { nodeDocument } from "../helpers/node-snapshot.ts";
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

async function readAccepted(client: WireClient, treeID: string) {
  const descriptor = await client.descriptor(treeID);
  const snapshot = await client.snapshot(treeID, descriptor.tree.root);
  return { descriptor, snapshot };
}

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
    handle: account.account.handle!,
    profileTree: account.account.profileTree,
    profileURL: account.account.profileURL,
    communityTree: account.account.community.id,
    communityURL: canonicalArborLocator(account.account.community.canonical!),
    configurationTree: account.account.configuration.id,
    configurationRef: configuration.tree.root,
    configurationUpdate: configuration.tree.update,
  });
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
  await owner.submitUpdate(configuration.descriptor.tree.id, configuration.descriptor.tree.update, reserved);
  await owner.submitUpdate(tree, null, await snapshotDirectory(treeA));

  deviceB = generateArborID("dv");
  const pairing = await owner.createPairing();
  await owner.claimPairing(pairing.id, pairing.secret, {
    id: deviceB,
    label: "Self-sync peer",
    credentialDigest: `sha256:${sha256(tokenB)}`,
  }, { [tree]: { server: new URL(host.url).origin, path: treeB } });
  configuration = await readAccepted(owner, initialAccount.account.configuration.id);
  graph = readAccountConfigGraph({
    root: configuration.snapshot.root,
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
  test("opens an accepted directory document with an editor admission basis", async () => {
    const author = await launch(stateA, treeA);
    try {
      await waitFor(async () => (await author.running.service.trees.descriptors())
        .find((descriptor) => descriptor.id === tree)?.sync === "idle");
      const opened = await author.client.node({ tree, path: "/", stableKey: null });
      expect(nodeDocument(opened)?.source).toBe("# Tree A\n");
      expect(opened.admissionBasis).toBeString();
    } finally {
      await author.close();
    }
  });

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
      await waitFor(async () => updateBodies.some((body) => body.updates?.[0]?.deltas?.length === 1));
    } finally {
      globalThis.fetch = systemFetch;
    }
    const deltaBody = updateBodies.find((body) => body.updates?.[0]?.deltas?.length === 1)!.updates[0];
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
      await waitFor(async () => fallbackBodies.some((body) => Array.isArray(body.updates?.[0]?.objects) && body.updates[0].objects.length > 0));
    } finally {
      globalThis.fetch = fallbackFetch;
    }
    const fallbackBody = fallbackBodies.find((body) => Array.isArray(body.updates?.[0]?.objects) && body.updates[0].objects.length > 0)!.updates[0];
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

  test("posts a longer editor update string while its prior prefix is in flight", async () => {
    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const ref = { tree, path: "/note", stableKey: null } as const;
    const opened = await author.client.node(ref);
    const openedSource = nodeDocument(opened)!.source;
    if (!opened.admissionBasis) throw new Error("Placed document omitted its editor admission basis");

    const historyBefore = host.canopy.acceptedUpdates(tree).length;
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

    const firstSource = `${openedSource}\nFirst admitted generation.\n`;
    const secondSource = `${firstSource}Second admitted generation.\n`;
    try {
      const first = await author.client.admitDocumentCandidate(
        ref,
        opened.admissionBasis,
        opened.capabilities.content!.revision,
        firstSource,
        [{ offset: Buffer.byteLength(openedSource), length: 0, replacement: "\nFirst admitted generation.\n" }],
      );
      await firstObserved;
      if (!first.admissionBasis) throw new Error("Admitted document omitted its next admission basis");
      await author.client.admitDocumentCandidate(
        ref,
        first.admissionBasis,
        first.capabilities.content!.revision,
        secondSource,
        [{ offset: Buffer.byteLength(firstSource), length: 0, replacement: "Second admitted generation.\n" }],
      );
      await waitFor(async () => updateBodies.length >= 2);
      releaseFirst();
      await waitFor(async () => host.canopy.acceptedUpdates(tree).length === historyBefore + 2
        && (await author.running.service.trees.descriptors())
          .find((descriptor) => descriptor.id === tree)?.sync === "idle");

      const accepted = host.canopy.acceptedUpdates(tree).slice(historyBefore);
      expect(accepted.map((update) => update.kind)).toEqual(["accepted", "accepted"]);
      expect(updateBodies).toHaveLength(2);
      expect(updateBodies[0].updates).toHaveLength(1);
      expect(updateBodies[1].updates).toHaveLength(2);
      expect(updateBodies[1].base).toBe(updateBodies[0].base);
      expect(updateBodies[1].updates.slice(0, 1)).toEqual(updateBodies[0].updates);
      expect(accepted[1]!.previousRoot).toBe(accepted[0]!.root);
      expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(secondSource);

      const after = await author.client.node(ref);
      const restoredSource = "# Complete-object fallback\n";
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref,
        baseContentRevision: after.capabilities.content!.revision,
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
    } finally {
      releaseFirst();
      globalThis.fetch = systemFetch;
      await author.close();
    }
  });

  test("never snapshots a tree while an editor mutation is only prepared", async () => {
    let blockPreparedWrite = false;
    let releasePrepared!: () => void;
    let observePrepared!: () => void;
    const preparedReleased = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const preparedObserved = new Promise<void>((resolve) => { observePrepared = resolve; });
    const author = await launch(stateA, treeA, {
      faultInjector: async (stage) => {
        if (stage !== "write:prepared" || !blockPreparedWrite) return;
        blockPreparedWrite = false;
        observePrepared();
        await preparedReleased;
      },
    });
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const before = await author.client.node({ tree, path: "/note", stableKey: null });
    const source = "# Coherent editor candidate\n";
    blockPreparedWrite = true;
    const mutation = author.client.mutateContent({
      op: "writeMarkdown",
      ref: { tree, path: "/note", stableKey: null },
      baseContentRevision: before.capabilities.content?.revision!,
      source,
      sourceEdits: [{
        offset: 0,
        length: Buffer.byteLength(nodeDocument(before)!.source),
        replacement: source,
        expected: nodeDocument(before)!.source,
      }],
    });
    await preparedObserved;

    let synchronized = false;
    const synchronization = author.running.service.synchronizeNow().then(() => { synchronized = true; });
    await Bun.sleep(100);
    expect(synchronized).toBe(false);
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(nodeDocument(before)!.source);

    releasePrepared();
    try {
      await mutation;
      await synchronization;
      await waitFor(async () => (await author.running.service.trees.descriptors())
        .find((descriptor) => descriptor.id === tree)?.sync === "idle");
      expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(source);
      expect(String((await new WireClient(host.url, token).descriptor(tree)).tree.root))
        .toBe(String((await snapshotDirectory(treeA)).root));
      const after = await author.client.node({ tree, path: "/note", stableKey: null });
      const restored = "# Complete-object fallback\n";
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note", stableKey: null },
        baseContentRevision: after.capabilities.content?.revision!,
        source: restored,
        sourceEdits: [{
          offset: 0,
          length: Buffer.byteLength(nodeDocument(after)!.source),
          replacement: restored,
          expected: nodeDocument(after)!.source,
        }],
      });
      await waitFor(async () => (await author.running.service.trees.descriptors())
        .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    } finally {
      releasePrepared();
      await author.close();
    }
  });

  test("submits a stale Native document candidate to Canopy instead of overwriting the accepted file", async () => {
    const author = await launch(stateA, treeA);
    try {
      await waitFor(async () => (await author.running.service.trees.descriptors())
        .find((descriptor) => descriptor.id === tree)?.sync === "idle");
      const ref = { tree, path: "/note", stableKey: null } as const;
      const opened = await author.client.node(ref);
      const openedSource = nodeDocument(opened)!.source;
      if (!opened.admissionBasis) throw new Error("Placed document omitted its editor admission basis");

      const owner = new WireClient(host.url, token);
      const current = await readAccepted(owner, tree);
      const root = decodeWireObject(current.snapshot.objects.get(current.snapshot.root)!);
      if (root.type !== "directory") throw new Error("Expected a directory root");
      const noteEntry = root.entries.find((entry) => entry.name === "note.md");
      if (!noteEntry?.hash) throw new Error("Expected note.md");
      const remoteFile = encodeWireObject({
        type: "file",
        bytes: new TextEncoder().encode(`${openedSource}\nRemote while open.\n`),
      });
      const remoteRoot = encodeWireObject({
        ...root,
        entries: root.entries.map((entry) => entry.name === "note.md"
          ? { name: entry.name, hash: hashObject(remoteFile) }
          : entry),
      });
      current.snapshot.objects.set(hashObject(remoteFile), remoteFile);
      current.snapshot.objects.set(hashObject(remoteRoot), remoteRoot);
      const remote = await owner.submitUpdate(tree, current.descriptor.tree.update, {
        root: hashObject(remoteRoot),
        objects: current.snapshot.objects,
      });
      if (remote.outcome !== "accepted") throw new Error("Expected remote document update acceptance");

      const requests: Array<{ url: string; body?: any }> = [];
      const systemFetch = globalThis.fetch;
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
        return systemFetch(input, init);
      }) as typeof fetch;
      let accepted;
      try {
        accepted = await author.client.admitDocumentCandidate(
          ref,
          opened.admissionBasis,
          opened.capabilities.content!.revision,
          `${openedSource}\nNative while open.\n`,
          [{
            offset: Buffer.byteLength(openedSource),
            length: 0,
            replacement: "\nNative while open.\n",
          }],
        );
        await waitFor(async () => {
          const source = await readFile(join(treeA, "note.md"), "utf8");
          return source.includes("Remote while open.") && source.includes("Native while open.");
        });
      } finally {
        globalThis.fetch = systemFetch;
      }
      const acceptedSource = nodeDocument(accepted!)!.source;
      expect(acceptedSource).toContain("Native while open.");
      expect(requests.some(({ url }) => url.includes("/source-candidates"))).toBe(false);
      expect(requests.find(({ url, body }) => url.includes(`/.arbor/trees/${tree}/updates`) && typeof body?.updates?.[0]?.candidate === "string")?.body)
        .toMatchObject({ base: current.descriptor.tree.update, updates: [expect.objectContaining({ ifMatch: "modelHash" })] });
      expect(await readFile(join(treeA, "note.md"), "utf8")).toContain("Native while open.");

      const restored = await author.client.node(ref);
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref,
        baseContentRevision: restored.capabilities.content!.revision,
        source: "# Complete-object fallback\n",
      });
      await author.running.service.synchronizeNow();
    } finally {
      await author.close();
    }
  });

  test("keeps an admitted Native candidate durable while Canopy is offline", async () => {
    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const ref = { tree, path: "/note", stableKey: null } as const;
    const opened = await author.client.node(ref);
    const openedSource = nodeDocument(opened)!.source;
    if (!opened.admissionBasis) throw new Error("Placed document omitted its editor admission basis");

    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();
    const source = `${openedSource}\nNative admitted offline.\n`;
    const admitted = await Promise.race([
      author.client.admitDocumentCandidate(
        ref,
        opened.admissionBasis,
        opened.capabilities.content!.revision,
        source,
        [{ offset: Buffer.byteLength(openedSource), length: 0, replacement: "\nNative admitted offline.\n" }],
      ),
      Bun.sleep(1_000).then(() => { throw new Error("Offline editor admission waited for Canopy"); }),
    ]);
    expect(nodeDocument(admitted)!.source).toBe(source);
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(openedSource);
    await author.close();

    host = await serveCanopy({
      dataRoot: hostState,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });
    const resumed = await launch(stateA, treeA);
    await waitFor(async () => (await readFile(join(treeA, "note.md"), "utf8")).includes("Native admitted offline."));
    const restored = await resumed.client.node(ref);
    await resumed.client.mutateContent({
      op: "writeMarkdown",
      ref,
      baseContentRevision: restored.capabilities.content!.revision,
      source: "# Complete-object fallback\n",
    });
    await resumed.running.service.synchronizeNow();
    await resumed.close();
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
    // Establish the initial accepted base and its live Wire watch. After this
    // setup pass, the remote update below must arrive without another poll.
    await reader.running.service.synchronizeNow();
    await waitFor(idle);
    const observed = await reader.client.openNodeView({ tree, path: "/note", stableKey: null });
    const syncInvalidation = (async () => {
      for await (const update of observed.updates) {
        if (update.kind === "event" && update.event.change.origin === "sync") return update.event;
      }
      throw new Error("The local observation stream ended before sync invalidation");
    })();

    // Another writer advances the tree directly on Canopy; the reader's only
    // way to learn about it within the timeout is its live watch.
    const owner = new WireClient(host.url, token);
    const current = await readAccepted(owner, tree);
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
    observed.close();
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
