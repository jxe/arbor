import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborService, serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import { serveWireHost } from "@arbor/authority";

let root: string;
let state: string;
let base: string;
let client: ArbordClient;
let close: () => Promise<void>;
let arbor: Awaited<ReturnType<typeof serveArbor>>;
let host: Awaited<ReturnType<typeof serveWireHost>>;
let hostState: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "arbor-system-trees-")));
  state = await mkdtemp(join(tmpdir(), "arbor-system-trees-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "today.md"), "# Today\n");
  await writeFile(join(state, "trees.yaml"), `${JSON.stringify(root)}:\n  source: local\n`);
  hostState = await mkdtemp(join(tmpdir(), "arbor-system-trees-host-"));
  host = await serveWireHost({
    dataRoot: hostState,
    accounts: [{ handle: "owner", token: "owner-system-test", communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  arbor = await serveArbor(root, { port: 0 });
  base = arbor.url;
  client = new ArbordClient({ baseURL: base, retryDelay: async () => {} });
  close = async () => {
    arbor.server.stop(true);
    await arbor.service[Symbol.asyncDispose]();
  };
});

afterAll(async () => {
  await close();
  await arbor.service.communityConfig.remove();
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await rm(hostState, { recursive: true, force: true });
});

describe("system tree control", () => {
  test("projects legacy placements as trees that need a URL", async () => {
    const system = await client.node({ tree: "system", path: "/" });
    expect(system.children?.map((child) => child.name)).toEqual([
      "device",
      "community",
      "trees",
      "credentials",
      "visited",
      "diagnostics",
    ]);

    const trees = await client.node({ tree: "system", path: "/trees" });
    expect(trees.children).toHaveLength(1);
    const record = await client.node({ tree: "system", path: trees.children![0]!.path });
    expect(record.document?.frontmatter).toMatchObject({
      placement: "local",
      path: root,
      legacy: true,
    });

    const note = await client.node({ tree: "local", path: join(root, "notes", "today") });
    expect(note.enclosingTree).toMatchObject({ placement: "local", legacy: true, osPath: root });
  });

  test("removes the public roots administration surface", async () => {
    expect((await fetch(`${base}/v1/roots`)).status).toBe(405);
    expect((await fetch(`${base}/v1/roots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    })).status).toBe(405);
  });

  test("requires singleton system mutations", async () => {
    const response = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "mixed-system-domain",
        operations: [
          { op: "connectCommunity", origin: "https://example.invalid", accountToken: "secret" },
          { op: "createDirectory", path: "/new" },
        ],
      }),
    });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toBe("unsupported-operation");
  });

  test("promotes a legacy placement transactionally and never journals its token", async () => {
    const rawToken = "owner-system-test";
    await client.mutateSystem({ op: "connectCommunity", origin: host.url, accountToken: rawToken });
    const receipt = await client.mutateSystem({
      op: "promoteTree",
      path: root,
      canonicalPath: "/~owner/garden",
      audience: { kind: "private" },
    });
    const tree = receipt.effects.find((effect) => effect.tree?.startsWith("tr_"))!.tree!;
    expect(arbor.service.session.tree).toBe(tree);

    const record = await client.node({ tree: "system", path: `/trees/${tree}` });
    expect(record.document?.frontmatter).toMatchObject({
      placement: "shared",
      canonical: `arbor://${new URL(host.url).host}/~owner/garden`,
      publicAccess: "none",
    });
    const registry = await readFile(join(state, "trees.yaml"), "utf8");
    expect(registry).toContain(`source: arbor://tree/${tree}/`);
    expect(registry).not.toContain("source: local");

    await client.mutateSystem({ op: "setTreeAccess", tree, subject: { kind: "everyone" }, access: "read" });
    expect((await fetch(`${host.url}/~owner/garden`)).status).toBe(200);

    const textFiles = async (directory: string): Promise<string[]> => {
      const result: string[] = [];
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) result.push(...await textFiles(path));
        else if (/\.(?:json|md|yaml)$/.test(item.name)) result.push(await readFile(path, "utf8"));
      }
      return result;
    };
    expect((await textFiles(state)).join("\n")).not.toContain(rawToken);
  });

  test("hydrates every system tree record from one coherent authority projection", async () => {
    const originalFetch = globalThis.fetch;
    const authorityRequests: string[] = [];
    const countingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(host.url)) authorityRequests.push(new URL(url).pathname);
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(countingFetch, { preconnect: originalFetch.preconnect });
    try {
      arbor.service.trees.invalidateDescriptors();
      const directory = await client.node({ tree: "system", path: "/trees" });
      await Promise.all((directory.children ?? []).map((child) =>
        client.node({ tree: "system", path: child.path })
      ));
      await Promise.all((directory.children ?? []).map((child) =>
        client.node({ tree: "system", path: child.path })
      ));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(authorityRequests.filter((path) => path === "/.arbor/trees")).toHaveLength(1);
    expect(authorityRequests.filter((path) => path === "/.arbor/account")).toHaveLength(1);
    const accessRequests = authorityRequests.filter((path) => path.endsWith("/access"));
    expect(new Set(accessRequests).size).toBe(accessRequests.length);
  });

  test("projection freshness, revision invalidation, and in-flight coalescing use an injected monotonic clock", async () => {
    let now = 0;
    const control = await ArborService.openControl({ autoSync: false, monotonicNow: () => now });
    const originalFetch = globalThis.fetch;
    const authorityRequests: string[] = [];
    const countingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(host.url)) authorityRequests.push(new URL(url).pathname);
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(countingFetch, { preconnect: originalFetch.preconnect });
    try {
      const directory = await control.snapshot({ tree: "system", path: "/trees" });
      const children = directory.children ?? [];
      await Promise.all(children.map((child) => control.snapshot({ tree: "system", path: child.path })));
      expect(authorityRequests.filter((path) => path === "/.arbor/trees")).toHaveLength(1);
      const readDirectChild = () => control.snapshot({ tree: "system", path: "/trees/not-present" }).catch(() => null);

      now = 999;
      await readDirectChild();
      expect(authorityRequests.filter((path) => path === "/.arbor/trees")).toHaveLength(1);

      now = 1_001;
      await readDirectChild();
      expect(authorityRequests.filter((path) => path === "/.arbor/trees")).toHaveLength(2);

      control.trees.invalidateDescriptors();
      await Promise.all(Array.from({ length: 7 }, readDirectChild));
      expect(authorityRequests.filter((path) => path === "/.arbor/trees")).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
      await control[Symbol.asyncDispose]();
    }
  });

  test("returns bounded local tree state and marks placements offline", async () => {
    host.server.stop(true);
    arbor.service.trees.invalidateDescriptors();
    const originalFetch = globalThis.fetch;
    let authorityTreeRequests = 0;
    const countingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(host.url) && new URL(url).pathname === "/.arbor/trees") authorityTreeRequests += 1;
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(countingFetch, { preconnect: originalFetch.preconnect });
    const started = performance.now();
    let shared: Awaited<ReturnType<ArbordClient["node"]>>[];
    try {
      const trees = await client.node({ tree: "system", path: "/trees" });
      shared = await Promise.all((trees.children ?? []).map((child) =>
        client.node({ tree: "system", path: child.path })
      ));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(authorityTreeRequests).toBe(1);
    expect(shared.some((record) => record.document?.frontmatter.sync === "offline")).toBe(true);
  });
});
