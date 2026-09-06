import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedArborSyncURL, openTarget } from "../../packages/cli/src/index.ts";
import { resolveUserPath, serveArborSync } from "@arbor/arborsync";
import { communityCredentialName } from "@arbor/stores";

describe("arbor open operands", () => {
  test("rejects the removed --port option", async () => {
    const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "open", "--port", "4321"], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(2);
    expect(stderr).toContain("arbor open [<locator>]");
    expect(stderr).not.toContain("--port");
  });

  test("does not dispatch removed legacy and unfinished commands", async () => {
    for (const command of ["connect", "unsync", "connection", "sync", "rehome"]) {
      const child = Bun.spawn(["bun", "packages/cli/src/index.ts", command], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(2);
      expect(stderr).not.toContain(`arbor ${command}`);
    }
  });

  test("uses --dry-run rather than the removed --check spelling", async () => {
    const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "mv", "--check", "/tmp/source", "/tmp/destination"], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(1);
    expect(stderr).toContain("Unknown mv option: --check");
  });

  test("rejects mixed local and canonical move operands", async () => {
    const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "mv", "https://garden.example/~joe/notes", "/tmp/notes"], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(1);
    expect(stderr).toContain("requires either two local paths or two canonical URLs");
    expect(stderr).toContain("arbor place");
  });

  test("resolves local filesystem paths", () => {
    expect(openTarget("notes", "/Users/alice")).toEqual({ path: "/Users/alice/notes" });
  });

  test("recognizes a profile URL while preserving it as a remote location", () => {
    expect(openTarget("https://garden.example/~alice/", "/Users/alice")).toEqual({
      remoteURL: "https://garden.example/~alice/",
      profile: { origin: "https://garden.example", handle: "alice", path: "/~alice" },
    });
  });

  test("passes other Arbor locations to the remote browser", () => {
    expect(openTarget("arbor://garden.example/~alice/notes", "/Users/alice")).toEqual({
      remoteURL: "https://garden.example/~alice/notes",
    });
  });

  test("expands a typed home-relative profile path", () => {
    expect(resolveUserPath("~/.arbor/profile", "/Users/alice")).toBe("/Users/alice/.arbor/profile");
  });

  test("isolates active credentials by Arbor data home", () => {
    expect(communityCredentialName("/Users/alice/.arbor"))
      .not.toBe(communityCredentialName("/tmp/arbor-e2e-state"));
    expect(communityCredentialName("/Users/alice/.arbor"))
      .toBe(communityCredentialName("/Users/alice/.arbor"));
  });

  test("attaches to an existing Arbor Sync workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-open-attach-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-open-attach-state-"));
    const previousDataHome = process.env.ARBOR_DATA_HOME;
    process.env.ARBOR_DATA_HOME = state;
    const running = await serveArborSync(root, { port: 0 });
    try {
      const port = Number(new URL(running.url).port);
      expect((await attachedArborSyncURL({ path: root }, port))?.toString())
        .toBe(`${running.url}/render${root}`);
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
      if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
      else process.env.ARBOR_DATA_HOME = previousDataHome;
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("reports general status from an explicitly selected Arbor Sync without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-status-root-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-status-state-"));
    const previousDataHome = process.env.ARBOR_DATA_HOME;
    process.env.ARBOR_DATA_HOME = state;
    const running = await serveArborSync(root, { port: 0, instanceID: "status-test-instance" });
    try {
      const childEnvironment: Record<string, string | undefined> = { ...process.env, ARBOR_SYNC_URL: running.url };
      delete childEnvironment.ARBOR_DATA_HOME;
      const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "status", "--json"], {
        cwd: join(import.meta.dir, "../.."),
        env: childEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        schemaVersion: 1,
        context: { kind: "explicit-url", origin: running.url },
        runtime: { state: "running", instanceID: "status-test-instance" },
      });
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
      if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
      else process.env.ARBOR_DATA_HOME = previousDataHome;
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("rejects simultaneous cloud bundle argument and environment input", async () => {
    const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "cloud", "start", "argument-bundle"], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, ARBOR_CLOUD_BUNDLE: "environment-bundle" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(2);
    expect(stderr).toContain("argument or ARBOR_CLOUD_BUNDLE, not both");
    expect(stderr).not.toContain("environment-bundle");
  });

  test("uses exit 2 for malformed general status arguments", async () => {
    const child = Bun.spawn(["bun", "packages/cli/src/index.ts", "status", "--unknown"], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(2);
    expect(stderr).toContain("Unknown status option: --unknown");
  });
});
