import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";

let root: string;
let state: string;
let running: Awaited<ReturnType<typeof serveArbor>>;
let client: ArbordClient;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-system-surface-"));
  state = await mkdtemp(join(tmpdir(), "arbor-system-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "today.md"), "# Today\n");
  running = await serveArbor(root, { port: 0 });
  client = new ArbordClient({ baseURL: running.url, retryDelay: async () => {} });
});

afterAll(async () => {
  running.server.stop(true);
  await running.service[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("narrow system scope", () => {
  test("contains only safe local diagnostics, credential availability, and visits", async () => {
    const system = await client.node({ tree: "system", path: "/" });
    expect(system.children?.map((child) => child.name)).toEqual([
      "credentials",
      "visited",
      "diagnostics",
    ]);
    for (const removed of ["device", "community", "trees"]) {
      await expect(client.node({ tree: "system", path: `/${removed}` })).rejects.toMatchObject({ status: 404 });
    }
  });

  test("keeps ordinary local browsing explicit and separate from system scope", async () => {
    const note = await client.node({ tree: "local", path: join(root, "notes", "today") });
    expect(note.tree).toBe(running.workspace.tree);
    expect(note.enclosingTree).toMatchObject({ placement: "placed" });
    expect(note.document?.bodySource).toContain("Today");
  });

  test("rejects removed account-control mutations instead of retaining a proxy API", async () => {
    const response = await fetch(`${running.url}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "removed-account-operation",
        operations: [{ op: "setTreeAccess", tree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", access: "read" }],
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "unsupported-operation", retryable: false });
  });

  test("does not expose a roots administration route", async () => {
    expect((await fetch(`${running.url}/v1/roots`)).status).toBe(405);
  });
});
