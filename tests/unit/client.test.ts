import { describe, expect, test } from "bun:test";
import type { ChildrenPage, NodeSnapshot } from "@arbor/client";
import { ArborSyncRESTClient, childRef } from "@arbor/client";

const CURSOR = "11111111-1111-1111-1111-111111111111:1";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function directorySnapshot(): NodeSnapshot {
  return {
    ref: { tree: "local", path: "/dir" },
    tree: "local",
    path: "/dir",
    name: "dir",
    kind: "directory",
    writable: true,
    materialization: "available",
    contentRevision: "sha256:dir",
    directoryRevision: "sha256:dir",
    bodyState: "implicit",
    document: { source: "[child](child)\n\n", frontmatter: {}, frontmatterSource: null, bodySource: "[child](child)\n\n", blocks: [] },
    diagnostics: [],
    observedThrough: CURSOR,
  };
}

describe("ArborSyncRESTClient exact-source contract", () => {
  test("hydrates children without constructing a second projected document", async () => {
    const page: ChildrenPage = {
      parent: { tree: "local", path: "/dir" },
      items: [{ tree: "local", name: "child", path: "/dir/child", kind: "markdown", materialization: "available" }],
      nextCursor: null,
      observedThrough: CURSOR,
    };
    const client = new ArborSyncRESTClient({
      fetch: async (input) => String(input).includes("/v1/children")
        ? jsonResponse(page)
        : jsonResponse(directorySnapshot()),
    });
    const node = await client.node({ tree: "local", path: "/dir" });
    expect(node.document?.source).toBe("[child](child)\n\n");
    expect(node.children).toEqual(page.items);
    expect("projection" in node).toBe(false);
  });

  test("sends exact source and no parsed block payload", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new ArborSyncRESTClient({
      mutationID: () => "mutation-source",
      retryDelay: async () => {},
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ mutationID: "mutation-source", observedThrough: CURSOR, effects: [] });
      },
    });
    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: "local", path: "/page" },
      baseContentRevision: "sha256:before",
      source: "# Exact\r\n\r\nunknown <x>\r\n",
    });
    const operation = (body?.operations as Array<Record<string, unknown>>)[0]!;
    expect(operation.source).toBe("# Exact\r\n\r\nunknown <x>\r\n");
    expect(operation.blocks).toBeUndefined();
    expect(operation.frontmatterPatch).toBeUndefined();
  });

  test("childRef prefers durable identity", () => {
    expect(childRef({ tree: "tr_example", name: "a", path: "/a", kind: "markdown", materialization: "available", pageID: "opaque" }))
      .toEqual({ tree: "tr_example", pageID: "opaque", pathHint: "/a" });
  });
});
