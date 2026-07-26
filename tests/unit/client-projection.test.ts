import { describe, expect, test } from "bun:test";
import type { ChildrenPage, NodeSnapshot } from "@arbor/client";
import { ArbordClient, childRef, projectSnapshot } from "@arbor/client";

const CURSOR = "11111111-1111-1111-1111-111111111111:1";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      // Leave the stream open; the client closes it via AbortSignal.
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function directorySnapshot(children: number): NodeSnapshot {
  return {
    ref: { path: "/dir" },
    path: "/dir",
    name: "dir",
    kind: "directory",
    writable: true,
    materialization: "available",
    contentRevision: "sha256:dir",
    directoryRevision: "sha256:dir",
    bodyState: "implicit",
    document: { frontmatter: {}, frontmatterSource: null, bodySource: "", blocks: [] },
    diagnostics: [],
    observedThrough: CURSOR,
  };
}

function childrenPages(total: number, pageSize: number): ChildrenPage[] {
  const items = Array.from({ length: total }, (_, index) => ({
    name: `child-${String(index + 1).padStart(3, "0")}`,
    path: `/dir/child-${String(index + 1).padStart(3, "0")}`,
    kind: "markdown" as const,
    materialization: "available" as const,
  }));
  const pages: ChildrenPage[] = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    pages.push({
      parent: { path: "/dir" },
      items: items.slice(offset, offset + pageSize),
      nextCursor: offset + pageSize < total ? `cursor-${offset + pageSize}` : null,
      observedThrough: CURSOR,
    });
  }
  return pages;
}

describe("openProjectedNodeView", () => {
  test("drains every child page and projects synthetic rows over the complete listing", async () => {
    const pages = childrenPages(250, 100);
    let childrenCalls = 0;
    const client = new ArbordClient({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/node")) return jsonResponse(directorySnapshot(250));
        if (url.includes("/v1/children")) return jsonResponse(pages[childrenCalls++]);
        if (url.includes("/v1/events")) return sseResponse([]);
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const view = await client.openProjectedNodeView({ path: "/dir" });
    expect(childrenCalls).toBe(3);
    expect(view.projection?.bodyState).toBe("implicit");
    expect(view.projection?.visibleBlocks).toHaveLength(250);
    expect(view.projection?.managedChildren).toHaveLength(250);
    expect(view.projection?.managedChildren.every((row) => row.origin === "synthetic")).toBe(true);
    expect(view.snapshot.document?.blocks).toHaveLength(0);
    view.close();
  });

  test("buffered child events during hydration surface after the initial projection", async () => {
    const event = {
      cursor: "11111111-1111-1111-1111-111111111111:2",
      kind: "created",
      path: "/dir/child-new",
      origin: "external",
    };
    const client = new ArbordClient({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/node")) return jsonResponse(directorySnapshot(1));
        if (url.includes("/v1/children")) return jsonResponse(childrenPages(1, 100)[0]);
        if (url.includes("/v1/events")) return sseResponse([`data: ${JSON.stringify(event)}\n\n`]);
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const view = await client.openProjectedNodeView({ path: "/dir" });
    const first = await view.updates[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({ kind: "event", event });
    view.close();
  });

  test("a resync update arrives re-hydrated and re-projected", async () => {
    let observeCalls = 0;
    const client = new ArbordClient({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/node")) return jsonResponse(directorySnapshot(2));
        if (url.includes("/v1/children")) return jsonResponse(childrenPages(2, 100)[0]);
        if (url.includes("/v1/events")) {
          observeCalls += 1;
          if (observeCalls === 1) {
            return new Response(
              JSON.stringify({ error: { code: "resync-required", message: "stale", retryable: true } }),
              { status: 409 },
            );
          }
          return sseResponse([]);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const view = await client.openProjectedNodeView({ path: "/dir" });
    const first = await view.updates[Symbol.asyncIterator]().next();
    expect(first.value.kind).toBe("resync");
    if (first.value.kind === "resync") {
      expect(first.value.projection?.managedChildren).toHaveLength(2);
      expect(first.value.snapshot.children).toHaveLength(2);
    }
    view.close();
  });

  test("never mutates the snapshot document and rejects synthetic IDs on the wire", async () => {
    const client = new ArbordClient({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/node")) return jsonResponse(directorySnapshot(1));
        if (url.includes("/v1/children")) return jsonResponse(childrenPages(1, 100)[0]);
        if (url.includes("/v1/events")) return sseResponse([]);
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const view = await client.openProjectedNodeView({ path: "/dir" });
    expect(view.snapshot.document?.blocks).toHaveLength(0);
    expect(view.projection?.visibleBlocks[0]?.id).toStartWith("managed:");
    view.close();

    expect(client.mutateStructural([{
      op: "move",
      refs: [{ path: "/dir/child-001" }],
      destination: { path: "/dir" },
      beforeBlockID: "managed:path:/dir/child-001",
      baseDirectoryRevision: "sha256:dir",
    }])).rejects.toThrow("synthetic managed-row ID");

    expect(client.mutateContent({
      op: "writeMarkdown",
      ref: { path: "/dir" },
      baseContentRevision: "sha256:dir",
      blocks: [{ id: "managed:path:/dir/child-001", type: "standaloneLink", content: "x", props: { path: "child-001" }, children: [] }],
    })).rejects.toThrow("cannot be persisted");
  });

  test("childRef prefers durable identity", () => {
    expect(childRef({ name: "a", path: "/a", kind: "markdown", materialization: "available", pageID: "abc123" }))
      .toEqual({ pageID: "abc123", pathHint: "/a" });
    expect(childRef({ name: "a", path: "/a", kind: "markdown", materialization: "available" }))
      .toEqual({ path: "/a" });
    expect(projectSnapshot({ ...directorySnapshot(0), kind: "markdown" })).toBeNull();
  });
});
