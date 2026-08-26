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
let scope: string;
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
  scope = activeWorkspace.tree;
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
      expect((await controlClient.node({ tree: "system", path: "/diagnostics" })).tree).toBe("system");
      const response = await fetch(`${running.url}/v1/node?path=%2F`);
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("invalid-request");
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
    }
  });

  test("reads and idempotently writes a Markdown node", async () => {
    const node = await client.node({ tree: scope, path: "/page" });
    const source = node.document!.source.replace("Hello API", "Changed through REST v1");
    const request: MutationRequest = {
      mutationID: "write-page-1",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: scope, path: "/page" },
        baseContentRevision: node.contentRevision!,
        source,
      }],
    };
    const first = await client.mutate(request);
    const retry = await client.mutate(request);
    expect(retry).toEqual(first);
    const saved = await client.node({ tree: scope, path: "/page" });
    expect(saved.document?.source).toBe(source);
    expect(saved.document?.bodySource).toContain("Changed through REST v1");
    durableWriteRequest = request;
    durableWriteReceipt = first;
  });

  test("rejects mutation ID reuse with changed intent", async () => {
    await expect(client.mutate({
      mutationID: "write-page-1",
      operations: [{ op: "createDirectory", tree: scope, path: "/wrong" }],
    })).rejects.toThrow("already used for a different request");
  });

  test("verifies guarded UTF-8 source edits before recording a content intent", async () => {
    const before = await client.node({ tree: scope, path: "/page" });
    const original = before.document!.source;
    const originalBytes = Buffer.from(original);
    const target = Buffer.from("REST");
    const offset = originalBytes.indexOf(target);
    expect(offset).toBeGreaterThanOrEqual(0);
    const source = original.replace("REST", "UTF-8 🌳");
    const edit = { offset, length: target.length, replacement: "UTF-8 🌳", expected: "REST" };

    await expect(client.mutate({
      mutationID: "bad-source-edit-result",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: scope, path: "/page" },
        baseContentRevision: before.contentRevision!,
        source: `${source}wrong`,
        sourceEdits: [edit],
      }],
    })).rejects.toThrow("sourceEdits do not produce");
    expect((await client.node({ tree: scope, path: "/page" })).document?.source).toBe(original);

    await client.mutate({
      mutationID: "valid-source-edit",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: scope, path: "/page" },
        baseContentRevision: before.contentRevision!,
        source,
        sourceEdits: [edit],
      }],
    });
    expect((await client.node({ tree: scope, path: "/page" })).document?.source).toBe(source);
  });

  test("rejects malformed and empty mutation batches at the protocol boundary", async () => {
    const fixture = JSON.parse(await readFile(
      join(import.meta.dir, "../fixtures/arbord/malformed-mutation.json"),
      "utf8",
    ));
    for (const body of [
      fixture,
      { mutationID: "old-write-shape", operations: [{ op: "writeMarkdown", ref: { path: "/page" }, baseContentRevision: "sha256:old", blocks: [] }] },
      { mutationID: "bad-ref", operations: [{ op: "rename", ref: { path: "/renamed", pageID: "both" }, name: "nope" }] },
      { mutationID: "bad-move", operations: [{ op: "move", refs: [], destination: { path: "/" } }] },
      { mutationID: "bad-source-edits", operations: [{ op: "writeMarkdown", ref: { path: "/page" }, baseContentRevision: "sha256:old", source: "x", sourceEdits: [] }] },
      { mutationID: "overlapping-source-edits", operations: [{ op: "writeMarkdown", ref: { path: "/page" }, baseContentRevision: "sha256:old", source: "x", sourceEdits: [{ offset: 2, length: 2, replacement: "a" }, { offset: 3, length: 1, replacement: "b" }] }] },
    ]) {
      const response = await fetch(`${base}/v1/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error).toBe("invalid-request");
    }
    const unsupported = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationID: "future-op", operations: [{ op: "future" }] }),
    });
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json() as any).error).toBe("unsupported-operation");
  });

  test("resolves renamed Markdown pages by opaque page ID", async () => {
    await client.mutateStructural([{ op: "rename", ref: { tree: scope, path: "/page" }, name: "renamed" }], "rename-page");
    const renamed = await client.node({ tree: scope, path: "/renamed" });
    const after = await client.node({ tree: scope, pageID: renamed.ref.pageID!, pathHint: "/page" });
    expect(after.path).toBe("/renamed");
  });

  test("reports duplicate page IDs deterministically", async () => {
    await expect(client.node({ tree: scope, pageID: "duplicate-id" })).rejects.toThrow("multiple owners");
  });

  test("returns indexed backlinks by path or durable target identity", async () => {
    const byPath = await client.backlinks({ tree: scope, path: "/target" });
    expect(byPath.target.pageID).toBe("target");
    expect(byPath.entries).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ path: "/source", pageID: "source" }),
        title: "source",
        context: "See [Target](/target#target).",
      }),
    ]);
    const byID = await client.backlinks({ tree: scope, pageID: "target", pathHint: "/stale" });
    expect(byID.entries).toEqual(byPath.entries);
  });

  test("commits structural batches atomically and rejects obsolete ordering fields", async () => {
    const receipt = await client.mutateStructural([
      { op: "createDirectory", tree: scope, path: "/folder" },
      { op: "createMarkdown", tree: scope, path: "/other" },
    ], "create-batch");
    expect(receipt.effects.filter((effect) => effect.kind === "created").map((effect) => effect.path)).toEqual(["/folder", "/other"]);

    const response = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "obsolete-ordering",
        operations: [{
          op: "move",
          refs: [{ path: "/other" }],
          destination: { path: "/" },
          beforeBlockID: "vanished-block",
        }],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid-request" });
  });

  test("rejects mixed and multiple-content batches before recording intent", async () => {
    const before = await client.node({ tree: scope, path: "/renamed" });
    const source = before.document!.source.replace(before.document!.bodySource, "Must not materialize\n");
    const content = {
      op: "writeMarkdown",
      ref: { tree: scope, pageID: before.ref.pageID!, pathHint: "/renamed" },
      baseContentRevision: before.contentRevision!,
      source,
    };
    const mixedFixture = JSON.parse(await readFile(
      join(import.meta.dir, "../fixtures/arbord/mixed-mutation.json"),
      "utf8",
    ));
    mixedFixture.operations[0].ref = { tree: scope, pageID: before.ref.pageID!, pathHint: "/renamed" };
    mixedFixture.operations[0].baseContentRevision = before.contentRevision!;
    mixedFixture.operations[0].source = source;
    mixedFixture.operations[1].path = "/mixed-success";
    mixedFixture.operations[1].tree = scope;
    for (const [mutationID, operations] of [
      [mixedFixture.mutationID, mixedFixture.operations],
      ["multiple-content", [content, {
        op: "writeMarkdown",
        ref: { tree: scope, pageID: before.ref.pageID!, pathHint: "/renamed" },
        baseContentRevision: before.contentRevision!,
        source,
      }]],
    ] as const) {
      const response = await fetch(`${base}/v1/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mutationID, operations }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "unsupported-operation",
      });
    }
    expect((await client.node({ tree: scope, path: "/renamed" })).contentRevision).toBe(before.contentRevision);
    await expect(client.node({ tree: scope, path: "/mixed-success" })).rejects.toMatchObject({ status: 404 });
    expect((await client.search(scope, "Must not materialize")).results).toHaveLength(0);
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
    const receipt = await lossy.mutateStructural([{ op: "createDirectory", tree: scope, path: "/after-loss" }], "lost-response");
    expect(receipt.mutationID).toBe("lost-response");
    expect((await client.node({ tree: scope, path: "/after-loss" })).path).toBe("/after-loss");
  });

  test("replays events after a snapshot cursor and rejects another epoch", async () => {
    const snapshot = await client.node({ tree: scope, path: "/" });
    await client.mutateStructural([{ op: "createDirectory", tree: scope, path: "/eventful" }], "eventful");
    const abort = new AbortController();
    let replayed: WorkspaceEvent | null = null;
    for await (const event of client.observe(snapshot.observedThrough, abort.signal)) {
      if (event.change.mutationID === "eventful") {
        replayed = event;
        abort.abort();
        break;
      }
    }
    expect(replayed?.change.path).toBe("/eventful");

    const terminal = await fetch(`${base}/v1/events?after=${encodeURIComponent(`another-epoch:0`)}`);
    expect(terminal.status).toBe(200);
    expect(await terminal.text()).toContain("event: resync-required");
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
    const viewPromise = observing.openNodeView({ tree: scope, path: "/" });
    await childrenStarted;
    await client.mutateStructural([{ op: "createDirectory", tree: scope, path: "/during-view-load" }], "during-view-load");
    releaseChildren();
    const view = await viewPromise;
    try {
      for await (const update of view.updates) {
        if (update.kind === "event" && update.event.change.mutationID === "during-view-load") {
          expect(update.event.change.path).toBe("/during-view-load");
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
            error: "resync-required",
            message: "synthetic expired cursor",
            retryable: true,
          }, { status: 409 });
        }
        return fetch(input, init);
      },
    });
    const view = await observing.openNodeView({ tree: scope, path: "/renamed" });
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
    const receipt = await client.import({ tree: scope, path: "/folder" }, [
      { path: "drop", kind: "directory" },
      { path: "drop/readme.md", kind: "file", file: new File(["Imported\n"], "readme.md", { type: "text/markdown" }) },
    ], "import-drop");
    expect(receipt.effects.some((effect) => effect.path === "/folder/drop")).toBe(true);
    expect((await client.node({ tree: scope, path: "/folder/drop/readme" })).document?.bodySource).toBe("Imported\n");
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
    const first = await lossy.asset({ tree: scope, path: "/folder" }, file, "asset-after-loss");
    const retry = await client.asset({ tree: scope, path: "/folder" }, file, "asset-after-loss");
    expect(retry.receipt).toEqual(first.receipt);
    expect((await client.node({ tree: scope, path: first.path })).kind).toBe("file");
  });

  test("covers copy, trash, restore, and recovery restoration through logical operations", async () => {
    const copied = await client.mutateStructural([{
      op: "copy",
      refs: [{ tree: scope, path: "/renamed" }],
      destination: { tree: scope, path: "/folder" },
    }], "copy-page");
    const copyPath = copied.effects.find((effect) => effect.kind === "created")!.path;
    const copiedNode = await client.node({ tree: scope, path: copyPath });
    expect(copiedNode.kind).toBe("markdown");
    expect(copiedNode.ref.pageID).not.toBe((await client.node({ tree: scope, path: "/renamed" })).ref.pageID);

    const trashed = await client.mutateStructural([{ op: "trash", refs: [{ tree: scope, path: copyPath }] }], "trash-copy");
    const trashPath = `/Trash${copyPath}`;
    expect(trashed.effects).toContainEqual(expect.objectContaining({ kind: "deleted", path: copyPath }));
    await expect(client.node({ tree: scope, path: copyPath })).rejects.toMatchObject({ status: 404 });
    const restored = await client.mutateStructural([{ op: "restore", refs: [{ tree: scope, path: trashPath }] }], "restore-copy");
    expect((await client.node({ tree: scope, path: restored.effects[0]!.path })).kind).toBe("markdown");

    const before = await client.node({ tree: scope, path: "/renamed" });
    const pageRef = { tree: scope, pageID: before.ref.pageID!, pathHint: before.path };
    const recoverySourceText = before.document!.source.replace(before.document!.bodySource, "Recovery source\n");
    await client.mutateContent({
      op: "writeMarkdown",
      ref: pageRef,
      baseContentRevision: before.contentRevision!,
      source: recoverySourceText,
    }, "recovery-source");
    const recoverySource = await client.node(pageRef);
    await client.mutateContent({
      op: "writeMarkdown",
      ref: pageRef,
      baseContentRevision: recoverySource.contentRevision!,
      source: recoverySource.document!.frontmatterSource ?? "",
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

    await client.mutateStructural([{ op: "createMarkdown", tree: scope, path: "/discarded" }], "create-discarded");
    await client.mutateStructural([{ op: "trash", refs: [{ tree: scope, path: "/discarded" }] }], "trash-discarded");
    const subtree = await client.recovery({ tree: scope, path: "/" }, { recursive: true });
    expect(subtree.entries).not.toContainEqual(expect.objectContaining({
      kind: "block",
      ref: expect.objectContaining({ path: "/renamed" }),
    }));
    expect(subtree.entries).toContainEqual(expect.objectContaining({
      kind: "trash",
      ref: expect.objectContaining({ path: "/Trash/discarded" }),
      originalPath: "/discarded",
    }));
  });

  test("removes the unversioned API and serves the Arbor web shell", async () => {
    const legacy = await fetch(`${base}/v/tree/renamed`);
    expect(legacy.status).toBe(405);
    expect((await legacy.json() as any).error).toBe("unsupported-operation");

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
    form.set("metadata", JSON.stringify({ mutationID: "asset-rooted-1", directory: { tree: scope, path: "/" } }));
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

    const exact = await fetch(`${base}/v1/file?tree=${encodeURIComponent(scope)}&path=${encodeURIComponent(result.path)}`);
    expect(exact.status).toBe(200);
    expect(exact.headers.get("content-type")).toBe("image/png");
    expect(exact.headers.get("cache-control")).toBe("no-store");
    expect(await exact.text()).toBe("img");

    const document = await fetch(`${base}/v1/file?tree=${encodeURIComponent(scope)}&path=${encodeURIComponent("/page")}`);
    expect(document.status).toBe(404);
  });

  test("returns the durable original receipt after an arbord restart", async () => {
    await client.mutateStructural([{ op: "createDirectory", tree: scope, path: "/recovered-effect" }], "materialization-setup");
    const recoveredRequest: MutationRequest = {
      mutationID: "materialized-before-crash",
      operations: [{ op: "createDirectory", tree: scope, path: "/recovered-effect" }],
    };
    const recoveredHash = sha256(canonicalJSONString(recoveredRequest));
    await activeWorkspace.mutations.prepare(recoveredRequest.mutationID, recoveredHash, recoveredRequest);
    await activeWorkspace.mutations.markMaterialized(recoveredRequest.mutationID, recoveredHash, [{
      tree: scope,
      kind: "created",
      path: "/recovered-effect",
    }]);
    const written = await client.node({ tree: scope, path: "/renamed" });
    const recoveredWriteRequest: MutationRequest = {
      mutationID: "write-replaced-before-receipt",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: scope, pageID: written.ref.pageID!, pathHint: "/renamed" },
        baseContentRevision: "sha256:pre-crash-base",
        source: written.document!.source,
      }],
    };
    const recoveredWriteHash = sha256(canonicalJSONString(recoveredWriteRequest));
    await activeWorkspace.mutations.prepare(recoveredWriteRequest.mutationID, recoveredWriteHash, recoveredWriteRequest);
    await activeWorkspace.mutations.markExpected(recoveredWriteRequest.mutationID, recoveredWriteHash, [{
      tree: scope,
      kind: "updated",
      path: "/renamed",
      pageID: written.ref.pageID,
      contentRevision: written.contentRevision,
    }]);

    await close();
    const restarted = await serveWorkspace(root, { port: 0 });
    activeWorkspace = restarted.workspace;
    scope = activeWorkspace.tree;
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
    const oldCursor = durableWriteReceipt.observedThrough;
    const response = await fetch(`${base}/v1/events?after=${encodeURIComponent(oldCursor)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: resync-required");
  });
});
