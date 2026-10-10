import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../helpers/devices.ts";
import { editTreeConfig } from "../../helpers/tree-config.ts";

let root: string;
let running: Awaited<ReturnType<typeof serveHost>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "story-directory-"));
  running = await serveHost({
    dataRoot: root,
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [
      testAccount("alice", "alice-directory-token", { name: "Alice Story", communityWriter: true }),
      testAccount("bob", "bob-directory-token", { name: "Bob Builder" }),
    ],
  });
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

describe("authenticated user directory", () => {
  test("lists the signed-in profile and another readable community member with card and identity fields", async () => {
    const client = await deviceClient(running.url, "alice-directory-token");
    const own = (await client.account()).account.profileTree;
    const directory = await client.directory();
    expect(Object.keys(directory)).toEqual(["snapshot"]);
    const alice = directory.snapshot.find((entry) => entry.profile === own);
    expect(alice).toMatchObject({
      kind: "person",
      handle: "alice",
      displayName: "Alice Story",
    });
    expect(alice?.sources).toContain("community");
    const bob = directory.snapshot.find((entry) => entry.handle === "bob");
    expect(bob).toMatchObject({ kind: "person", displayName: "Bob Builder" });
    expect(bob?.sources).toContain("community");
  });

  test("lists a profile an administered tree's rules name, however narrowly scoped", async () => {
    const alice = await deviceClient(running.url, "alice-directory-token");
    const bob = await deviceClient(running.url, "bob-directory-token");
    const own = (await alice.account()).account.id;
    const bobProfile = (await bob.account()).account.id;
    // Bob's profile tree is his; only Alice's rule on her own tree names him.
    await editTreeConfig(alice, own, "person", (values) => ({
      ...values,
      access: [...values.access, { who: { profile: bobProfile }, within: "/notes", allow: ["read"] }],
    }));
    const entry = (await alice.directory()).snapshot.find((candidate) => candidate.profile === bobProfile);
    expect(entry?.sources).toContain("access");
  });

  test("rejects anonymous callers", async () => {
    expect((await fetch(`${running.url}/.overstory/directory`)).status).toBe(401);
  });
});
