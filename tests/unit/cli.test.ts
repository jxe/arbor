import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedArborSyncURL, openTarget } from "../../packages/cli/src/index.ts";
import { resolveUserPath, serveArborSync } from "@arbor/arborsync";
import { communityCredentialName } from "@arbor/stores";

describe("arbor open operands", () => {
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
    const running = await serveArborSync(root, { port: 0 });
    try {
      const port = Number(new URL(running.url).port);
      expect((await attachedArborSyncURL({ path: root }, port))?.toString())
        .toBe(`${running.url}/render${root}`);
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  });
});
