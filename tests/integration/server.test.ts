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

  test("runs typed mutation batches and rejects the complete batch on conflict", async () => {
    const create = await fetch(`${base}/v/fs/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [
        { op: "createDirectory", path: "/folder" },
        { op: "createMarkdown", path: "/other" },
      ] }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as any;
    expect(created.created).toEqual(["/folder", "/other"]);

    const conflict = await fetch(`${base}/v/fs/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [
        { op: "createMarkdown", path: "/never-created" },
        { op: "createDirectory", path: "/folder" },
      ] }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).conflict.code).toBe("occupied-destination");
    expect(await fetch(`${base}/v/tree/never-created`).then((response) => response.status)).toBe(500);
  });

  test("returns a structured conflict for a vanished insertion anchor", async () => {
    const directory = await fetch(`${base}/v/tree/`).then((response) => response.json()) as any;
    const response = await fetch(`${base}/v/fs/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [{
        op: "move",
        paths: ["/other"],
        destination: "/",
        beforeBlockId: "vanished-block",
        directoryRevision: directory.revision,
      }] }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as any).conflict.code).toBe("missing-insertion-anchor");
    expect((await fetch(`${base}/v/tree/other`).then((result) => result.json()) as any).path).toBe("/other");
  });

  test("imports a multipart directory manifest atomically", async () => {
    const form = new FormData();
    form.set("destination", "/folder");
    form.set("manifest", JSON.stringify([
      { path: "drop", kind: "directory" },
      { path: "drop/readme.md", kind: "file", field: "file-1" },
    ]));
    form.set("file-1", new File(["Imported\n"], "readme.md", { type: "text/markdown" }));
    const response = await fetch(`${base}/v/fs/import`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect((await response.json() as any).created).toEqual(["/folder/drop"]);
    const imported = await fetch(`${base}/v/tree/folder/drop/readme`);
    expect(imported.status).toBe(200);
    expect((await imported.json() as any).document.bodySource).toBe("Imported\n");
  });

  test("serves the TreeHopper shell", async () => {
    const response = await fetch(`${base}/render/page`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
