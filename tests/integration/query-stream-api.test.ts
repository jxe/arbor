import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveArborSync } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import type { MutationCallRequest, MutationCallRuntime, MutationResultReceipt, QueryStreamEvent, QueryStreamRequest, QueryStreamRuntime } from "@arbor/core";

const request: QueryStreamRequest = {
  document: { tree: "tr_source", path: "/index", version: "doc-v1" },
  queries: [{
    id: "primary",
    handle: { tree: "tr_source", module: "/queries.ts", export: "primary", version: "query-v1" },
  }],
};

function requestFor(tree: string): QueryStreamRequest {
  return {
    document: { ...request.document, tree },
    queries: request.queries.map((query) => ({ ...query, handle: { ...query.handle, tree } })),
  };
}

class FixtureMutationRuntime implements MutationCallRuntime {
  calls: MutationCallRequest[] = [];
  async call(input: MutationCallRequest): Promise<MutationResultReceipt> {
    this.calls.push(input);
    return {
      mutationID: input.mutationID,
      requestDigest: "sha256:mutation-fixture",
      observedThrough: "mutation:0",
      result: { accepted: true },
    };
  }
}

class FixtureRuntime implements QueryStreamRuntime {
  users: Array<{ profile: string } | null> = [];

  stream(_request: QueryStreamRequest, context: { signal: AbortSignal; user: { profile: string } | null }) {
    this.users.push(context.user);
    const events: QueryStreamEvent[] = [
      { type: "result", id: "primary", observedThrough: "query:0", outputHash: "sha256:fixture", value: { current: true } },
      { type: "ready", queries: [{ id: "primary", observedThrough: "query:0", outputHash: "sha256:fixture" }] },
    ];
    return new ReadableStream<QueryStreamEvent>({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      },
    });
  }
}

function expectFrames(body: string) {
  expect(body).toContain('event: result\ndata: {"id":"primary","observedThrough":"query:0","outputHash":"sha256:fixture","value":{"current":true}}');
  expect(body).toContain('event: ready\ndata: {"queries":[{"id":"primary","observedThrough":"query:0","outputHash":"sha256:fixture"}]}');
  expect(body).not.toContain("id:");
}

describe("stateless query stream HTTP contract", () => {
  test("serves the same self-contained request through Local REST and the local Wire alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-query-api-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-query-api-state-"));
    const previous = process.env.ARBOR_DATA_HOME;
    process.env.ARBOR_DATA_HOME = state;
    await writeFile(join(root, "index.md"), "# Query API\n");
    const runtime = new FixtureRuntime();
    const mutations = new FixtureMutationRuntime();
    const running = await serveArborSync(root, { port: 0, queryRuntime: runtime, mutationRuntime: mutations, queryUser: { profile: "tr_local_user" } });
    try {
      for (const [path, method] of [["/v1/query-stream", "POST"], ["/.arbor/trees/tr_source/queries", "QUERY"]] as const) {
        const response = await fetch(`${running.url}${path}`, {
          method,
          headers: { "content-type": "application/json", "last-event-id": "must-be-ignored" },
          body: JSON.stringify(request),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expectFrames(await response.text());
      }
      expect(runtime.users).toEqual([{ profile: "tr_local_user" }, { profile: "tr_local_user" }]);
      expect((await fetch(`${running.url}/.arbor/query-stream`, { method: "POST" })).status).toBe(405);
      const mutation: MutationCallRequest = {
        document: request.document,
        handle: request.queries[0]!.handle,
        mutationID: "mut_local",
        input: { value: 1 },
      };
      const mutationResponse = await fetch(`${running.url}/.arbor/trees/tr_source/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
      });
      expect(mutationResponse.status).toBe(200);
      expect(await mutationResponse.json()).toMatchObject({ mutationID: "mut_local", result: { accepted: true } });
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
      if (previous === undefined) delete process.env.ARBOR_DATA_HOME;
      else process.env.ARBOR_DATA_HOME = previous;
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("serves Arbor Wire with the authenticated profile context", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-query-wire-"));
    const runtime = new FixtureRuntime();
    const mutations = new FixtureMutationRuntime();
    const token = "query-stream-owner-token";
    const running = await serveCanopy({
      dataRoot: root,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [{ handle: "owner", token, communityWriter: true }],
      queryRuntime: runtime,
      mutationRuntime: mutations,
    });
    try {
      const account = await fetch(`${running.url}/.arbor/account`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json()) as any;
      const tree = account.account.profileTree as string;
      const wireRequest = requestFor(tree);
      const response = await fetch(`${running.url}/.arbor/trees/${tree}/queries`, {
        method: "QUERY",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(wireRequest),
      });
      expect(response.status).toBe(200);
      expectFrames(await response.text());
      expect(runtime.users).toEqual([{ profile: account.account.profileTree }]);
      const mutation: MutationCallRequest = {
        document: wireRequest.document,
        handle: wireRequest.queries[0]!.handle,
        mutationID: "mut_wire",
        input: { value: 2 },
      };
      const mutationResponse = await fetch(`${running.url}/.arbor/trees/${tree}/mutate`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(mutation),
      });
      expect(mutationResponse.status).toBe(200);
      expect(await mutationResponse.json()).toMatchObject({ mutationID: "mut_wire", result: { accepted: true } });
    } finally {
      running.server.stop(true);
      await running.canopy[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  });
});
