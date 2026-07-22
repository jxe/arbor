import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWorkspace } from "@arbor/arbord";

let root: string;
let state: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-server-"));
  state = await mkdtemp(join(tmpdir(), "arbor-server-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await writeFile(join(root, "page.md"), "Hello API\n");
  const running = await serveWorkspace(root, { port: 0 });
  base = running.url;
  close = async () => { running.server.stop(true); await running.workspace[Symbol.asyncDispose](); };
});

afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("HTTP API", () => {
  test("reads and writes a Markdown node", async () => {
    const nodeResponse = await fetch(`${base}/v/tree/page`);
    expect(nodeResponse.status).toBe(200);
    const node = await nodeResponse.json() as any;
    const aliased = await fetch(`${base}/v/tree/page.md`);
    expect((await aliased.json() as any).path).toBe("/page");
    node.document.blocks[0].content = "Changed through API";
    const write = await fetch(`${base}/v/node/page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: node.revision, blocks: node.document.blocks }),
    });
    expect(write.status).toBe(200);
    expect((await write.json() as any).document.frontmatter.id).toMatch(/^[a-z0-9]{6}$/);
  });

  test("returns 409 with the current document for stale writes", async () => {
    const response = await fetch(`${base}/v/node/page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: "sha256:stale", blocks: [] }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as any).current.path).toBe("/page");
  });

  test("serves the TreeHopper shell", async () => {
    const response = await fetch(`${base}/render/page`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
