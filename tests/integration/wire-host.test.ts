import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWireHost, snapshotDirectory, WireClient } from "@arbor/wire";

const token = "owner-test-token";
let dataRoot: string;
let source: string;
let running: Awaited<ReturnType<typeof serveWireHost>>;
let client: WireClient;

async function start() {
  running = await serveWireHost({
    dataRoot,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = new WireClient(running.url, token);
}

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "arbor-wire-authority-"));
  source = await mkdtemp(join(tmpdir(), "arbor-wire-source-"));
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "note.md"), "# First\n");
  await writeFile(join(source, "nested", "secret.md"), "not inherited\n");
  await start();
});

afterAll(async () => {
  running.server.stop(true);
  await running.authority[Symbol.asyncDispose]();
  await rm(dataRoot, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

describe("personal wire authority", () => {
  test("creates one private tree tip and isolates nested boundaries", async () => {
    const initial = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const tree = await client.create("/~owner/notes", initial);
    expect(tree.id).toMatch(/^tr_/);
    expect((await client.ref(tree.id)).ref).toBe(initial.root);
    expect((await fetch(`${running.url}/~owner/notes`)).status).toBe(404);
    expect((await fetch(`${running.url}/.arbor/objects/${initial.root}`)).status).toBe(404);

    await client.setPublicAccess(tree.id, "read");
    const page = await fetch(`${running.url}/~owner/notes`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("nested");
    expect((await fetch(`${running.url}/~owner/notes/nested/secret.md`)).status).toBe(404);
    expect((await fetch(`${running.url}/.arbor/objects/${initial.root}`)).status).toBe(200);
  });

  test("atomically advances the one tip and rejects stale or corrupt pushes", async () => {
    const tree = (await client.list()).find((item) => item.canonicalPath === "/~owner/notes")!;
    await writeFile(join(source, "note.md"), "# Second\n");
    const next = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const updated = await client.push(tree.id, tree.ref, next);
    expect(updated.ref).toBe(next.root);

    const stale = await fetch(`${running.url}/.arbor/trees/${tree.id}/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expected: tree.ref, root: next.root, objects: [] }),
    });
    expect(stale.status).toBe(409);

    const corrupt = await fetch(`${running.url}/.arbor/trees`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        canonicalPath: "/~owner/corrupt",
        root: next.root,
        objects: [{ hash: next.root, bytes: Buffer.from("wrong").toString("base64") }],
      }),
    });
    expect(corrupt.status).toBe(400);
  });

  test("allows anonymous CAS only in public-write mode and survives restart", async () => {
    const tree = (await client.list()).find((item) => item.canonicalPath === "/~owner/notes")!;
    await client.setPublicAccess(tree.id, "write");
    await writeFile(join(source, "third.md"), "third\n");
    const next = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const response = await fetch(`${running.url}/.arbor/trees/${tree.id}/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected: tree.ref,
        root: next.root,
        objects: [...next.objects].map(([hash, bytes]) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
      }),
    });
    expect(response.status).toBe(200);

    running.server.stop(true);
    await running.authority[Symbol.asyncDispose]();
    await start();
    const restored = (await client.list()).find((item) => item.id === tree.id)!;
    expect(restored.ref).toBe(next.root);
    expect(restored.publicAccess).toBe("write");
  });
});
