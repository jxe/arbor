import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, serveWorkspace } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { MutationRequest } from "@arbor/core";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directories(): Promise<{ root: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "arbor-protocol-fault-root-"));
  const state = await mkdtemp(join(tmpdir(), "arbor-protocol-fault-state-"));
  temporary.push(root, state);
  return { root, state };
}

describe("REST v1 protocol fault recovery", () => {
  for (const stage of [
    "protocol:intent-recorded",
    "protocol:preparation",
    "protocol:materialized",
    "protocol:event-published",
    "protocol:receipt-completed",
  ]) {
    test(`recovers ${stage} without applying the operation twice`, async () => {
      const { root, state } = await directories();
      process.env.ARBOR_DATA_HOME = state;
      let injected = false;
      const first = await Workspace.open(root, {
        faultInjector: (point) => {
          if (!injected && point === stage) {
            injected = true;
            throw new Error(`injected ${stage}`);
          }
        },
      });
      const tree = first.tree;
      const request: MutationRequest = {
        mutationID: `fault-${stage}`,
        operations: [{ op: "createDirectory", tree, path: "/once" }],
      };
      await expect(first.executeMutation(request)).rejects.toThrow(stage);
      await first[Symbol.asyncDispose]();

      const recovered = await Workspace.open(root);
      const receipt = await recovered.executeMutation(request);
      expect(receipt.effects[0]).toMatchObject({ kind: "created", path: "/once" });
      expect((await recovered.snapshot({ tree, path: "/once" })).path).toBe("/once");
      expect(await recovered.executeMutation(request)).toEqual(receipt);
      await recovered[Symbol.asyncDispose]();
    });
  }

  test("a response-delivery failure returns the already-completed receipt on retry", async () => {
    const { root, state } = await directories();
    process.env.ARBOR_DATA_HOME = state;
    let injected = false;
    const running = await serveWorkspace(root, {
      port: 0,
      faultInjector: (point) => {
        if (!injected && point === "protocol:response-delivery") {
          injected = true;
          throw new Error("injected response delivery");
        }
      },
    });
    try {
      const client = new ArbordClient({ baseURL: running.url, retryDelay: async () => {} });
      const receipt = await client.mutateStructural(
        [{ op: "createDirectory", tree: running.workspace.tree, path: "/after-response-loss" }],
        "response-delivery",
      );
      expect(receipt.effects[0]).toMatchObject({ kind: "created", path: "/after-response-loss" });
      expect((await client.node({ tree: running.workspace.tree, path: "/after-response-loss" })).path).toBe("/after-response-loss");
    } finally {
      running.server.stop(true);
      await running.workspace[Symbol.asyncDispose]();
    }
  });
});
