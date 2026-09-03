import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateArborID, sha256 } from "@arbor/core";
import { serveCanopy } from "@arbor/canopy";
import { ArborSyncDaemon } from "@arbor/arborsync";
import { CanopyAccountStore } from "@arbor/stores";
import { WireClient } from "@arbor/wire";
import { snapshotAccountConfig } from "../../../packages/canopy/src/account-policy.ts";
import { readAccountConfigGraphV2, snapshotAccountConfigV2 } from "../../../packages/canopy/src/account-policy-v2.ts";
import { snapshotDirectory } from "@arbor/fs";

const ownerToken = "owner-device-credential";
const aliceProfileTree = generateArborID("tr");
const bobProfileTree = generateArborID("tr");
let sandbox: string;
let running: Awaited<ReturnType<typeof serveCanopy>>;
let owner: WireClient;

type CommunityMember = string | { profile?: string; handle?: string };

async function profileFolder(name: string, kind: "person" | "group", members: CommunityMember[] = []): Promise<string> {
  const path = join(sandbox, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "_index.md"), [
    "---",
    `type: ${kind}`,
    ...(kind === "group" ? ["members:", ...members.flatMap((member) => typeof member === "string"
      ? [`  - ${JSON.stringify(member)}`]
      : ["  -", ...(member.profile ? [`    profile: ${JSON.stringify(member.profile)}`] : []), ...(member.handle ? [`    handle: ${JSON.stringify(member.handle)}`] : [])])] : []),
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
  const community = await owner.descriptor(account.account.community.id);
  const source = await profileFolder("community", "group", [
    { profile: `arbor://${account.account.profileTree!}/`, handle: "owner" },
    { profile: `arbor://${aliceProfileTree}/`, handle: "alice" },
    { profile: `arbor://${bobProfileTree}/`, handle: "bob" },
  ]);
  const next = await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]]));
  await owner.submitUpdate(
    community.tree.id,
    community.tree.update,
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
    const profileTree = aliceProfileTree;
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

  test("v2 account claim does not host the local profile; ordinary activation does", async () => {
    const origin = new URL(running.url).origin;
    const profileTree = bobProfileTree;
    const configurationTree = generateArborID("tr");
    const declaredTree = generateArborID("tr");
    const administratorID = generateArborID("dv");
    const administratorCredential = "locally-generated-bob-credential";
    const profile = await snapshotDirectory(await profileFolder("bob", "person"));
    const configuration = snapshotAccountConfigV2({
      account: { canopy: origin, profile: profileTree },
      trees: {
        [profileTree]: { canonical: `${origin}/~bob`, access: [{ subject: { kind: "everyone" }, access: "read" }] },
        [declaredTree]: { canonical: `${origin}/~bob/notes`, access: [] },
      },
      devices: {
        [administratorID]: { id: administratorID, label: "Bob's Mac", administrator: true },
      },
    });
    const request = {
      profileTree,
      configurationTree,
      device: {
        id: administratorID,
        label: "Bob's Mac",
        credentialDigest: `sha256:${sha256(administratorCredential)}` as const,
      },
      configuration,
    };
    const outsideAllocation = snapshotAccountConfigV2({
      account: { canopy: origin, profile: profileTree },
      trees: { [profileTree]: { canonical: `${origin}/~alice/bob`, access: [] } },
      devices: { [administratorID]: { id: administratorID, label: "Bob's Mac", administrator: true } },
    });
    await expect(new WireClient(running.url).joinAccount({
      account: `${origin}/~bob`,
      ...request,
      configuration: outsideAllocation,
    })).rejects.toThrow("outside this Canopy account allocation");
    const claimed = await new WireClient(running.url).joinAccount({ account: `${origin}/~bob`, ...request });
    expect(claimed.account).toMatchObject({ handle: "bob", profileTree });
    expect(running.canopy.get(profileTree)).toBeNull();
    expect(running.canopy.boundary("/~bob")).toBeNull();
    const administrator = new WireClient(running.url, administratorCredential);

    const hostedProfile = await administrator.submitUpdate(profileTree, null, profile);
    expect(hostedProfile.outcome).toBe("accepted");
    expect((await administrator.descriptor(profileTree)).tree.canonical?.path).toBe("/~bob");

    const offer = await administrator.createPairing();
    const phoneID = generateArborID("dv");
    const phoneCredential = "locally-generated-bob-phone-credential";
    const phone = {
      id: phoneID,
      label: "Bob's iPhone",
      credentialDigest: `sha256:${sha256(phoneCredential)}` as const,
    };
    const firstClaim = await new WireClient(running.url).claimPairing(offer.id, offer.secret, phone);
    expect(firstClaim.device.id).toBe(phoneID);
    expect(await new WireClient(running.url).claimPairing(offer.id, offer.secret, phone)).toEqual(firstClaim);

    const acceptedConfiguration = await administrator.currentSnapshot(configurationTree);
    const graph = readAccountConfigGraphV2(acceptedConfiguration.snapshot, configurationTree);
    expect(graph.devices[phoneID]).toEqual({ id: phoneID, label: "Bob's iPhone", administrator: false });
    expect(JSON.stringify(graph)).not.toContain("placements");

    const treeSource = join(sandbox, "bob-notes");
    await mkdir(treeSource, { recursive: true });
    await writeFile(join(treeSource, "_index.md"), "# Bob's notes\n");
    const activated = await administrator.submitUpdate(declaredTree, null, await snapshotDirectory(treeSource));
    expect(activated.outcome).toBe("accepted");
    expect((await administrator.descriptor(declaredTree)).tree.canonical?.path).toBe("/~bob/notes");
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

  test("a fresh opted-in data home writes only the plural v2 layout", async () => {
    const previous = process.env.ARBOR_DATA_HOME;
    const home = join(sandbox, "v2-bootstrap-home");
    const profilePath = join(sandbox, "charlie-profile");
    await mkdir(home, { recursive: true });
    await mkdir(profilePath, { recursive: true });
    process.env.ARBOR_DATA_HOME = home;
    const service = await ArborSyncDaemon.openControl({ autoSync: false });
    const configurationTrees: string[] = [];
    try {
      await service.openSession(profilePath);
      const localProfileTree = service.session.tree;
      const ownerAccount = running.canopy.accountByHandle("owner")!;
      const community = await owner.descriptor(running.canopy.community().id);
      const source = await profileFolder("community-with-charlie", "group", [
        { profile: `arbor://${ownerAccount.profileTree!}/`, handle: "owner" },
        { profile: `arbor://${aliceProfileTree}/`, handle: "alice" },
        { profile: `arbor://${bobProfileTree}/`, handle: "bob" },
        { profile: `arbor://${localProfileTree}/`, handle: "charlie" },
        { handle: "orphan" },
      ]);
      const nested = new Map(running.canopy.list()
        .filter((tree) => tree.parentTree === community.tree.id && tree.canonicalPath)
        .map((tree) => [join(source, tree.canonicalPath!.split("/").filter(Boolean).at(-1)!), tree.id]));
      await owner.submitUpdate(community.tree.id, community.tree.update, await snapshotDirectory(source, nested));
      expect(running.canopy.isReservedHandle("orphan")).toBe(false);

      await service.claimCanopyAccount(`${new URL(running.url).origin}/~charlie`, profilePath, "Charlie");
      const accounts = await service.accountList();
      expect(accounts).toHaveLength(1);
      const configurationTree = accounts[0]!.configurationTree;
      configurationTrees.push(configurationTree);
      expect(accounts[0]).toMatchObject({ handle: "charlie", credentialAvailable: true });
      expect(await readFile(join(home, "accounts", configurationTree, "account.yaml"), "utf8"))
        .toContain(`profile: ${JSON.stringify(localProfileTree)}`);
      expect(await readFile(join(home, "accounts", configurationTree, "account.yaml"), "utf8"))
        .not.toContain("handle:");
      expect(await readFile(join(home, "accounts", configurationTree, "devices.yaml"), "utf8"))
        .not.toContain("placements");
      expect(await readFile(join(home, "placements.yaml"), "utf8"))
        .toBe("{}\n");
      await expect(readFile(join(home, "account.yaml"), "utf8")).rejects.toThrow();

      const communityAfterClaim = await owner.descriptor(running.canopy.community().id);
      const secondSource = await profileFolder("community-with-charlie-twice", "group", [
        { profile: `arbor://${ownerAccount.profileTree!}/`, handle: "owner" },
        { profile: `arbor://${aliceProfileTree}/`, handle: "alice" },
        { profile: `arbor://${bobProfileTree}/`, handle: "bob" },
        { profile: `arbor://${localProfileTree}/`, handle: "charlie" },
        { profile: `arbor://${localProfileTree}/`, handle: "charlie-two" },
      ]);
      const secondNested = new Map(running.canopy.list()
        .filter((tree) => tree.parentTree === communityAfterClaim.tree.id && tree.canonicalPath)
        .map((tree) => [join(secondSource, tree.canonicalPath!.split("/").filter(Boolean).at(-1)!), tree.id]));
      await owner.submitUpdate(communityAfterClaim.tree.id, communityAfterClaim.tree.update, await snapshotDirectory(secondSource, secondNested));
      const retainedPlacements = `${configurationTree}: {}\n`;
      await writeFile(join(home, "placements.yaml"), retainedPlacements);

      await service.claimCanopyAccount(`${new URL(running.url).origin}/~charlie-two`, profilePath, "Charlie");
      const pluralAccounts = await service.accountList();
      expect(pluralAccounts).toHaveLength(2);
      expect(new Set(pluralAccounts.map((account) => account.profileTree))).toEqual(new Set([localProfileTree]));
      expect(new Set(pluralAccounts.map((account) => account.handle))).toEqual(new Set(["charlie", "charlie-two"]));
      configurationTrees.push(pluralAccounts.find((account) => account.configurationTree !== configurationTree)!.configurationTree);
      expect(await readFile(join(home, "placements.yaml"), "utf8")).toBe(retainedPlacements);
    } finally {
      await service[Symbol.asyncDispose]();
      await Promise.all(configurationTrees.map((configurationTree) => new CanopyAccountStore(configurationTree).remove()));
      if (previous === undefined) delete process.env.ARBOR_DATA_HOME;
      else process.env.ARBOR_DATA_HOME = previous;
    }
  });
});

describe("profile invariants derived from root frontmatter", () => {
  async function submitRoot(tree: string, source: string) {
    const current = await owner.descriptor(tree);
    const nested = new Map(running.canopy.list()
      .filter((candidate) => candidate.parentTree === tree && candidate.canonicalPath)
      .map((candidate) => [join(source, candidate.canonicalPath!.split("/").filter(Boolean).at(-1)!), candidate.id]));
    return owner.submitUpdate(tree, current.tree.update, await snapshotDirectory(source, nested));
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

describe("existing profile account proof", () => {
  test("joins a second Canopy without copying or locating the profile tree", async () => {
    const issuerRoot = join(sandbox, "proof-issuer");
    const targetRoot = join(sandbox, "proof-target");
    const issuer = await serveCanopy({
      dataRoot: issuerRoot,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [{ handle: "issuer", token: "issuer-token" }],
    });
    const target = await serveCanopy({
      dataRoot: targetRoot,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [{ handle: "target-admin", token: "target-admin-token" }],
      community: { handle: "target", name: "Target", firstWriter: { handle: "guest" } },
    });
    try {
      const targetAdmin = new WireClient(target.url, "target-admin-token");
      const targetAdminAccount = await targetAdmin.account();
      const targetCommunity = await targetAdmin.descriptor(targetAdminAccount.account.community.id);
      const targetAccountLocator = `${new URL(target.url).origin}/~guest`;
      const targetCommunitySource = await profileFolder("proof-target-community", "group", [
        { profile: `arbor://${targetAdminAccount.account.profileTree!}/`, handle: "target-admin" },
        { profile: `arbor://${issuer.canopy.accountByHandle("issuer")!.profileTree!}/`, handle: "guest" },
      ]);
      const targetCommunitySnapshot = await snapshotDirectory(targetCommunitySource, new Map([
        [join(targetCommunitySource, "~target-admin"), targetAdminAccount.account.profileTree!],
      ]));
      await targetAdmin.submitUpdate(targetCommunity.tree.id, targetCommunity.tree.update, targetCommunitySnapshot);

      const issuerClient = new WireClient(issuer.url, "issuer-token");
      const issuerAccount = await issuerClient.account();
      const profileTree = issuerAccount.account.profileTree!;
      const configurationTree = generateArborID("tr");
      const deviceID = generateArborID("dv");
      const credential = "guest-target-credential";
      const proofID = generateArborID("pp");
      const proofSecret = "one-time-profile-proof";
      const configuration = snapshotAccountConfigV2({
        account: { canopy: new URL(target.url).origin, profile: profileTree },
        trees: {},
        devices: { [deviceID]: { id: deviceID, label: "Guest's Mac", administrator: true } },
      });
      const proof = await issuerClient.createProfileProof({
        id: proofID,
        secretDigest: `sha256:${sha256(proofSecret)}`,
        targetOrigin: new URL(target.url).origin,
        targetAccount: targetAccountLocator,
        configurationTree,
      });
      expect(proof).toMatchObject({ id: proofID, profileTree, targetAccount: targetAccountLocator, configurationTree });
      expect(await readFile(join(issuerRoot, "profile-proofs", `${proofID}.json`), "utf8")).not.toContain(proofSecret);

      const request = {
        account: targetAccountLocator,
        issuerOrigin: new URL(issuer.url).origin,
        proof: { id: proofID, secret: proofSecret },
        profileTree,
        configurationTree,
        device: {
          id: deviceID,
          label: "Guest's Mac",
          credentialDigest: `sha256:${sha256(credential)}` as const,
        },
        configuration,
      };
      const joined = await new WireClient(target.url).joinAccount(request);
      expect(joined.account).toMatchObject({ handle: "guest", profileTree, profileURL: null });
      expect(joined.configuration).toMatchObject({ id: configurationTree, kind: "account-configuration" });
      expect(target.canopy.get(profileTree)).toBeNull();
      expect(target.canopy.boundary("/~guest")).toBeNull();
      expect(await new WireClient(target.url).joinAccount(request)).toEqual(joined);
      expect((await new WireClient(target.url, credential).account()).account.configuration.id).toBe(configurationTree);

      await expect(new WireClient(target.url).joinAccount({
        ...request,
        proof: { id: proofID, secret: "wrong" },
      })).rejects.toThrow("could not be verified");
    } finally {
      issuer.server.stop(true);
      target.server.stop(true);
      await issuer.canopy[Symbol.asyncDispose]();
      await target.canopy[Symbol.asyncDispose]();
    }
  });
});
