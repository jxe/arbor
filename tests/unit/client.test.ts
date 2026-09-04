import { describe, expect, test } from "bun:test";
import type { ChildrenPage, NodeSnapshot } from "@arbor/client";
import { ArborSyncRESTClient } from "@arbor/client";

const CURSOR = "11111111-1111-1111-1111-111111111111:1";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function directorySnapshot(): NodeSnapshot {
  return {
    ref: { tree: "local", path: "/dir", stableKey: null },
    name: "dir",
    revision: "sha256:dir",
    properties: {},
    capabilities: {
      properties: { revision: "sha256:dir", writable: true },
      content: { revision: "sha256:dir", mediaType: "text/markdown", format: "markdown", writable: true },
      children: { revision: "sha256:dir", backing: { type: "expanded-files" }, writable: true },
    },
    materialization: "available",
    content: { source: "[child](child)\n\n", representation: { state: "implicit" } },
    diagnostics: [],
    observedThrough: CURSOR,
  };
}

describe("ArborSyncRESTClient exact-source contract", () => {
  test("keeps node sampling separate from paged children", async () => {
    const page: ChildrenPage = {
      parent: { tree: "local", path: "/dir", stableKey: null },
      items: [{
        ref: { tree: "local", path: "/dir/child", stableKey: null },
        name: "child",
        revision: "sha256:child",
        properties: {},
        capabilities: { content: { revision: "sha256:child", mediaType: "text/markdown", format: "markdown", writable: true } },
        materialization: "available",
        diagnostics: [],
      }],
      nextCursor: null,
      observedThrough: CURSOR,
    };
    const client = new ArborSyncRESTClient({
      fetch: async (input) => String(input).includes("/v1/children")
        ? jsonResponse(page)
        : jsonResponse(directorySnapshot()),
    });
    const node = await client.node({ tree: "local", path: "/dir", stableKey: null });
    expect(node.content?.source).toBe("[child](child)\n\n");
    expect(await client.children(node.ref)).toEqual(page);
    expect("children" in node).toBe(false);
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
      ref: { tree: "local", path: "/page", stableKey: null },
      baseContentRevision: "sha256:before",
      source: "# Exact\r\n\r\nunknown <x>\r\n",
    });
    const operation = (body?.operations as Array<Record<string, unknown>>)[0]!;
    expect(operation.source).toBe("# Exact\r\n\r\nunknown <x>\r\n");
    expect(operation.blocks).toBeUndefined();
    expect(operation.frontmatterPatch).toBeUndefined();
  });

});
