import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborControl, serveWorkspace } from "@arbor/arbord";
import { ArbordClient, type MutationRequest, type WorkspaceEvent } from "@arbor/client";
import { canonicalJSONString, sha256 } from "@arbor/core";
import type { Workspace } from "@arbor/arbord";

let root: string;
let state: string;
let base: string;
let client: ArbordClient;
let close: () => Promise<void>;
let activeWorkspace: Workspace;
let durableWriteRequest: MutationRequest;
let durableWriteReceipt: Awaited<ReturnType<ArbordClient["mutate"]>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-server-"));
  state = await mkdtemp(join(tmpdir(), "arbor-server-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await writeFile(join(root, "page.md"), "Hello API\n");
  await writeFile(join(root, "target.md"), "---\nid: target\n---\nTarget\n");
  await writeFile(join(root, "source.md"), "---\nid: source\n---\nSee [Target](/target#target).\n");
  await writeFile(join(root, "duplicate-a.md"), "---\nid: duplicate-id\n---\nA\n");
  await writeFile(join(root, "duplicate-b.md"), "---\nid: duplicate-id\n---\nB\n");
  const running = await serveWorkspace(root, { port: 0 });
  activeWorkspace = running.workspace;
  base = running.url;
  client = new ArbordClient({ baseURL: base, retryDelay: async () => {} });
  close = async () => {
    running.server.stop(true);
    await running.workspace[Symbol.asyncDispose]();
  };
});

afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("arbord REST v1", () => {
  test("serves remote/account surfaces without a local browsing session", async () => {
    const running = await serveArborControl({ port: 0 });
    try {
      const controlClient = new ArbordClient({ baseURL: running.url });
      expect((await controlClient.node({ tree: "system", path: "/device" })).tree).toBe("system");
      const response = await fetch(`${running.url}/v1/node?path=%2F`);
      expect(response.status).toBe(409);
      expect((await response.json() as any).error.code).toBe("not-found");
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
    }
  });

  test("reads and idempotently writes a Markdown node", async () => {
    const node = await client.node({ path: "/page" });
    const blocks = structuredClone(node.document!.blocks);
    blocks[0]!.content = "Changed through REST v1";
    const request: MutationRequest = {
      mutationID: "write-page-1",
      operations: [{
        op: "writeMarkdown",
        ref: { path: "/page" },
        baseContentRevision: node.contentRevision!,
        blocks,
      }],
    };
    const first = await client.mutate(request);
    const retry = await client.mutate(request);
    expect(retry).toEqual(first);
    const saved = await client.node({ path: "/page" });
    expect(saved.document?.frontmatter.id).toMatch(/^[a-z0-9]{6}$/);
    expect(saved.document?.bodySource).toContain("Changed through REST v1");
    durableWriteRequest = request;
    durableWriteReceipt = first;
  });

  test("rejects mutation ID reuse with changed intent", async () => {
    await expect(client.mutate({
      mutationID: "write-page-1",
      operations: [{ op: "createDirectory", path: "/wrong" }],
    })).rejects.toMatchObject({
      status: 409,
      value: { code: "mutation-mismatch" },
    });
  });

  test("rejects malformed and empty mutation batches at the protocol boundary", async () => {
    const fixture = JSON.parse(await readFile(
      join(import.meta.dir, "../fixtures/protocol/malformed-mutation.json"),
      "utf8",
    ));
    for (const body of [
      fixture,
      { mutationID: "bad-ref", operations: [{ op: "rename", ref: { path: "/renamed", pageID: "both" }, name: "nope" }] },
      { mutationID: "bad-move", operations: [{ op: "move", refs: [], destination: { path: "/" } }] },
    ]) {
      const response = await fetch(`${base}/v1/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe("invalid-reference");
    }
    const unsupported = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationID: "future-op", operations: [{ op: "future" }] }),
    });
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json() as any).error.code).toBe("unsupported-operation");
  });

  test("resolves renamed Markdown pages by opaque page ID", async () => {
    const before = await client.node({ path: "/page" });
    await client.mutateStructural([{ op: "rename", ref: { pageID: before.ref.pageID!, pathHint: "/page" }, name: "renamed" }], "rename-page");
    const after = await client.node({ pageID: before.ref.pageID!, pathHint: "/page" });
    expect(after.path).toBe("/renamed");
  });

  test("reports duplicate page IDs deterministically", async () => {
    await expect(client.node({ pageID: "duplicate-id" })).rejects.toMatchObject({
      status: 409,
      value: {
        code: "duplicate-page-id",
        owners: ["/duplicate-a", "/duplicate-b"],
      },
    });
  });

  test("returns indexed backlinks by path or durable target identity", async () => {
    const byPath = await client.backlinks({ path: "/target" });
    expect(byPath.target.pageID).toBe("target");
    expect(byPath.entries).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ path: "/source", pageID: "source" }),
        title: "source",
        context: "See [Target](/target#target).",
      }),
    ]);
    const byID = await client.backlinks({ pageID: "target", pathHint: "/stale" });
    expect(byID.entries).toEqual(byPath.entries);
  });

  test("commits structural batches atomically and exposes directory conflicts", async () => {
    const receipt = await client.mutateStructural([
      { op: "createDirectory", path: "/folder" },
      { op: "createMarkdown", path: "/other" },
    ], "create-batch");
    expect(receipt.effects.filter((effect) => effect.kind === "created").map((effect) => effect.path)).toEqual(["/folder", "/other"]);

    const directory = await client.node({ path: "/" });
    await expect(client.mutateStructural([{
      op: "move",
      refs: [{ path: "/other" }],
      destination: { path: "/" },
      beforeBlockID: "vanished-block",
      baseDirectoryRevision: directory.directoryRevision,
    }], "missing-anchor")).rejects.toMatchObject({
      status: 409,
      value: {
        code: "missing-insertion-anchor",
        anchor: { beforeBlockID: "vanished-block" },
      },
    });
    expect((await client.node({ path: "/other" })).path).toBe("/other");

    await expect(client.mutateStructural([{
      op: "move",
      refs: [{ path: "/other" }],
      destination: { path: "/" },
      beforePath: "/folder",
      baseDirectoryRevision: "sha256:stale-directory",
    }], "stale-directory")).rejects.toMatchObject({
      status: 409,
      value: { code: "stale-directory-revision" },
    });
  });

  test("rejects mixed and multiple-content batches before recording intent", async () => {
    const before = await client.node({ path: "/renamed" });
    const blocks = structuredClone(before.document!.blocks);
    blocks[0]!.content = "Must not materialize";
    const content = {
      op: "writeMarkdown",
      ref: { pageID: before.ref.pageID!, pathHint: "/renamed" },
      baseContentRevision: before.contentRevision!,
      blocks,
    };
    const mixedFixture = JSON.parse(await readFile(
      join(import.meta.dir, "../fixtures/protocol/mixed-mutation.json"),
      "utf8",
    ));
    mixedFixture.operations[0].ref = { pageID: before.ref.pageID!, pathHint: "/renamed" };
    mixedFixture.operations[0].baseContentRevision = before.contentRevision!;
    mixedFixture.operations[0].blocks = blocks;
    mixedFixture.operations[1].path = "/mixed-success";
    for (const [mutationID, operations] of [
      [mixedFixture.mutationID, mixedFixture.operations],
      ["multiple-content", [content, {
        op: "writeMarkdown",
        ref: { pageID: before.ref.pageID!, pathHint: "/renamed" },
        baseContentRevision: before.contentRevision!,
        blocks,
      }]],
    ] as const) {
      const response = await fetch(`${base}/v1/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mutationID, operations }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported-operation" },
      });
    }
    expect((await client.node({ path: "/renamed" })).contentRevision).toBe(before.contentRevision);
    await expect(client.node({ path: "/mixed-success" })).rejects.toMatchObject({ status: 404 });
    expect((await client.search("Must not materialize")).results).toHaveLength(0);
    expect(() => client.prepareStructuralMutation([])).toThrow("at least one operation");
  });

  test("retries a lost mutation response with the same request", async () => {
    let dropped = false;
    const lossy = new ArbordClient({
      baseURL: base,
      retryDelay: async () => {},
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!dropped && String(input).endsWith("/v1/mutations") && init?.method === "POST") {
          dropped = true;
          await response.arrayBuffer();
          throw new TypeError("simulated lost response");
        }
        return response;
      },
    });
    const receipt = await lossy.mutateStructural([{ op: "createDirectory", path: "/after-loss" }], "lost-response");
    expect(receipt.mutationID).toBe("lost-response");
    expect((await client.node({ path: "/after-loss" })).path).toBe("/after-loss");
  });

  test("replays events after a snapshot cursor and rejects another epoch", async () => {
    const snapshot = await client.node({ path: "/" });
    await client.mutateStructural([{ op: "createDirectory", path: "/eventful" }], "eventful");
    const abort = new AbortController();
    let replayed: WorkspaceEvent | null = null;
    for await (const event of client.observe(snapshot.observedThrough, abort.signal)) {
      if (event.mutationID === "eventful") {
        replayed = event;
        abort.abort();
        break;
      }
    }
    expect(replayed?.path).toBe("/eventful");

    await expect(fetch(`${base}/v1/events?after=${encodeURIComponent(`another-epoch:0`)}`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }))).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "resync-required" } },
    });
  });

  test("buffers observed-view events while visible children are still loading", async () => {
    let markChildrenStarted!: () => void;
    let releaseChildren!: () => void;
    const childrenStarted = new Promise<void>((resolve) => { markChildrenStarted = resolve; });
    const childrenReleased = new Promise<void>((resolve) => { releaseChildren = resolve; });
    const observing = new ArbordClient({
      baseURL: base,
      retryDelay: async () => {},
      fetch: async (input, init) => {
        if (String(input).includes("/v1/children?")) {
          markChildrenStarted();
          await childrenReleased;
        }
        return fetch(input, init);
      },
    });
    const viewPromise = observing.openNodeView({ path: "/" });
    await childrenStarted;
    await client.mutateStructural([{ op: "createDirectory", path: "/during-view-load" }], "during-view-load");
    releaseChildren();
    const view = await viewPromise;
    try {
      for await (const update of view.updates) {
        if (update.kind === "event" && update.event.mutationID === "during-view-load") {
          expect(update.event.path).toBe("/during-view-load");
          break;
        }
      }
    } finally {
      view.close();
    }
  });

  test("observed views turn resync-required into a refreshed snapshot", async () => {
    let rejectFirstObservation = true;
    const observing = new ArbordClient({
      baseURL: base,
      retryDelay: async () => {},
      fetch: async (input, init) => {
        if (rejectFirstObservation && String(input).includes("/v1/events?")) {
          rejectFirstObservation = false;
          return Response.json({
            error: {
              code: "resync-required",
              message: "synthetic expired cursor",
              retryable: true,
            },
          }, { status: 409 });
        }
        return fetch(input, init);
      },
    });
    const view = await observing.openNodeView({ path: "/renamed" });
    try {
      for await (const update of view.updates) {
        if (update.kind === "resync") {
          expect(update.snapshot.path).toBe("/renamed");
          expect(update.snapshot.observedThrough).toContain(":");
          break;
        }
      }
    } finally {
      view.close();
    }
  });

  test("imports a multipart directory manifest atomically", async () => {
    const receipt = await client.import({ path: "/folder" }, [
      { path: "drop", kind: "directory" },
      { path: "drop/readme.md", kind: "file", file: new File(["Imported\n"], "readme.md", { type: "text/markdown" }) },
    ], "import-drop");
    expect(receipt.effects.some((effect) => effect.path === "/folder/drop")).toBe(true);
    expect((await client.node({ path: "/folder/drop/readme" })).document?.bodySource).toBe("Imported\n");
  });

  test("retries an asset transfer with the same mutation identity", async () => {
    let dropped = false;
    const lossy = new ArbordClient({
      baseURL: base,
      retryDelay: async () => {},
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!dropped && String(input).endsWith("/v1/assets") && init?.method === "POST") {
          dropped = true;
          await response.arrayBuffer();
          throw new TypeError("simulated lost asset response");
        }
        return response;
      },
    });
    const file = new File(["asset bytes"], "diagram.txt", { type: "text/plain" });
    const first = await lossy.asset({ path: "/folder" }, file, "asset-after-loss");
    const retry = await client.asset({ path: "/folder" }, file, "asset-after-loss");
    expect(retry.receipt).toEqual(first.receipt);
    expect((await client.node({ path: first.path })).kind).toBe("file");
  });

  test("covers copy, trash, restore, and recovery restoration through logical operations", async () => {
    const copied = await client.mutateStructural([{
      op: "copy",
      refs: [{ path: "/renamed" }],
      destination: { path: "/folder" },
    }], "copy-page");
    const copyPath = copied.effects.find((effect) => effect.kind === "created")!.path;
    const copiedNode = await client.node({ path: copyPath });
    expect(copiedNode.kind).toBe("markdown");
    expect(copiedNode.ref.pageID).not.toBe((await client.node({ path: "/renamed" })).ref.pageID);

    const trashed = await client.mutateStructural([{ op: "trash", refs: [{ path: copyPath }] }], "trash-copy");
    const trashPath = `/Trash${copyPath}`;
    expect(trashed.effects).toContainEqual(expect.objectContaining({ kind: "deleted", path: copyPath }));
    await expect(client.node({ path: copyPath })).rejects.toMatchObject({ status: 404 });
    const restored = await client.mutateStructural([{ op: "restore", refs: [{ path: trashPath }] }], "restore-copy");
    expect((await client.node({ path: restored.effects[0]!.path })).kind).toBe("markdown");

    const before = await client.node({ path: "/renamed" });
    const pageRef = { pageID: before.ref.pageID!, pathHint: before.path };
    const recoveryBlocks = structuredClone(before.document!.blocks);
    recoveryBlocks[0]!.content = "Recovery source";
    await client.mutateContent({
      op: "writeMarkdown",
      ref: pageRef,
      baseContentRevision: before.contentRevision!,
      blocks: recoveryBlocks,
    }, "recovery-source");
    const recoverySource = await client.node(pageRef);
    await client.mutateContent({
      op: "writeMarkdown",
      ref: pageRef,
      baseContentRevision: recoverySource.contentRevision!,
      blocks: [],
    }, "purge-for-recovery");
    const empty = await client.node(pageRef);
    const recovery = await client.recovery(pageRef);
    const entry = recovery.entries.find(
      (candidate) => candidate.kind === "block" && candidate.markdown.includes("Recovery source"),
    );
    expect(entry).toBeDefined();
    if (!entry || entry.kind !== "block") throw new Error("Expected a block recovery entry");
    await client.mutateContent({
      op: "restoreRecovery",
      ref: pageRef,
      hash: entry.hash,
      baseContentRevision: empty.contentRevision,
    }, "restore-recovery");
    expect((await client.node(pageRef)).document?.bodySource).toContain("Recovery source");

    await client.mutateStructural([{ op: "createMarkdown", path: "/discarded" }], "create-discarded");
    await client.mutateStructural([{ op: "trash", refs: [{ path: "/discarded" }] }], "trash-discarded");
    const subtree = await client.recovery({ path: "/" }, { recursive: true });
    expect(subtree.entries).toContainEqual(expect.objectContaining({
      kind: "block",
      ref: expect.objectContaining({ path: "/renamed" }),
    }));
    expect(subtree.entries).toContainEqual(expect.objectContaining({
      kind: "trash",
      ref: expect.objectContaining({ path: "/Trash/discarded" }),
      originalPath: "/discarded",
    }));
  });

  test("removes the unversioned API and serves the TreeHopper shell", async () => {
    const legacy = await fetch(`${base}/v/tree/renamed`);
    expect(legacy.status).toBe(405);
    expect((await legacy.json() as any).error.code).toBe("unsupported-operation");

    const shell = await fetch(`${base}/render/renamed`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
  });

  test("serves ordinary-file bytes at OS-shaped logical routes with ETag, range, and ?raw", async () => {
    const bytes = new TextEncoder().encode("PNGDATA-0123456789");
    await writeFile(join(root, "photo.png"), bytes);
    await writeFile(join(root, "rawdoc.md"), "Raw surface\n");

    const direct = await fetch(`${base}${root}/photo.png`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(bytes);
    const etag = direct.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);

    const conditional = await fetch(`${base}${root}/photo.png`, { headers: { "if-none-match": etag } });
    expect(conditional.status).toBe(304);

    const range = await fetch(`${base}${root}/photo.png`, { headers: { range: "bytes=3-6" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 3-6/${bytes.byteLength}`);
    expect(await range.text()).toBe("DATA");

    // The /render spelling serves the same bytes so authored relative
    // references keep resolving under the app's route prefix.
    const prefixed = await fetch(`${base}/render${root}/photo.png`);
    expect(prefixed.status).toBe(200);
    expect(prefixed.headers.get("etag")).toBe(etag);

    // Document-shaped routes stay on the browsing surface unless ?raw.
    const app = await fetch(`${base}/render${root}/rawdoc`);
    expect(app.headers.get("content-type")).toContain("text/html");
    const raw = await fetch(`${base}${root}/rawdoc?raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("Raw surface");
  });

  test("asset receipts carry the tree-rooted markdown destination", async () => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ mutationID: "asset-rooted-1", directory: { path: "/" } }));
    form.set("file", new File([new TextEncoder().encode("img")], "leaf.png", { type: "image/png" }));
    const response = await fetch(`${base}/v1/assets`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json() as { path: string; markdownPath: string };
    expect(result.markdownPath).toBe(result.path);
    expect(result.markdownPath).toStartWith("/Assets/");

    // The stored spelling stays tree-rooted; fetching bytes uses the
    // OS-shaped route through the owning root.
    const served = await fetch(`${base}${root}${result.path}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("img");
  });

  test("returns the durable original receipt after an arbord restart", async () => {
    await client.mutateStructural([{ op: "createDirectory", path: "/recovered-effect" }], "materialization-setup");
    const recoveredRequest: MutationRequest = {
      mutationID: "materialized-before-crash",
      operations: [{ op: "createDirectory", path: "/recovered-effect" }],
    };
    const recoveredHash = sha256(canonicalJSONString(recoveredRequest));
    await activeWorkspace.mutations.prepare(recoveredRequest.mutationID, recoveredHash, recoveredRequest);
    await activeWorkspace.mutations.markMaterialized(recoveredRequest.mutationID, recoveredHash, [{
      kind: "created",
      path: "/recovered-effect",
    }]);
    const written = await client.node({ path: "/renamed" });
    const recoveredWriteRequest: MutationRequest = {
      mutationID: "write-replaced-before-receipt",
      operations: [{
        op: "writeMarkdown",
        ref: { pageID: written.ref.pageID!, pathHint: "/renamed" },
        baseContentRevision: "sha256:pre-crash-base",
        blocks: written.document!.blocks,
      }],
    };
    const recoveredWriteHash = sha256(canonicalJSONString(recoveredWriteRequest));
    await activeWorkspace.mutations.prepare(recoveredWriteRequest.mutationID, recoveredWriteHash, recoveredWriteRequest);
    await activeWorkspace.mutations.markExpected(recoveredWriteRequest.mutationID, recoveredWriteHash, [{
      kind: "updated",
      path: "/renamed",
      pageID: written.ref.pageID,
      contentRevision: written.contentRevision,
    }]);

    await close();
    const restarted = await serveWorkspace(root, { port: 0 });
    activeWorkspace = restarted.workspace;
    base = restarted.url;
    client = new ArbordClient({ baseURL: base, retryDelay: async () => {} });
    close = async () => {
      restarted.server.stop(true);
      await restarted.workspace[Symbol.asyncDispose]();
    };

    expect(await client.mutate(durableWriteRequest)).toEqual(durableWriteReceipt);
    expect((await client.mutate(recoveredRequest)).effects).toEqual([{ kind: "created", path: "/recovered-effect", tree: activeWorkspace.tree }]);
    expect((await client.mutate(recoveredWriteRequest)).effects).toMatchObject([{
      kind: "updated",
      path: "/renamed",
      contentRevision: written.contentRevision,
    }]);
    const oldCursor = durableWriteReceipt.eventCursor;
    const response = await fetch(`${base}/v1/events?after=${encodeURIComponent(oldCursor)}`);
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe("resync-required");
  });
});
