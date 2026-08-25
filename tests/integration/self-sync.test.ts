import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import { serveWireHost } from "@arbor/authority";
import { WireClient } from "@arbor/wire";

const token = "self-sync-owner";
let sandbox: string;
let hostState: string;
let host: Awaited<ReturnType<typeof serveWireHost>>;
let hostPort: number;
let stateA: string;
let stateB: string;
let treeA: string;
let treeB: string;
let bootstrapB: string;
let tree: string;

async function launch(state: string, path: string) {
  process.env.ARBOR_DATA_HOME = state;
  const running = await serveArbor(path, { port: 0 });
  const client = new ArbordClient({ baseURL: running.url, retryDelay: async () => {} });
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
  host = await serveWireHost({
    dataRoot: hostState,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  hostPort = host.server.port!;
});

afterAll(async () => {
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateA;
  const cleanup = await serveArbor(treeA, { port: 0 });
  await cleanup.service.communityConfig.remove();
  cleanup.server.stop(true);
  await cleanup.service[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("private self-sync", () => {
  test("places one TreeID in two isolated Arbor homes and pulls edits", async () => {
    const first = await launch(stateA, treeA);
    await first.client.mutateSystem({ op: "connectCommunity", origin: host.url, accountToken: token });
    expect((await first.client.communityDevices()).some((device) => device.revokedAt === null)).toBe(true);
    const pairing = await first.client.createCommunityPairing();
    const claimed = await new WireClient(host.url).claimPairing(pairing.id, pairing.secret, "self-sync test device");
    expect(claimed.device.label).toBe("self-sync test device");
    expect((await first.client.revokeCommunityDevice(claimed.device.id)).revokedAt).not.toBeNull();
    const promoted = await first.client.mutateSystem({
      op: "promoteTree",
      path: treeA,
      canonicalPath: "/~owner/self-sync",
      audience: { kind: "private" },
    });
    tree = promoted.effects.find((effect) => effect.tree?.startsWith("tr_"))!.tree!;
    await first.close();

    const second = await launch(stateB, bootstrapB);
    await second.client.mutateSystem({ op: "connectCommunity", origin: host.url, accountToken: token });
    await second.client.mutateSystem({ op: "placeTree", tree, path: treeB });
    expect(await readFile(join(treeB, "note.md"), "utf8")).toBe(await readFile(join(treeA, "note.md"), "utf8"));
    await second.close();

    const author = await launch(stateA, treeA);
    await waitFor(async () => (await author.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const note = await author.client.node({ tree, path: "/note" });
    const source = note.document!.source.replace("Common", "From A");
    const updateBodies: any[] = [];
    const systemFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/.arbor/trees/") && url.endsWith("/updates") && typeof init?.body === "string") {
        updateBodies.push(JSON.parse(init.body));
      }
      return systemFetch(input, init);
    }) as typeof fetch;
    try {
      await author.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note" },
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
    expect(await reader.client.node({ tree, path: "/note" }).then((node) => node.document?.bodySource)).toContain("From A");
    await reader.close();

    const fallback = await launch(stateA, treeA);
    await waitFor(async () => (await fallback.running.service.trees.descriptors())
      .find((descriptor) => descriptor.id === tree)?.sync === "idle");
    const beforeFallback = await fallback.client.node({ tree, path: "/note" });
    const fallbackBodies: any[] = [];
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/.arbor/trees/") && url.endsWith("/updates") && typeof init?.body === "string") {
        fallbackBodies.push(JSON.parse(init.body));
      }
      return fallbackFetch(input, init);
    }) as typeof fetch;
    try {
      await fallback.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note" },
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
    await fallback.close();
  });

  test("preserves both sides when devices diverge offline", async () => {
    const commonRef = host.authority.get(tree)!.ref;
    host.server.stop(true);
    await host.authority[Symbol.asyncDispose]();

    const offline = await launch(stateA, treeA);
    const offlineNode = await offline.client.node({ tree, path: "/note" });
    const offlineSource = offlineNode.document!.source.replace("Complete-object", "Locally durable");
    const savedOffline = await Promise.race([
      offline.client.mutateContent({
        op: "writeMarkdown",
        ref: { tree, path: "/note" },
        baseContentRevision: offlineNode.contentRevision!,
        source: offlineSource,
        sourceEdits: [{ offset: 2, length: 15, replacement: "Locally durable", expected: "Complete-object" }],
      }),
      Bun.sleep(1_000).then(() => { throw new Error("Local save waited for the unavailable authority"); }),
    ]);
    expect(savedOffline.effects[0]?.contentRevision).toBeDefined();
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe(offlineSource);
    await offline.close();

    await writeFile(join(treeA, "note.md"), "# Offline A\n");
    await writeFile(join(treeB, "note.md"), "# Offline B\n");

    host = await serveWireHost({
      dataRoot: hostState,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });

    const first = await launch(stateA, treeA);
    await waitFor(async () => host.authority.get(tree)?.ref !== commonRef);
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
    const beforeCommon = host.authority.currentUpdate(tree)!.id;
    await waitFor(async () => host.authority.currentUpdate(tree)!.id !== beforeCommon);
    await preparing.close();

    const receiving = await launch(stateB, treeB);
    await waitFor(async () => readFile(join(treeB, "sample.bin"), "utf8")
      .then((value) => value === "common-binary")
      .catch(() => false));
    await receiving.close();
    const historyBefore = host.authority.acceptedUpdates(tree).length;

    host.server.stop(true);
    await host.authority[Symbol.asyncDispose]();
    await writeFile(join(treeA, "sample.bin"), "binary-from-a");
    await writeFile(join(treeB, "sample.bin"), "binary-from-b");
    host = await serveWireHost({
      dataRoot: hostState,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });

    const winner = await launch(stateA, treeA);
    await waitFor(async () => host.authority.acceptedUpdates(tree).length === historyBefore + 1);
    await winner.close();

    const conflicted = await launch(stateB, treeB);
    await waitFor(async () => {
      const record = await conflicted.client.node({ tree: "system", path: `/trees/${tree}` });
      return record.document?.frontmatter.sync === "conflict"
        && Array.isArray(record.document.frontmatter.conflicts);
    });
    expect(await readFile(join(treeB, "sample.bin"), "utf8")).toBe("binary-from-b");
    expect(host.authority.acceptedUpdates(tree)).toHaveLength(historyBefore + 1);
    await conflicted.close();

    const restarted = await launch(stateB, treeB);
    await waitFor(async () => {
      const record = await restarted.client.node({ tree: "system", path: `/trees/${tree}` });
      return record.document?.frontmatter.conflictCandidate !== undefined;
    });
    await restarted.client.mutateSystem({ op: "resolveTreeConflict", tree, choice: "local" });
    await waitFor(async () => host.authority.acceptedUpdates(tree).length === historyBefore + 2);
    await restarted.close();

    const follower = await launch(stateA, treeA);
    await waitFor(async () => (await readFile(join(treeA, "sample.bin"), "utf8")) === "binary-from-b");
    expect(host.authority.acceptedUpdates(tree)).toHaveLength(historyBefore + 2);
    await follower.close();
  });
});
