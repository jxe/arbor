import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHost } from "@ovst/overstoryd";
import type { MutationCallRequest, MutationCallRuntime, MutationResultReceipt, ViewEvent, ViewsRequest, ViewsRuntime } from "@ovst/protocol";
import { deviceSession, testAccount } from "../helpers/devices.ts";

const request: ViewsRequest = {
  views: [{
    id: "primary",
    handle: { tree: "tr_source", path: "/views.ts", name: "primary", version: "sha256:code" },
  }],
};

function requestFor(tree: string): ViewsRequest {
  return {
    views: request.views.map((view) => ({ ...view, handle: { ...view.handle, tree } })),
  };
}

class FixtureMutationRuntime implements MutationCallRuntime {
  calls: MutationCallRequest[] = [];
  async call(input: MutationCallRequest): Promise<MutationResultReceipt> {
    this.calls.push(input);
    return {
      mutationID: input.mutationID,
      requestDigest: "sha256:mutation-fixture",
      affected: { tree: input.handle.tree, update: "up_fixture" },
      result: { accepted: true },
    };
  }
}

class FixtureRuntime implements ViewsRuntime {
  users: Array<{ profile: string } | null> = [];

  stream(_request: ViewsRequest, context: { signal: AbortSignal; user: { profile: string } | null }) {
    this.users.push(context.user);
    const events: ViewEvent[] = [
      { type: "result", id: "primary", outputHash: "sha256:fixture", value: { current: true }, shape: { fields: { current: { type: "Bool" } } } },
      { type: "ready", views: [{ id: "primary", outputHash: "sha256:fixture" }] },
    ];
    return new ReadableStream<ViewEvent>({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      },
    });
  }
}

function expectFrames(body: string) {
  expect(body).toContain('event: result\ndata: {"id":"primary","outputHash":"sha256:fixture","value":{"current":true},"shape":{"fields":{"current":{"type":"Bool"}}}}');
  expect(body).toContain('event: ready\ndata: {"views":[{"id":"primary","outputHash":"sha256:fixture"}]}');
  expect(body).not.toContain("id:");
}

describe("stateless view stream HTTP contract", () => {
  test("serves the Overstory protocol with the authenticated profile context", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-views-wire-"));
    const runtime = new FixtureRuntime();
    const mutations = new FixtureMutationRuntime();
    const token = "views-owner-token";
    const running = await serveHost({
      dataRoot: root,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [testAccount("owner", token, { communityWriter: true })],
      viewsRuntime: runtime,
      mutationRuntime: mutations,
    });
    try {
      const session = await deviceSession(running.url, token);
      const account = await fetch(`${running.url}/.overstory/account`, { headers: { authorization: `Bearer ${session}` } }).then((response) => response.json()) as any;
      const tree = account.account.profileTree as string;
      const wireRequest = requestFor(tree);
      const response = await fetch(`${running.url}/.overstory/trees/${tree}/views`, {
        method: "QUERY",
        headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
        body: JSON.stringify(wireRequest),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expectFrames(await response.text());
      // A request naming a document is the old form, and refused.
      const withDocument = await fetch(`${running.url}/.overstory/trees/${tree}/views`, {
        method: "QUERY",
        headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
        body: JSON.stringify({ ...wireRequest, document: { tree, path: "/index", version: "doc-v1" } }),
      });
      expect(withDocument.status).toBe(400);
      expect(runtime.users).toEqual([{ profile: account.account.profileTree }]);
      const mutation: MutationCallRequest = {
        handle: wireRequest.views[0]!.handle,
        mutationID: "mut_wire",
        input: { value: 2 },
      };
      const mutationResponse = await fetch(`${running.url}/.overstory/trees/${tree}/mutate`, {
        method: "POST",
        headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
        body: JSON.stringify(mutation),
      });
      expect(mutationResponse.status).toBe(200);
      expect(await mutationResponse.json()).toMatchObject({ mutationID: "mut_wire", affected: { tree, update: "up_fixture" }, result: { accepted: true } });
    } finally {
      running.server.stop(true);
      await running.overstoryd[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  });
});
