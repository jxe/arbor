import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateArborID, sha256 } from "@arbor/core";
import { serveCanopy } from "@arbor/canopy";
import { WireClient } from "@arbor/wire";
import { snapshotAccountConfig } from "../../../packages/canopy/src/account-policy.ts";
import { snapshotDirectory } from "@arbor/fs";

const ownerToken = "owner-device-credential";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveCanopy>>;
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
  running = await serveCanopy({
    dataRoot: join(sandbox, "canopy"),
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
    community.snapshot.update,
    next,
  );
});

afterAll(async () => {
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
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
            [profileTree]: { server: new URL(running.url).origin, path: join(sandbox, "alice") },
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
    expect(claimed.tree).toMatchObject({ id: profileTree, kind: "ordinary", access: "write" });
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
      trees: { version: 1, trees: { [profileTree]: { canonicalPath: "/~mallory", access: [] } } },
      devices: { [deviceID]: { version: 1, id: deviceID, label: "Mallory", placements: {} } },
    });
    await expect(new WireClient(running.url).claim("mallory", {
      profileTree,
      configurationTree,
      device: { id: deviceID, label: "Mallory", credentialDigest: `sha256:${sha256("mallory-secret")}` },
      profile,
      configuration,
    })).rejects.toThrow("not reserved");
    expect(running.canopy.get(profileTree)).toBeNull();
    expect(running.canopy.get(configurationTree)).toBeNull();
  });
});

describe("profile invariants derived from root frontmatter", () => {
  async function submitRoot(tree: string, source: string) {
    const current = await owner.ref(tree);
    const nested = new Map(running.canopy.list()
      .filter((candidate) => candidate.parentTree === tree && candidate.canonicalPath)
      .map((candidate) => [join(source, candidate.canonicalPath!.split("/").filter(Boolean).at(-1)!), candidate.id]));
    return owner.submitUpdate(tree, current.snapshot.update, await snapshotDirectory(source, nested));
  }

  test("a person profile listing members does not expand as a group ACL subject", async () => {
    const ownerAccount = running.canopy.accountByHandle("owner")!;
    const alice = running.canopy.accountByHandle("alice")!;
    const community = running.canopy.community();
    const aliceLocator = `arbor://${new URL(running.url).host}/~alice`;
    expect(running.canopy.canWrite(ownerAccount, community.id)).toBe(true);
    expect(running.canopy.canWrite(alice, community.id)).toBe(false);

    const source = await profileFolder("owner-with-members", "person");
    await writeFile(join(source, "_index.md"), ["---", "type: person", "members:", `  - ${JSON.stringify(aliceLocator)}`, "---", "", "# Owner", ""].join("\n"));
    await submitRoot(ownerAccount.profileTree!, source);
    expect(running.canopy.rootProfileType(running.canopy.get(ownerAccount.profileTree!)!.ref)).toBe("person");
    expect(running.canopy.canWrite(alice, community.id)).toBe(false);
    expect(running.canopy.canRead(alice, community.id)).toBe(true);
  });

  test("an account's profile tree must keep type: person and the community root type: group", async () => {
    const ownerAccount = running.canopy.accountByHandle("owner")!;
    await expect(submitRoot(ownerAccount.profileTree!, await profileFolder("owner-as-group", "group")))
      .rejects.toThrow(/type: person/);
    await expect(submitRoot(running.canopy.community().id, await profileFolder("community-as-person", "person")))
      .rejects.toThrow(/type: group/);
  });
});
