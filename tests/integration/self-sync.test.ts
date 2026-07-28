import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import { serveWireHost } from "@arbor/wire";

const token = "self-sync-owner";
let sandbox: string;
let hostState: string;
let host: Awaited<ReturnType<typeof serveWireHost>>;
let hostPort: number;
let stateA: string;
let stateB: string;
let treeA: string;
let treeB: string;
let bootstrapB: string;
let tree: string;

async function launch(state: string, path: string) {
  process.env.ARBOR_DATA_HOME = state;
  const running = await serveArbor(path, { port: 0 });
  const client = new ArbordClient({ baseURL: running.url, retryDelay: async () => {} });
  const close = async () => {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  };
  return { running, client, close };
}

async function waitFor(read: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for self-sync");
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-self-sync-"));
  hostState = join(sandbox, "host");
  stateA = join(sandbox, "home-a");
  stateB = join(sandbox, "home-b");
  treeA = join(sandbox, "tree-a");
  treeB = join(sandbox, "tree-b");
  bootstrapB = join(sandbox, "bootstrap-b");
  await Promise.all([hostState, stateA, stateB, treeA, bootstrapB].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(treeA, "note.md"), "# Common\n");
  host = await serveWireHost({
    dataRoot: hostState,
    ownerToken: token,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  hostPort = host.server.port!;
});

afterAll(async () => {
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  process.env.ARBOR_DATA_HOME = stateA;
  const cleanup = await serveArbor(treeA, { port: 0 });
  await cleanup.service.serverConfig.remove();
  cleanup.server.stop(true);
  await cleanup.service[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("private self-sync", () => {
  test("places one TreeID in two isolated Arbor homes and pulls edits", async () => {
    const first = await launch(stateA, treeA);
    await first.client.mutateSystem({ op: "configureServer", origin: host.url, ownerToken: token });
    const promoted = await first.client.mutateSystem({ op: "promoteTree", path: treeA, slug: "self-sync" });
    tree = promoted.effects.find((effect) => effect.tree?.startsWith("tr_"))!.tree!;
    await first.close();

    const second = await launch(stateB, bootstrapB);
    await second.client.mutateSystem({ op: "configureServer", origin: host.url, ownerToken: token });
    await second.client.mutateSystem({ op: "placeTree", tree, path: treeB });
    expect(await readFile(join(treeB, "note.md"), "utf8")).toBe("# Common\n");
    await second.close();

    const author = await launch(stateA, treeA);
    const note = await author.client.node({ tree, path: "/note" });
    await author.client.mutateContent({
      op: "writeMarkdown",
      ref: { tree, path: "/note" },
      baseContentRevision: note.contentRevision!,
      blocks: [{ id: "sync-edit", type: "heading", props: { level: 1 }, content: "From A", children: [] }],
    });
    await author.close();

    const reader = await launch(stateB, treeB);
    await waitFor(async () => (await readFile(join(treeB, "note.md"), "utf8")).includes("From A"));
    expect(await reader.client.node({ tree, path: "/note" }).then((node) => node.document?.bodySource)).toContain("From A");
    await reader.close();
  });

  test("preserves both sides when devices diverge offline", async () => {
    const commonRef = host.authority.get(tree)!.ref;
    host.server.stop(true);
    await host.authority[Symbol.asyncDispose]();

    await writeFile(join(treeA, "note.md"), "# Offline A\n");
    await writeFile(join(treeB, "note.md"), "# Offline B\n");

    host = await serveWireHost({
      dataRoot: hostState,
      ownerToken: token,
      publicOrigin: `http://127.0.0.1:${hostPort}`,
      hostname: "127.0.0.1",
      port: hostPort,
    });

    const first = await launch(stateA, treeA);
    await waitFor(async () => host.authority.get(tree)?.ref !== commonRef);
    await first.close();

    const second = await launch(stateB, treeB);
    await waitFor(async () => (await second.client.node({ tree: "system", path: `/trees/${tree}` }))
      .document?.frontmatter.sync === "conflict");
    expect(await readFile(join(treeB, "note.md"), "utf8")).toBe("# Offline B\n");
    expect(await readFile(join(treeA, "note.md"), "utf8")).toBe("# Offline A\n");
    await second.close();
  });
});
