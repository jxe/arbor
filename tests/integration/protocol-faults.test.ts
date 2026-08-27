import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, serveArborSync } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import type { MutationRequest } from "@arbor/core";
import { canonicalStableKey } from "@arbor/core";

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
      expect((await recovered.snapshot({ tree, path: "/once", stableKey: null })).ref.path).toBe("/once");
      expect(await recovered.executeMutation(request)).toEqual(receipt);
      await recovered[Symbol.asyncDispose]();
    });
  }

  test("a response-delivery failure returns the already-completed receipt on retry", async () => {
    const { root, state } = await directories();
    process.env.ARBOR_DATA_HOME = state;
    let injected = false;
    const running = await serveArborSync(root, {
      port: 0,
      faultInjector: (point) => {
        if (!injected && point === "protocol:response-delivery") {
          injected = true;
          throw new Error("injected response delivery");
        }
      },
    });
    try {
      const client = new ArborSyncRESTClient({ baseURL: running.url, retryDelay: async () => {} });
      const receipt = await client.mutateStructural(
        [{ op: "createDirectory", tree: running.workspace.tree, path: "/after-response-loss" }],
        "response-delivery",
      );
      expect(receipt.effects[0]).toMatchObject({ kind: "created", path: "/after-response-loss" });
      expect((await client.node({ tree: running.workspace.tree, path: "/after-response-loss", stableKey: null })).ref.path).toBe("/after-response-loss");
    } finally {
      running.server.stop(true);
      await running.workspace[Symbol.asyncDispose]();
    }
  });

  test("recovers an exact-source rollup committed before its materialization record", async () => {
    const { root, state } = await directories();
    process.env.ARBOR_DATA_HOME = state;
    const collection = join(root, "records");
    await mkdir(collection);
    await writeFile(join(collection, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(collection, "_store.json"), '[{"id":"one","title":"One"}]\n');
    let injected = false;
    const first = await Workspace.open(root, {
      faultInjector: (point) => {
        if (!injected && point === "protocol:provider-committed") {
          injected = true;
          throw new Error("injected provider commit");
        }
      },
    });
    const tree = first.tree;
    const key = canonicalStableKey([["id", "one"]]);
    const row = await first.snapshot({ tree, path: "/records/one", stableKey: key });
    const request: MutationRequest = {
      mutationID: "fault-file-rollup-commit",
      operations: [{
        op: "writeProperties",
        ref: row.ref,
        basePropertiesRevision: row.capabilities.properties!.revision,
        properties: { id: "one", title: "Changed" },
      }],
    };
    await expect(first.executeMutation(request)).rejects.toThrow("protocol:provider-committed");
    expect(await readFile(join(collection, "_store.json"), "utf8"))
      .toBe('[{"id":"one","title":"Changed"}]\n');
    await first[Symbol.asyncDispose]();

    const recovered = await Workspace.open(root);
    const receipt = await recovered.executeMutation(request);
    expect(receipt.effects[0]).toMatchObject({ path: "/records/one", propertiesRevision: expect.stringMatching(/^sha256:/) });
    expect((await recovered.snapshot({ tree, path: "/records/stale", stableKey: key })).properties.title).toBe("Changed");
    expect(await recovered.executeMutation(request)).toEqual(receipt);
    await recovered[Symbol.asyncDispose]();
  });
});
