import { decodeWireDirectory, encodeWireDirectory, generateArborID, hashObject, sha256, safeResourceRule, CanopyAccountStore, WireClient } from "@overstory/protocol";
import { stringify } from "yaml";
import { LocalAccountService } from "../../../packages/arborsync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveCanopy } from "@overstory/canopyd";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { ProfileIdentityStore } from "@overstory/arborsync/state";
import { readAccountConfigGraph, snapshotAccountConfig } from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { testProfileIdentity } from "../../helpers/profile-identity.ts";
import { acceptedEntries } from "../../support/log-entries.ts";

const ownerToken = "owner-device-credential";
const aliceProfileTree = generateArborID("tr");
const bobIdentity = testProfileIdentity();
const bobProfileTree = bobIdentity.profileTree;
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
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]])));
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
  test("does not expose the legacy snapshot-upload claim route", async () => {
    const response = await fetch(`${running.url}/.arbor/claims/alice`, { method: "PUT" });
    expect(response.status).toBe(404);
  });

  test("community-only challenges resolve the reservation without reading a profile", async () => {
    const client = new WireClient(running.url);
    const configurationTree = generateArborID("tr");
    const challenge = await client.createAccountChallenge({ profileTree: bobProfileTree, configurationTree });
    expect(challenge.account).toBe(`${new URL(running.url).origin}/~bob`);
    expect(challenge.profileTree).toBe(bobProfileTree);
    expect(challenge.configurationTree).toBe(configurationTree);
    await expect(client.createAccountChallenge({ profileTree: testProfileIdentity().profileTree, configurationTree }))
      .rejects.toThrow("has not reserved");
  });

  test("v2 account claim does not host the local profile; ordinary activation does", async () => {
    const origin = new URL(running.url).origin;
    const profileTree = bobProfileTree;
    const configurationTree = generateArborID("tr");
    const declaredTree = generateArborID("tr");
    const administratorID = generateArborID("dv");
    const administratorCredential = "locally-generated-bob-credential";
    const profile = await resolveSnapshot(await snapshotDirectory(await profileFolder("bob", "person")));
    const configuration = snapshotAccountConfig({
      account: { canopy: origin, profile: profileTree },
      resources: {
        [profileTree]: { canonical: `${origin}/~bob`, access: [{ who: "everyone", allow: ["read"] }] },
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
    const client = new WireClient(running.url);
    const challenge = await client.createAccountChallenge({ account: `${origin}/~bob`, profileTree, configurationTree });
    const identityProof = { challenge, publicKey: bobIdentity.publicKey, signature: bobIdentity.sign(challenge) };
    const wrongProfileAllocation = snapshotAccountConfig({
      account: { canopy: origin, profile: profileTree },
      resources: { [generateArborID("tr")]: { canonical: `${origin}/~bob`, access: [] } },
      devices: { [administratorID]: { id: administratorID, label: "Bob's Mac", administrator: true } },
    });
    await expect(new WireClient(running.url).joinAccount({
      account: `${origin}/~bob`,
      ...request,
      ...identityProof,
      configuration: wrongProfileAllocation,
    })).rejects.toThrow("account.profile must match a tree declaration at its canonical handle");
    const outsideAllocation = snapshotAccountConfig({
      account: { canopy: origin, profile: profileTree },
      resources: { [profileTree]: { canonical: `${origin}/~alice/bob`, access: [] } },
      devices: { [administratorID]: { id: administratorID, label: "Bob's Mac", administrator: true } },
    });
    await expect(new WireClient(running.url).joinAccount({
      account: `${origin}/~bob`,
      ...request,
      ...identityProof,
      configuration: outsideAllocation,
    })).rejects.toThrow("outside this Canopy account allocation");
    const claimed = await client.joinAccount({ account: `${origin}/~bob`, ...request, ...identityProof });
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

    const acceptedConfiguration = await administrator.descriptor(configurationTree);
    const acceptedSnapshot = await administrator.snapshot(configurationTree, acceptedConfiguration.tree.root);
    const graph = readAccountConfigGraph(acceptedSnapshot, configurationTree);
    expect(graph.devices[phoneID]).toEqual({ id: phoneID, label: "Bob's iPhone", administrator: false });
    expect(JSON.stringify(graph)).not.toContain("placements");

    const treeSource = join(sandbox, "bob-notes");
    await mkdir(treeSource, { recursive: true });
    await writeFile(join(treeSource, "_index.md"), "# Bob's notes\n");
    const activated = await administrator.submitUpdate(declaredTree, null, await resolveSnapshot(await snapshotDirectory(treeSource)));
    expect(activated.outcome).toBe("accepted");
    expect((await administrator.descriptor(declaredTree)).tree.canonical?.path).toBe("/~bob/notes");
  });

  test("rejects unreserved identities without creating the configuration tree", async () => {
    const identity = testProfileIdentity();
    const profileTree = identity.profileTree;
    const configurationTree = generateArborID("tr");
    const origin = new URL(running.url).origin;
    const client = new WireClient(running.url);
    await expect(client.createAccountChallenge({ account: `${origin}/~mallory`, profileTree, configurationTree }))
      .rejects.toThrow("exact profile reservation");
    expect(running.canopy.get(configurationTree)).toBeNull();
  });

  test("a fresh opted-in data home writes only the plural v2 layout", async () => {
    const previous = process.env.ARBOR_DATA_HOME;
    const home = join(sandbox, "v2-bootstrap-home");
    const profilePath = join(sandbox, "charlie-profile");
    await mkdir(home, { recursive: true });
    await mkdir(profilePath, { recursive: true });
    process.env.ARBOR_DATA_HOME = home;
    await new ProfileIdentityStore().create(profilePath);
    const service = await ArborSyncDaemon.open(profilePath, {}, { autoSync: false });
    const configurationTrees: string[] = [];
    try {
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
      await owner.submitUpdate(community.tree.id, community.tree.update, await resolveSnapshot(await snapshotDirectory(source, nested)));
      expect(running.canopy.isReservedHandle("orphan")).toBe(false);

      const bootstrap = new LocalAccountService({ trees: service.trees, events: service.events });
      await expect(bootstrap.claimCanopyAccount(`${new URL(running.url).origin}/~unassigned`, profilePath))
        .rejects.toThrow();
      expect(await bootstrap.pendingClaim()).toMatchObject({ canCancel: true });
      expect(await bootstrap.accountList()).toHaveLength(0);
      await bootstrap.cancelPendingClaim();
      expect(await bootstrap.pendingClaim()).toBeNull();
      const originalJoin = WireClient.prototype.joinAccount;
      const interrupted = spyOn(WireClient.prototype, "joinAccount").mockImplementationOnce(async function (this: WireClient, input) {
        await originalJoin.call(this, input);
        throw new Error("Lost claim response");
      });
      try {
        await expect(bootstrap.claimCanopyAccount(new URL(running.url).origin, profilePath, "Charlie"))
          .rejects.toThrow("Lost claim response");
      } finally { interrupted.mockRestore(); }
      expect(await bootstrap.pendingClaim()).toEqual({ account: `${new URL(running.url).origin}/~charlie`, path: await realpath(profilePath), canCancel: false });
      await expect(bootstrap.cancelPendingClaim()).rejects.toThrow("may already have reached");
      // A fresh service resumes the exact claim even though the reservation is now claimed.
      await new LocalAccountService({ trees: service.trees, events: service.events })
        .claimCanopyAccount(new URL(running.url).origin, profilePath, "Charlie");
      expect(await bootstrap.pendingClaim()).toBeNull();
      const accounts = await new LocalAccountService({ trees: service.trees, events: service.events }).accountList();
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

      // A recovered profile still needs a new authorized device on a claimed account.
      const originalCredential = await bootstrap.credentialToken(configurationTree);
      const offer = await new WireClient(running.url, originalCredential).createPairing();
      const backupPath = join(sandbox, "charlie-identity-backup.json");
      await new ProfileIdentityStore().backup(backupPath);
      const pairedHome = join(sandbox, "charlie-paired-home");
      process.env.ARBOR_DATA_HOME = pairedHome;
      const pairedProfile = join(sandbox, "charlie-recovered-profile");
      await new ProfileIdentityStore().restore(backupPath, pairedProfile);
      const pairedDaemon = await ArborSyncDaemon.open(pairedProfile, {}, { autoSync: false });
      try {
        const paired = new LocalAccountService({ trees: pairedDaemon.trees, events: pairedDaemon.events });
        const originalPair = WireClient.prototype.claimPairing;
        const lostPair = spyOn(WireClient.prototype, "claimPairing").mockImplementationOnce(async function (this: WireClient, ...args) {
          await originalPair.apply(this, args);
          throw new Error("Lost pairing response");
        });
        try {
          await expect(paired.claimPairing({ version: 1, origin: new URL(running.url).origin, pairing: { id: offer.id, secret: offer.secret } }))
            .rejects.toThrow("Lost pairing response");
        } finally { lostPair.mockRestore(); }
        expect(await paired.pendingPairing()).toEqual({ origin: new URL(running.url).origin });
        await paired.claimPairing();
        expect(await paired.pendingPairing()).toBeNull();
        expect(await paired.accountList()).toMatchObject([{ configurationTree, profileTree: localProfileTree, credentialAvailable: true }]);
        const token = await paired.credentialToken(configurationTree);
        expect(token).not.toBe(originalCredential);
        const pairedAccount = await new WireClient(running.url, token).account();
        expect(pairedAccount.account.configuration.id).toBe(configurationTree);
        expect(pairedAccount.account.profileTree).toBe(localProfileTree);
        await new CanopyAccountStore(configurationTree).remove();
      } finally {
        await pairedDaemon[Symbol.asyncDispose]();
        process.env.ARBOR_DATA_HOME = home;
      }

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
      await owner.submitUpdate(communityAfterClaim.tree.id, communityAfterClaim.tree.update, await resolveSnapshot(await snapshotDirectory(secondSource, secondNested)));
      await expect(new WireClient(running.url).createAccountChallenge({
        profileTree: localProfileTree, configurationTree: generateArborID("tr"),
      })).rejects.toThrow("Several reservations");
      const retainedPlacements = `${configurationTree}: {}\n`;
      await writeFile(join(home, "placements.yaml"), retainedPlacements);

      await new LocalAccountService({ trees: service.trees, events: service.events }).claimCanopyAccount(`${new URL(running.url).origin}/~charlie-two`, profilePath, "Charlie");
      const pluralAccounts = await new LocalAccountService({ trees: service.trees, events: service.events }).accountList();
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
    return owner.submitUpdate(tree, current.tree.update, await resolveSnapshot(await snapshotDirectory(source, nested)));
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

describe("self-certifying profile account proof", () => {
  test("joins a Canopy without copying or locating the profile tree", async () => {
    const targetRoot = join(sandbox, "proof-target");
    const identity = testProfileIdentity();
    const target = await serveCanopy({
      dataRoot: targetRoot,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [{ handle: "target-admin", token: "target-admin-token" }],
      community: { handle: "target", name: "Target", firstWriter: { handle: "guest", profileTree: identity.profileTree } },
    });
    try {
      const targetAdmin = new WireClient(target.url, "target-admin-token");
      const targetAdminAccount = await targetAdmin.account();
      const targetCommunity = await targetAdmin.descriptor(targetAdminAccount.account.community.id);
      const targetAccountLocator = `${new URL(target.url).origin}/~guest`;
      const targetCommunitySource = await profileFolder("proof-target-community", "group", [
        { profile: `arbor://${targetAdminAccount.account.profileTree!}/`, handle: "target-admin" },
        { profile: `arbor://${identity.profileTree}/`, handle: "guest" },
      ]);
      const targetCommunitySnapshot = await resolveSnapshot(await snapshotDirectory(targetCommunitySource, new Map([
        [join(targetCommunitySource, "~target-admin"), targetAdminAccount.account.profileTree!],
      ])));
      await targetAdmin.submitUpdate(targetCommunity.tree.id, targetCommunity.tree.update, targetCommunitySnapshot);

      const profileTree = identity.profileTree;
      const configurationTree = generateArborID("tr");
      const deviceID = generateArborID("dv");
      const credential = "guest-target-credential";
      const configuration = snapshotAccountConfig({
        account: { canopy: new URL(target.url).origin, profile: profileTree },
        resources: {},
        devices: { [deviceID]: { id: deviceID, label: "Guest's Mac", administrator: true } },
      });
      const anonymous = new WireClient(target.url);
      const challenge = await anonymous.createAccountChallenge({ account: targetAccountLocator, profileTree, configurationTree });

      const request = {
        account: targetAccountLocator,
        profileTree,
        configurationTree,
        challenge,
        publicKey: identity.publicKey,
        signature: identity.sign(challenge),
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
        signature: request.signature.replace(/^./, request.signature[0] === "A" ? "B" : "A"),
      })).rejects.toThrow("signature is invalid");
    } finally {
      target.server.stop(true);
      await target.canopy[Symbol.asyncDispose]();
    }
  });
});

test("accepted resource policy enables and revokes anonymous executable authority", async () => {
  const client = new WireClient(running.url, "locally-generated-bob-credential");
  const accountResponse = await client.account();
  const configID = accountResponse.account.configuration.id;
  const current = await client.descriptor(configID);
  const snapshot = await client.snapshot(configID, current.tree.root);
  const graph = readAccountConfigGraph(snapshot, configID);
  const { resourceRuleFromLegacy } = await import("../../../packages/protocol/src/config/resource-configuration.ts");
  const resources = graph.resources ?? Object.fromEntries(Object.entries(graph.trees).map(([id, d]) => [id, { canonical: d.canonical, access: d.access.map(resourceRuleFromLegacy) }]));
  resources[bobProfileTree]!.access.push({ who: "everyone", via: "tr_supplies", allow: ["create-child"] });
  const updated = await client.submitUpdate(configID, current.tree.update, snapshotAccountConfig({ ...graph, resources }), { ifCurrent: current.tree.update });
  const bob = running.canopy.accountByHandle("bob")!;
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: null, sponsor: bob.id, subject: "anonymous", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ account: bob.id, role: "author", tree: bobProfileTree, within: "/", allow: ["create-child"] }] });
  const context = running.canopy.execution.resolve(token)!;
  expect(running.canopy.execution.run(context, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(true);
  resources[bobProfileTree]!.access = resources[bobProfileTree]!.access.filter(r => !r.via);
  await client.submitUpdate(configID, updated.update.id, snapshotAccountConfig({ ...graph, resources }), { ifCurrent: updated.update.id });
  expect(running.canopy.execution.run(context, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(false);
});

test("ordinary anonymous create permission works without via and does not grant overwrite", async () => {
  const owner = new WireClient(running.url, "locally-generated-bob-credential");
  const configID = (await owner.account()).account.configuration.id;
  const configCurrent = await owner.descriptor(configID);
  const graph = readAccountConfigGraph(await owner.snapshot(configID, configCurrent.tree.root), configID);
  const resources = graph.resources!;
  resources[bobProfileTree]!.access.push({ who: "everyone", allow: ["create-child"], within: "/" });
  // Replace the existing unrestricted public rule rather than creating a duplicate key.
  resources[bobProfileTree]!.access = resources[bobProfileTree]!.access.filter(r => r.who !== "everyone" || r.allow.includes("create-child"));
  await owner.submitUpdate(configID, configCurrent.tree.update, snapshotAccountConfig({ ...graph, resources }), { ifCurrent: configCurrent.tree.update });
  const current = await owner.descriptor(bobProfileTree);
  const snapshot = await owner.snapshot(bobProfileTree, current.tree.root);
  const { decodeWireDirectory, encodeWireDirectory, hashObject } = await import("@overstory/protocol");
  const bytes = new TextEncoder().encode("created"), hash = hashObject(bytes);
  const root = decodeWireDirectory(snapshot.objects.get(snapshot.root)!);
  const rootBytes = encodeWireDirectory({ ...root, entries: [...root.entries, { name: "public-note.txt", file: hash }] });
  const candidate = { root: hashObject(rootBytes), objects: new Map([...snapshot.objects, [hash, bytes], [hashObject(rootBytes), rootBytes]]) };
  const anonymous = new WireClient(running.url);
  const accepted = await anonymous.submitUpdate(bobProfileTree, current.tree.update, candidate, { ifCurrent: current.tree.update });
  expect(accepted.outcome).toBe("accepted");
  await expect(anonymous.descriptor(bobProfileTree)).rejects.toThrow();
  const changed = new TextEncoder().encode("overwritten"), changedHash = hashObject(changed);
  const changedRoot = encodeWireDirectory({ ...root, entries: [...root.entries, { name: "public-note.txt", file: changedHash }] });
  await expect(anonymous.submitUpdate(bobProfileTree, accepted.update.id, { root: hashObject(changedRoot), objects: new Map([...candidate.objects, [changedHash, changed], [hashObject(changedRoot), changedRoot]]) }, { ifCurrent: accepted.update.id })).rejects.toThrow();
});

test("concurrent policy narrowing is accepted restrictively until exact administrator resolution", async () => {
  const client = new WireClient(running.url, "locally-generated-bob-credential");
  const config = (await client.account()).account.configuration.id;
  const head = await client.descriptor(config);
  const graph = readAccountConfigGraph(await client.snapshot(config, head.tree.root), config);
  const policy = (allow: any[]) => {
    const next = structuredClone(graph);
    next.resources![bobProfileTree]!.access = [{ who: "everyone", via: "tr_supplies", allow }];
    return snapshotAccountConfig(next);
  };
  const initial = await client.submitUpdate(config, head.tree.update, policy(["read", "create-child", "delete"]));
  const bob = running.canopy.accountByHandle("bob")!;
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: null, sponsor: bob.id, subject: "anonymous", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ account: bob.id, role: "author", tree: bobProfileTree, within: "/", allow: ["create-child"] }] });
  await client.submitUpdate(config, initial.update.id, policy(["read", "create-child"]));
  const merged = await client.submitUpdate(config, initial.update.id, policy(["read", "delete"]));
  expect(merged.update.conflicted).toBe(true);
  // The policy choice is a decision of the update's log entry.
  expect(acceptedEntries(join(sandbox, "canopy"), config).find((e) => e.id === merged.update.id)!.entry.decisions).toHaveLength(1);
  const accepted = readAccountConfigGraph(await client.snapshot(config, merged.update.root), config);
  expect(accepted.resources![bobProfileTree]!.access).toEqual([{ who: "everyone", via: "tr_supplies", allow: ["read"] }]);
  expect(running.canopy.execution.run(running.canopy.execution.resolve(token)!, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(false);
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]))).rejects.toThrow(/guarded resolution/);
  const origin = running.url;
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  running = await serveCanopy({ dataRoot: join(sandbox, "canopy"), publicOrigin: origin,
    hostname: "127.0.0.1", port: Number(new URL(origin).port) });
  expect((await client.descriptor(config)).tree).toMatchObject({ update: merged.update.id, root: merged.update.root, conflicted: true });
  expect(running.canopy.execution.resolve(token)).toBeUndefined();
  expect((await client.access(bobProfileTree)).policy).toEqual(accepted.resources![bobProfileTree]!.access.map(safeResourceRule));
  const page = await client.conflicts(config, merged.update.id, merged.update.root);
  expect(page.decisions).toHaveLength(1);
  const resolves = page.decisions.map(d => ({ state: merged.update.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }));
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]), { ifCurrent: merged.update.id, resolves: resolves.map(r => ({ ...r, alternatives: [] })) })).rejects.toThrow();
  const resolved = await client.submitUpdate(config, merged.update.id, policy(["read"]), { ifCurrent: merged.update.id, resolves });
  expect(resolved.update.conflicted).toBe(false);
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]), { ifCurrent: merged.update.id, resolves })).rejects.toThrow();
});

test("access metadata exposes only the caller account's redacted resource rules", async () => {
  const client = new WireClient(running.url, "locally-generated-bob-credential");
  const config = (await client.account()).account.configuration.id;
  const head = await client.descriptor(config);
  const graph = readAccountConfigGraph(await client.snapshot(config, head.tree.root), config);
  const digest = `sha256:${"a".repeat(64)}`;
  graph.resources![bobProfileTree]!.access.push({ who: { link: digest }, via: "tr_supplies", allow: ["read"] });
  await client.submitUpdate(config, head.tree.update, snapshotAccountConfig(graph));
  const visible = await client.access(bobProfileTree);
  expect(visible.policy).toContainEqual({ who: { link: true }, via: "tr_supplies", allow: ["read"] });
  expect(JSON.stringify(visible)).not.toContain(digest);
  await expect(owner.access(bobProfileTree)).rejects.toThrow();
  const bob = running.canopy.accountByHandle("bob")!;
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: bob.id, sponsor: bob.id, subject: "bob", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ account: bob.id, role: "user", tree: bobProfileTree, within: "/", allow: ["read"] }] });
  await expect(new WireClient(running.url, token).access(bobProfileTree)).rejects.toThrow();
  await expect(new WireClient(running.url, token).account()).rejects.toThrow();
});

test("deleting non-hosting policy wins a concurrent expansion and re-add needs resolution", async () => {
  const client = new WireClient(running.url, "locally-generated-bob-credential");
  const config = (await client.account()).account.configuration.id;
  const head = await client.descriptor(config);
  const graph = readAccountConfigGraph(await client.snapshot(config, head.tree.root), config);
  const foreign = generateArborID("tr");
  graph.resources![foreign] = { access: [{ who: "me", via: "tr_supplies", allow: ["read"] }] };
  const base = await client.submitUpdate(config, head.tree.update, snapshotAccountConfig(graph));
  const expanded = structuredClone(graph);
  expanded.resources![foreign]!.access[0]!.allow = ["write"];
  await client.submitUpdate(config, base.update.id, snapshotAccountConfig(expanded));
  const deleted = structuredClone(graph);
  delete deleted.resources![foreign];
  const merged = await client.submitUpdate(config, base.update.id, snapshotAccountConfig(deleted));
  expect(merged.update.conflicted).toBe(true);
  const effective = readAccountConfigGraph(await client.snapshot(config, merged.update.root), config);
  expect(effective.resources![foreign]).toBeUndefined();
  await expect(client.submitUpdate(config, merged.update.id, snapshotAccountConfig(expanded))).rejects.toThrow(/guarded resolution/);
  const conflicts = await client.conflicts(config, merged.update.id, merged.update.root);
  const resolves = conflicts.decisions.map(d => ({ state: merged.update.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }));
  const confirmed = await client.submitUpdate(config, merged.update.id, snapshotAccountConfig(effective), { ifCurrent: merged.update.id, resolves });
  expect(confirmed.update.conflicted).toBe(false);
  const readded = await client.submitUpdate(config, confirmed.update.id, snapshotAccountConfig(graph), { ifCurrent: confirmed.update.id });
  expect(readded.update.conflicted).toBe(false);
});

test("a legacy-grammar trees.yaml is not a valid account configuration", async () => {
  const client = new WireClient(running.url, "locally-generated-bob-credential");
  const config = (await client.account()).account.configuration.id;
  const head = await client.descriptor(config);
  const graph = readAccountConfigGraph(await client.snapshot(config, head.tree.root), config);
  const valid = snapshotAccountConfig(graph);
  const legacyTrees = new TextEncoder().encode(stringify(Object.fromEntries(Object.entries(graph.trees).map(([id, entry]) => [id, {
    canonical: entry.canonical, access: [{ subject: { kind: "everyone" }, access: "write" }],
  }]))));
  const root = decodeWireDirectory(valid.objects.get(valid.root)!);
  const entries = root.entries.map(entry => entry.name === "trees.yaml" ? { name: entry.name, file: hashObject(legacyTrees) } : entry);
  const rootBytes = encodeWireDirectory({ type: "directory", entries });
  const legacy = { root: hashObject(rootBytes), objects: new Map([...valid.objects, [hashObject(legacyTrees), legacyTrees], [hashObject(rootBytes), rootBytes]]) };
  await expect(client.submitUpdate(config, head.tree.update, legacy)).rejects.toThrow();
  expect((await client.descriptor(config)).tree.update).toBe(head.tree.update);
});

test("community writers may address a tree at an unclaimed /~name, which then cannot be reserved", async () => {
  const origin = new URL(running.url).origin;
  const bob = new WireClient(running.url, "locally-generated-bob-credential");
  const configID = (await bob.account()).account.configuration.id;
  const declare = async (canonical: string) => {
    const current = await bob.descriptor(configID);
    const graph = readAccountConfigGraph(await bob.snapshot(configID, current.tree.root), configID);
    const tree = generateArborID("tr");
    return bob.submitUpdate(configID, current.tree.update, snapshotAccountConfig({
      ...graph,
      resources: { ...graph.resources, [tree]: { canonical, access: [] } },
    }), { ifCurrent: current.tree.update });
  };
  await expect(declare(`${origin}/~garden-club`)).rejects.toThrow("outside this Canopy account allocation");

  const community = running.canopy.community();
  const bobAccount = running.canopy.accountByHandle("bob")!;
  const access = (running.canopy as unknown as { access: { set(tree: string, kind: string, subject: string, access: string): void } }).access;
  access.set(community.id, "profile", bobAccount.profileTree!, "write");
  try {
    expect((await declare(`${origin}/~garden-club`)).outcome).toBe("accepted");
    await expect(declare(`${origin}/~alice/garden`)).rejects.toThrow("reserved for a person");

    const ownerAccount = running.canopy.accountByHandle("owner")!;
    const source = await profileFolder("community-reserving-a-tree-name", "group", [
      { profile: `arbor://${ownerAccount.profileTree!}/`, handle: "owner" },
      { profile: `arbor://${aliceProfileTree}/`, handle: "alice" },
      { profile: `arbor://${bobProfileTree}/`, handle: "bob" },
      { profile: `arbor://${testProfileIdentity().profileTree}/`, handle: "garden-club" },
    ]);
    const nested = new Map(running.canopy.list()
      .filter((candidate) => candidate.parentTree === community.id && candidate.canonicalPath)
      .map((candidate) => [join(source, candidate.canonicalPath!.split("/").filter(Boolean).at(-1)!), candidate.id]));
    const current = await owner.descriptor(community.id);
    await expect(owner.submitUpdate(community.id, current.tree.update, await resolveSnapshot(await snapshotDirectory(source, nested))))
      .rejects.toThrow("~garden-club is already the address of a tree");
  } finally {
    access.set(community.id, "profile", bobAccount.profileTree!, "none");
  }
});
