import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServerConfigStore } from "@arbor/stores";
import { decodeWireObject, serveWireHost, WireClient } from "@arbor/wire";
import { ArborService } from "@arbor/arbord";

let sandbox: string;
let source: string;
let destination: string;
let stateA: string;
let stateB: string;
let host: Awaited<ReturnType<typeof serveWireHost>>;

async function arbor(args: string[], state: string): Promise<string> {
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...Bun.env,
      ARBOR_DATA_HOME: state,
      ARBOR_ACCOUNT_TOKEN: "cli-sync-owner",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function arborFailure(args: string[], env: Record<string, string>): Promise<string> {
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(exit).not.toBe(0);
  return stderr;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-cli-sync-"));
  source = join(sandbox, "source");
  destination = join(sandbox, "destination");
  stateA = join(sandbox, "state-a");
  stateB = join(sandbox, "state-b");
  await Promise.all([source, stateA, stateB].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(source, "note.md"), "# CLI sync\n");
  host = await serveWireHost({
    dataRoot: join(sandbox, "host"),
    accounts: [{ handle: "owner", token: "cli-sync-owner", communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = stateA;
  await new ServerConfigStore().remove();
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("primary CLI sync forms", () => {
  test("refuses an ephemeral or unnamed Railway authority", async () => {
    const noDomain = await arborFailure(["serve"], {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ARBOR_PUBLIC_ORIGIN: "",
    });
    expect(noDomain).toContain("needs a public domain");

    const noVolume = await arborFailure(["serve"], {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "garden.up.railway.app",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ARBOR_PUBLIC_ORIGIN: "",
    });
    expect(noVolume).toContain("needs a persistent volume");
  });

  test("idempotently promotes and reconciles public access", async () => {
    const canonical = `${host.url}/~owner/notes`;
    expect(await arbor(["connect", host.url], stateA)).toContain("Connected as ~owner");
    expect(await arbor(["sync", source, canonical, "-public-read"], stateA)).toContain("/~owner/notes");
    expect(await arbor(["sync", source, canonical, "-public-read"], stateA)).toContain("/~owner/notes");
    const shared = host.authority.boundary("/~owner/notes")!;
    expect(shared.publicAccess).toBe("read");
    const root = decodeWireObject(await host.authority.object(shared.ref));
    expect(root.type).toBe("directory");
    if (root.type === "directory") {
      for (const entry of root.entries) {
        if (entry.hash) expect((await fetch(`${host.url}/.arbor/objects/${entry.hash}`)).status).toBe(200);
      }
    }
  });

  test("idempotently places a canonical URL", async () => {
    const canonical = `${host.url}/~owner/notes`;
    expect(await arbor(["sync", canonical, destination], stateB)).toContain("(read)");
    expect(await arbor(["sync", canonical, destination], stateB)).toContain("(read)");
    expect(await readFile(join(destination, "note.md"), "utf8")).toBe("# CLI sync\n");

    process.env.ARBOR_DATA_HOME = stateB;
    const service = await ArborService.open(destination);
    try {
      const tree = host.authority.boundary("/~owner/notes")!.id;
      expect((await service.snapshot({ tree, path: "/note" })).writable).toBe(false);
      await expect(service.executeMutation({
        mutationID: "read-only-placement",
        operations: [{ op: "createMarkdown", tree, path: "/blocked" }],
      })).rejects.toMatchObject({ code: "read-only" });

      await new WireClient(host.url, "cli-sync-owner").setPublicAccess(tree, "write");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if ((await service.snapshot({ tree, path: "/note" })).writable) break;
        await Bun.sleep(100);
      }
      expect((await service.snapshot({ tree, path: "/note" })).writable).toBe(true);
      await service.executeMutation({
        mutationID: "anonymous-public-write",
        operations: [{ op: "createMarkdown", tree, path: "/public-note" }],
      });
      const publishedRoot = decodeWireObject(await host.authority.object(host.authority.get(tree)!.ref));
      expect(publishedRoot.type === "directory" && publishedRoot.entries.some((entry) => entry.name === "public-note.md")).toBe(true);
    } finally {
      await service[Symbol.asyncDispose]();
    }
  });
});
