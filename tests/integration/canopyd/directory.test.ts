import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient } from "@overstory/protocol";

let root: string;
let running: Awaited<ReturnType<typeof serveCanopy>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-directory-"));
  running = await serveCanopy({
    dataRoot: root,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [
      { handle: "alice", token: "alice-directory-token", name: "Alice Arbor", communityWriter: true },
      { handle: "bob", token: "bob-directory-token", name: "Bob Builder" },
    ],
  });
});

afterAll(async () => {
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

describe("authenticated user directory", () => {
  test("lists the signed-in profile and another readable community member with card and identity fields", async () => {
    const client = new WireClient(running.url, "alice-directory-token");
    const own = (await client.account()).account.profileTree;
    const directory = await client.directory();
    expect(directory.observedThrough).toBeTruthy();
    const alice = directory.snapshot.find((entry) => entry.profile === own);
    expect(alice).toMatchObject({
      kind: "person",
      handle: "alice",
      displayName: "Alice Arbor",
    });
    expect(alice?.sources).toContain("community");
    const bob = directory.snapshot.find((entry) => entry.handle === "bob");
    expect(bob).toMatchObject({ kind: "person", displayName: "Bob Builder" });
    expect(bob?.sources).toContain("community");
  });

  test("rejects anonymous callers", async () => {
    expect((await fetch(`${running.url}/.arbor/directory`)).status).toBe(401);
  });
});
