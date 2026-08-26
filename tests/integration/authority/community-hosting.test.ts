import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateArborID, sha256 } from "@arbor/core";
import { serveWireHost } from "@arbor/authority";
import { snapshotDirectory, WireClient } from "@arbor/wire";
import { snapshotAccountConfig } from "../../../packages/authority/src/account-policy.ts";

const ownerToken = "owner-device-credential";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveWireHost>>;
let owner: WireClient;

async function profileFolder(name: string, kind: "person" | "group", members: string[] = []): Promise<string> {
  const path = join(sandbox, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "_index.md"), [
    "---",
    `type: ${kind}`,
    ...(kind === "group" ? ["members:", ...members.map((member) => `  - ${JSON.stringify(member)}`)] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
  return path;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-account-claim-"));
  running = await serveWireHost({
    dataRoot: join(sandbox, "authority"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }],
  });
  owner = new WireClient(running.url, ownerToken);

  const account = await owner.account();
  const community = await owner.ref(account.account.community.id);
  const ownerLocator = `arbor://${new URL(running.url).host}/~owner`;
  const aliceLocator = `arbor://${new URL(running.url).host}/~alice`;
  const source = await profileFolder("community", "group", [ownerLocator, aliceLocator]);
  const next = await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]]));
  await owner.submitUpdate(
    community.snapshot.id,
    { root: community.snapshot.ref, update: community.snapshot.update },
    next,
  );
});

afterAll(async () => {
  running.server.stop(true);
  await running.authority[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("client-generated profile and account-configuration bootstrap", () => {
  test("claims generated identities atomically and only accepts an exact retry", async () => {
    const profileTree = generateArborID("tr");
    const configurationTree = generateArborID("tr");
    const deviceID = generateArborID("dv");
    const credential = "locally-generated-alice-credential";
    const credentialDigest = `sha256:${sha256(credential)}` as const;
    const profile = await snapshotDirectory(await profileFolder("alice", "person"));
    const configuration = snapshotAccountConfig({
      account: {
        version: 1,
        community: new URL(running.url).origin,
        profile: { tree: profileTree, handle: "alice" },
        admins: [deviceID],
      },
      trees: {
        version: 1,
        trees: {
          [profileTree]: {
            kind: "person-profile",
            canonicalPath: "/~alice",
            access: [{ subject: { kind: "everyone" }, access: "read" }],
          },
        },
      },
      devices: {
        [deviceID]: {
          version: 1,
          id: deviceID,
          label: "Alice's Mac",
          placements: {
            [profileTree]: { authority: new URL(running.url).origin, path: join(sandbox, "alice") },
          },
        },
      },
    });
    const request = {
      profileTree,
      configurationTree,
      device: { id: deviceID, label: "Alice's Mac", credentialDigest },
      profile,
      configuration,
    };

    const claimed = await new WireClient(running.url).claim("alice", request);
    expect(claimed.tree).toMatchObject({ id: profileTree, kind: "person-profile", access: "write" });
    expect(claimed.tree.canonical?.path).toBe("/~alice");
    expect(claimed.configuration).toMatchObject({ id: configurationTree, kind: "account-configuration", canonical: null });
    expect(JSON.stringify(claimed)).not.toContain(credential);
    expect(await new WireClient(running.url, credential).account()).toMatchObject({
      account: { handle: "alice", configuration: { id: configurationTree, canonical: null } },
    });

    expect(await new WireClient(running.url).claim("alice", request)).toEqual(claimed);
    const changedProfile = await snapshotDirectory(await profileFolder("alice-changed", "person"));
    await expect(new WireClient(running.url).claim("alice", { ...request, profile: changedProfile }))
      .rejects.toThrow("already-claimed");
  });

  test("rejects unreserved handles without creating either tree", async () => {
    const profileTree = generateArborID("tr");
    const configurationTree = generateArborID("tr");
    const deviceID = generateArborID("dv");
    const profile = await snapshotDirectory(await profileFolder("mallory", "person"));
    const configuration = snapshotAccountConfig({
      account: { version: 1, community: new URL(running.url).origin, profile: { tree: profileTree, handle: "mallory" }, admins: [deviceID] },
      trees: { version: 1, trees: { [profileTree]: { kind: "person-profile", canonicalPath: "/~mallory", access: [] } } },
      devices: { [deviceID]: { version: 1, id: deviceID, label: "Mallory", placements: {} } },
    });
    await expect(new WireClient(running.url).claim("mallory", {
      profileTree,
      configurationTree,
      device: { id: deviceID, label: "Mallory", credentialDigest: `sha256:${sha256("mallory-secret")}` },
      profile,
      configuration,
    })).rejects.toThrow("not reserved");
    expect(running.authority.get(profileTree)).toBeNull();
    expect(running.authority.get(configurationTree)).toBeNull();
  });
});
