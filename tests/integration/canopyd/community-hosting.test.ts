import type { Database } from "bun:sqlite";
import { decodeProtocolDirectory, encodeProtocolDirectory, generateArborID, hashObject, sha256, safeResourceRule, HostAccountStore, ProtocolClient } from "@overstory/protocol";
import { LocalAccountService } from "../../../packages/arborsync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { ProfileIdentityStore } from "@overstory/arborsync/state";
import { initialPersonConfig, readTreeConfigGraph, snapshotTreeConfig, snapshotTreeConfigFiles, treeConfigurationID, type TreeConfigValues } from "@overstory/protocol";
import { editTreeConfig, hostTree, readTreeConfig } from "../../helpers/tree-config.ts";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { testProfileIdentity } from "../../helpers/profile-identity.ts";
import { acceptedEntries } from "../../support/log-entries.ts";

const ownerToken = "owner-device-credential";
const aliceProfileTree = generateArborID("tr");
const bobIdentity = testProfileIdentity();
const bobProfileTree = bobIdentity.profileTree;
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let owner: ProtocolClient;

type CommunityMember = string | { profile?: string; handle?: string; inviteDigest?: string };

async function profileFolder(name: string, kind: "person" | "group", members: CommunityMember[] = []): Promise<string> {
  const path = join(sandbox, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "_index.md"), [
    "---",
    `type: ${kind}`,
    ...(kind === "group" ? ["members:", ...members.flatMap((member) => typeof member === "string"
      ? [`  - ${JSON.stringify(member)}`]
      : ["  -", ...(member.profile ? [`    profile: ${JSON.stringify(member.profile)}`] : []), ...(member.handle ? [`    handle: ${JSON.stringify(member.handle)}`] : []), ...(member.inviteDigest ? [`    inviteDigest: ${JSON.stringify(member.inviteDigest)}`] : [])])] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
  return path;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-account-claim-"));
  running = await serveHost({
    dataRoot: join(sandbox, "canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }],
  });
  owner = new ProtocolClient(running.url, ownerToken);

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

describe("client-generated profile and account bootstrap", () => {
  test("an invitation code claims a community slot and replaces it with the proven Profile TreeID", async () => {
    const origin = new URL(running.url).origin;
    const handle = "invited-person";
    const inviteCode = "abcdefghijklmnopqrstuv";
    const digest = `sha256:${sha256(inviteCode)}`;
    const community = running.canopy.community();
    const head = await owner.descriptor(community.id);
    const snapshot = await owner.snapshot(community.id, head.tree.root);
    const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
    const index = root.entries.find((entry) => entry.name === "_index.md")!.file!;
    const source = new TextDecoder().decode(snapshot.objects.get(index)!);
    const pending = `  - handle: ${JSON.stringify(handle)}\n    inviteDigest: ${JSON.stringify(digest)}`;
    const bytes = new TextEncoder().encode(source.replace("members:\n", `members:\n${pending}\n`));
    const file = hashObject(bytes);
    const rootBytes = encodeProtocolDirectory({
      type: "directory",
      entries: root.entries.map((entry) => entry.name === "_index.md" ? { name: entry.name, file } : entry),
    });
    const candidate = { root: hashObject(rootBytes), objects: new Map([...snapshot.objects, [file, bytes], [hashObject(rootBytes), rootBytes]]) };
    await owner.submitUpdate(community.id, head.tree.update, candidate, { ifCurrent: head.tree.update });
    expect(running.canopy.accountReservation(`${origin}/~${handle}`)?.inviteDigest).toBe(digest);

    const identity = testProfileIdentity();
    const configurationTree = treeConfigurationID(identity.profileTree);
    const deviceID = generateArborID("dv");
    const credential = "invited-person-device-credential";
    const client = new ProtocolClient(running.url);
    const challenge = await client.createAccountChallenge({ profileTree: identity.profileTree, configurationTree, inviteCode });
    expect(challenge.account).toBe(`${origin}/~${handle}`);
    const request = {
      account: challenge.account,
      profileTree: identity.profileTree,
      configurationTree,
      challenge,
      publicKey: identity.publicKey,
      signature: identity.sign(challenge),
      device: { id: deviceID, label: "Invited Mac", credentialDigest: `sha256:${sha256(credential)}` as const },
      configuration: snapshotTreeConfig(initialPersonConfig(identity.profileTree, { id: deviceID, label: "Invited Mac" })),
    };
    await expect(client.joinAccount({ ...request, inviteCode: "wrong-code" })).rejects.toThrow("Invitation code is invalid");
    expect(running.canopy.accountByHandle(handle)).toBeNull();
    const claimed = await client.joinAccount({ ...request, inviteCode });
    expect(claimed.account.profileTree).toBe(identity.profileTree);
    expect((await client.joinAccount({ ...request, inviteCode })).account.id).toBe(claimed.account.id);
    const accepted = await owner.descriptor(community.id);
    const acceptedSnapshot = await owner.snapshot(community.id, accepted.tree.root);
    const acceptedRoot = decodeProtocolDirectory(acceptedSnapshot.objects.get(acceptedSnapshot.root)!);
    const acceptedIndex = acceptedRoot.entries.find((entry) => entry.name === "_index.md")!.file!;
    const acceptedSource = new TextDecoder().decode(acceptedSnapshot.objects.get(acceptedIndex)!);
    expect(acceptedSource).toContain(`profile: ${JSON.stringify(`arbor://${identity.profileTree}/`)}`);
    expect(acceptedSource).not.toContain(digest);
  });

  test("does not expose the legacy snapshot-upload claim route", async () => {
    const response = await fetch(`${running.url}/.arbor/claims/alice`, { method: "PUT" });
    expect(response.status).toBe(404);
  });

  test("community-only challenges resolve the reservation and bind the profile's configuration", async () => {
    const client = new ProtocolClient(running.url);
    const configurationTree = treeConfigurationID(bobProfileTree);
    const challenge = await client.createAccountChallenge({ profileTree: bobProfileTree, configurationTree });
    expect(challenge.account).toBe(`${new URL(running.url).origin}/~bob`);
    expect(challenge.profileTree).toBe(bobProfileTree);
    expect(challenge.configurationTree).toBe(configurationTree);
    await expect(client.createAccountChallenge({ profileTree: bobProfileTree, configurationTree: generateArborID("tr") }))
      .rejects.toThrow("configuration TreeID");
    const stranger = testProfileIdentity().profileTree;
    await expect(client.createAccountChallenge({ profileTree: stranger, configurationTree: treeConfigurationID(stranger) }))
      .rejects.toThrow("has not reserved");
  });

  test("a claim declares the profile tree; activation mounts it at /~handle; its devices pair and declare trees", async () => {
    const origin = new URL(running.url).origin;
    const profileTree = bobProfileTree;
    const configurationTree = treeConfigurationID(profileTree);
    const administratorID = generateArborID("dv");
    const administratorCredential = "locally-generated-bob-credential";
    const profile = await resolveSnapshot(await snapshotDirectory(await profileFolder("bob", "person")));
    const initial = initialPersonConfig(profileTree, { id: administratorID, label: "Bob's Mac" });
    const configuration = snapshotTreeConfig({ ...initial, access: [...initial.access, { who: "everyone", allow: ["read"] }] });
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
    const client = new ProtocolClient(running.url);
    const challenge = await client.createAccountChallenge({ account: `${origin}/~bob`, profileTree, configurationTree });
    const identityProof = { challenge, publicKey: bobIdentity.publicKey, signature: bobIdentity.sign(challenge) };
    // A person's configuration names that person as its only administrator.
    const coAdministered = snapshotTreeConfig({ ...initial, access: [...initial.access, { who: { profile: aliceProfileTree }, allow: ["admin"] }] });
    await expect(new ProtocolClient(running.url).joinAccount({ account: `${origin}/~bob`, ...request, ...identityProof, configuration: coAdministered }))
      .rejects.toThrow("no one else");
    const mounting = snapshotTreeConfig({ ...initial, mounts: { notes: generateArborID("tr") } });
    await expect(new ProtocolClient(running.url).joinAccount({ account: `${origin}/~bob`, ...request, ...identityProof, configuration: mounting }))
      .rejects.toThrow("mounts nothing");
    const claimed = await client.joinAccount({ account: `${origin}/~bob`, ...request, ...identityProof });
    expect(claimed.account).toMatchObject({ handle: "bob", profileTree, id: profileTree });
    expect(claimed.configuration).toMatchObject({ id: configurationTree, kind: "tree-configuration", canonical: null });
    expect(running.canopy.get(profileTree)).toBeNull();
    expect(running.canopy.boundary("/~bob")).toBeNull();
    const administrator = new ProtocolClient(running.url, administratorCredential);

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
    const firstClaim = await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, phone);
    expect(firstClaim.device.id).toBe(phoneID);
    expect(await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, phone)).toEqual(firstClaim);
    const { values } = await readTreeConfig(administrator, profileTree, "person");
    expect(values.devices![phoneID]).toEqual({ id: phoneID, label: "Bob's iPhone", administrator: false });

    // An ordinary device may not declare or activate trees.
    const phoneClient = new ProtocolClient(running.url, phoneCredential);
    await expect(phoneClient.declareTree(generateArborID("tr"), snapshotTreeConfig({ access: [{ who: { profile: profileTree }, allow: ["admin"] }], mounts: {} })))
      .rejects.toThrow("administrator device");

    const treeSource = join(sandbox, "bob-notes");
    await mkdir(treeSource, { recursive: true });
    await writeFile(join(treeSource, "_index.md"), "# Bob's notes\n");
    const notes = await hostTree(administrator, await resolveSnapshot(await snapshotDirectory(treeSource)), { parent: { tree: profileTree, name: "notes", kind: "person" } });
    expect((await administrator.descriptor(notes)).tree.canonical?.path).toBe("/~bob/notes");
    // The parent's content holds the mount's boundary entry.
    const bobRoot = await administrator.snapshot(profileTree, (await administrator.descriptor(profileTree)).tree.root);
    expect(decodeProtocolDirectory(bobRoot.objects.get(bobRoot.root)!).entries.find((entry) => entry.name === "notes")?.tree).toBe(notes);

    // Renaming the mount moves the boundary, and removing it leaves the tree without a canonical path.
    await editTreeConfig(administrator, profileTree, "person", (current) => ({ ...current, mounts: { journal: notes } }));
    expect((await administrator.descriptor(notes)).tree.canonical?.path).toBe("/~bob/journal");
    await editTreeConfig(administrator, profileTree, "person", (current) => ({ ...current, mounts: {} }));
    expect((await administrator.descriptor(notes)).tree.canonical).toBeNull();
    expect(running.canopy.boundary("/~bob/journal")).toBeNull();
    await editTreeConfig(administrator, profileTree, "person", (current) => ({ ...current, mounts: { notes } }));
    expect((await administrator.descriptor(notes)).tree.canonical?.path).toBe("/~bob/notes");

    // Nobody mounts a tree they do not administer: the owner cannot give Bob's notes an address.
    const ownerProfile = running.canopy.accountByHandle("owner")!.profileTree;
    await expect(editTreeConfig(owner, ownerProfile, "person", (current) => ({ ...current, mounts: { ...current.mounts, "bobs-notes": notes } })))
      .rejects.toThrow();
    // Nor edits a configuration of a tree they do not administer.
    await expect(owner.treeConfiguration(notes)).rejects.toThrow();
  });

  test("rejects unreserved identities without creating the configuration tree", async () => {
    const identity = testProfileIdentity();
    const profileTree = identity.profileTree;
    const configurationTree = treeConfigurationID(profileTree);
    const origin = new URL(running.url).origin;
    const client = new ProtocolClient(running.url);
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
      await expect(bootstrap.claimHostAccount(`${new URL(running.url).origin}/~unassigned`, profilePath))
        .rejects.toThrow();
      expect(await bootstrap.pendingClaim()).toMatchObject({ canCancel: true });
      expect(await bootstrap.accountList()).toHaveLength(0);
      await bootstrap.cancelPendingClaim();
      expect(await bootstrap.pendingClaim()).toBeNull();
      const originalJoin = ProtocolClient.prototype.joinAccount;
      const interrupted = spyOn(ProtocolClient.prototype, "joinAccount").mockImplementationOnce(async function (this: ProtocolClient, input) {
        await originalJoin.call(this, input);
        throw new Error("Lost claim response");
      });
      try {
        await expect(bootstrap.claimHostAccount(new URL(running.url).origin, profilePath, "Charlie"))
          .rejects.toThrow("Lost claim response");
      } finally { interrupted.mockRestore(); }
      expect(await bootstrap.pendingClaim()).toEqual({ account: `${new URL(running.url).origin}/~charlie`, path: await realpath(profilePath), canCancel: false });
      await expect(bootstrap.cancelPendingClaim()).rejects.toThrow("may already have reached");
      // A fresh service resumes the exact claim even though the reservation is now claimed.
      await new LocalAccountService({ trees: service.trees, events: service.events })
        .claimHostAccount(new URL(running.url).origin, profilePath, "Charlie");
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
      const offer = await new ProtocolClient(running.url, originalCredential).createPairing();
      const backupPath = join(sandbox, "charlie-identity-backup.json");
      await new ProfileIdentityStore().backup(backupPath);
      const pairedHome = join(sandbox, "charlie-paired-home");
      process.env.ARBOR_DATA_HOME = pairedHome;
      const pairedProfile = join(sandbox, "charlie-recovered-profile");
      await new ProfileIdentityStore().restore(backupPath, pairedProfile);
      const pairedDaemon = await ArborSyncDaemon.open(pairedProfile, {}, { autoSync: false });
      try {
        const paired = new LocalAccountService({ trees: pairedDaemon.trees, events: pairedDaemon.events });
        const originalPair = ProtocolClient.prototype.claimPairing;
        const lostPair = spyOn(ProtocolClient.prototype, "claimPairing").mockImplementationOnce(async function (this: ProtocolClient, ...args) {
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
        const pairedAccount = await new ProtocolClient(running.url, token).account();
        expect(pairedAccount.account.configuration.id).toBe(configurationTree);
        expect(pairedAccount.account.profileTree).toBe(localProfileTree);
        await new HostAccountStore(configurationTree).remove();
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
      await expect(new ProtocolClient(running.url).createAccountChallenge({
        profileTree: localProfileTree, configurationTree: generateArborID("tr"),
      })).rejects.toThrow("Several reservations");
      const retainedPlacements = `${configurationTree}: {}\n`;
      await writeFile(join(home, "placements.yaml"), retainedPlacements);

      await new LocalAccountService({ trees: service.trees, events: service.events }).claimHostAccount(`${new URL(running.url).origin}/~charlie-two`, profilePath, "Charlie");
      const pluralAccounts = await new LocalAccountService({ trees: service.trees, events: service.events }).accountList();
      expect(pluralAccounts).toHaveLength(2);
      expect(new Set(pluralAccounts.map((account) => account.profileTree))).toEqual(new Set([localProfileTree]));
      expect(new Set(pluralAccounts.map((account) => account.handle))).toEqual(new Set(["charlie", "charlie-two"]));
      configurationTrees.push(pluralAccounts.find((account) => account.configurationTree !== configurationTree)!.configurationTree);
      expect(await readFile(join(home, "placements.yaml"), "utf8")).toBe(retainedPlacements);

      const code = "ZYXWVUTSRQPONMLKJIHGFE";
      const invitedCommunity = await owner.descriptor(running.canopy.community().id);
      const invitedSource = await profileFolder("community-with-code", "group", [
        { profile: `arbor://${ownerAccount.profileTree!}/`, handle: "owner" },
        { profile: `arbor://${aliceProfileTree}/`, handle: "alice" },
        { profile: `arbor://${bobProfileTree}/`, handle: "bob" },
        { profile: `arbor://${localProfileTree}/`, handle: "charlie" },
        { profile: `arbor://${localProfileTree}/`, handle: "charlie-two" },
        { handle: "charlie-invited", inviteDigest: `sha256:${sha256(code)}` },
      ]);
      const invitedNested = new Map(running.canopy.list()
        .filter((tree) => tree.parentTree === invitedCommunity.tree.id && tree.canonicalPath)
        .map((tree) => [join(invitedSource, tree.canonicalPath!.split("/").filter(Boolean).at(-1)!), tree.id]));
      await owner.submitUpdate(invitedCommunity.tree.id, invitedCommunity.tree.update,
        await resolveSnapshot(await snapshotDirectory(invitedSource, invitedNested)));
      await new LocalAccountService({ trees: service.trees, events: service.events })
        .claimHostAccount(new URL(running.url).origin, profilePath, "Charlie", code);
      const invitedAccounts = await new LocalAccountService({ trees: service.trees, events: service.events }).accountList();
      expect(invitedAccounts.map((account) => account.handle)).toContain("charlie-invited");
      configurationTrees.push(invitedAccounts.find((account) => account.handle === "charlie-invited")!.configurationTree);
    } finally {
      await service[Symbol.asyncDispose]();
      await Promise.all(configurationTrees.map((configurationTree) => new HostAccountStore(configurationTree).remove()));
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
    expect(running.canopy.rootProfileType(ownerAccount.profileTree!)).toBe("person");
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
    const target = await serveHost({
      dataRoot: targetRoot,
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
      accounts: [{ handle: "target-admin", token: "target-admin-token" }],
      community: { handle: "target", name: "Target", firstWriter: { handle: "guest", profileTree: identity.profileTree } },
    });
    try {
      const targetAdmin = new ProtocolClient(target.url, "target-admin-token");
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
      const configurationTree = treeConfigurationID(profileTree);
      const deviceID = generateArborID("dv");
      const credential = "guest-target-credential";
      const configuration = snapshotTreeConfig(initialPersonConfig(profileTree, { id: deviceID, label: "Guest's Mac" }));
      const anonymous = new ProtocolClient(target.url);
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
      const joined = await new ProtocolClient(target.url).joinAccount(request);
      expect(joined.account).toMatchObject({ handle: "guest", profileTree, profileURL: null });
      expect(joined.configuration).toMatchObject({ id: configurationTree, kind: "tree-configuration" });
      expect(target.canopy.get(profileTree)).toBeNull();
      expect(target.canopy.boundary("/~guest")).toBeNull();
      expect(await new ProtocolClient(target.url).joinAccount(request)).toEqual(joined);
      expect((await new ProtocolClient(target.url, credential).account()).account.configuration.id).toBe(configurationTree);
      // The founder is a member, so administers the community.
      expect(target.canopy.canAdminister(target.canopy.account(profileTree)!, target.canopy.community())).toBe(true);

      await expect(new ProtocolClient(target.url).joinAccount({
        ...request,
        signature: request.signature.replace(/^./, request.signature[0] === "A" ? "B" : "A"),
      })).rejects.toThrow("signature is invalid");
    } finally {
      target.server.stop(true);
      await target.canopy[Symbol.asyncDispose]();
    }
  });
});

const bobCredential = "locally-generated-bob-credential";
const bobPerson = (client: ProtocolClient) => readTreeConfig(client, bobProfileTree, "person");
const editBob = (client: ProtocolClient, change: (values: TreeConfigValues) => TreeConfigValues) => editTreeConfig(client, bobProfileTree, "person", change);

test("an administrator's rule through an app enables and revokes anonymous executable authority", async () => {
  const client = new ProtocolClient(running.url, bobCredential);
  await editBob(client, (values) => ({ ...values, access: [...values.access, { who: "everyone", app: "tr_supplies", allow: ["create-child"] }] }));
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: null, subject: "anonymous", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ lender: null, tree: bobProfileTree, within: "/", allow: ["create-child"] }] });
  const context = running.canopy.execution.resolve(token)!;
  expect(running.canopy.execution.run(context, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(true);
  await editBob(client, (values) => ({ ...values, access: values.access.filter((rule) => !rule.app) }));
  expect(running.canopy.execution.run(context, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(false);
});

test("ordinary anonymous create permission works without app and does not grant overwrite", async () => {
  const bob = new ProtocolClient(running.url, bobCredential);
  // Replace the existing unrestricted public rule rather than creating a duplicate key.
  await editBob(bob, (values) => ({ ...values, access: [...values.access.filter((rule) => rule.who !== "everyone"), { who: "everyone", allow: ["create-child"] }] }));
  const current = await bob.descriptor(bobProfileTree);
  const snapshot = await bob.snapshot(bobProfileTree, current.tree.root);
  const bytes = new TextEncoder().encode("created"), hash = hashObject(bytes);
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const rootBytes = encodeProtocolDirectory({ ...root, entries: [...root.entries, { name: "public-note.txt", file: hash }] });
  const candidate = { root: hashObject(rootBytes), objects: new Map([...snapshot.objects, [hash, bytes], [hashObject(rootBytes), rootBytes]]) };
  const anonymous = new ProtocolClient(running.url);
  const accepted = await anonymous.submitUpdate(bobProfileTree, current.tree.update, candidate, { ifCurrent: current.tree.update });
  expect(accepted.outcome).toBe("accepted");
  await expect(anonymous.descriptor(bobProfileTree)).rejects.toThrow();
  const changed = new TextEncoder().encode("overwritten"), changedHash = hashObject(changed);
  const changedRoot = encodeProtocolDirectory({ ...root, entries: [...root.entries, { name: "public-note.txt", file: changedHash }] });
  await expect(anonymous.submitUpdate(bobProfileTree, accepted.update.id, { root: hashObject(changedRoot), objects: new Map([...candidate.objects, [changedHash, changed], [hashObject(changedRoot), changedRoot]]) }, { ifCurrent: accepted.update.id })).rejects.toThrow();
  await editBob(bob, (values) => ({ ...values, access: [...values.access.filter((rule) => rule.who !== "everyone"), { who: "everyone", allow: ["read"] }] }));
});

test("concurrent policy narrowing is accepted restrictively until exact administrator resolution", async () => {
  const client = new ProtocolClient(running.url, bobCredential);
  const config = treeConfigurationID(bobProfileTree);
  const { values } = await bobPerson(client);
  const policy = (allow: any[]) => snapshotTreeConfig({ ...values, access: [...values.access.filter((rule) => !rule.app), { who: "everyone", app: "tr_supplies", allow }] });
  const head = await client.descriptor(config);
  const initial = await client.submitUpdate(config, head.tree.update, policy(["read", "create-child", "delete"]));
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: null, subject: "anonymous", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ lender: null, tree: bobProfileTree, within: "/", allow: ["create-child"] }] });
  await client.submitUpdate(config, initial.update.id, policy(["read", "create-child"]));
  const merged = await client.submitUpdate(config, initial.update.id, policy(["read", "delete"]));
  expect(merged.update.conflicted).toBe(true);
  // The policy choice is a decision of the update's log entry.
  expect(acceptedEntries(join(sandbox, "canopy"), config).find((e) => e.id === merged.update.id)!.entry.decisions).toHaveLength(1);
  const accepted = readTreeConfigGraph(await client.snapshot(config, merged.update.root), "person", bobProfileTree);
  expect(accepted.access.filter((rule) => rule.app)).toEqual([{ who: "everyone", app: "tr_supplies", allow: ["read"] }]);
  expect(running.canopy.execution.run(running.canopy.execution.resolve(token)!, () => running.canopy.execution.canSubmit(bobProfileTree))).toBe(false);
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]))).rejects.toThrow(/guarded resolution/);
  const origin = running.url;
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  running = await serveHost({ dataRoot: join(sandbox, "canopy"), publicOrigin: origin,
    hostname: "127.0.0.1", port: Number(new URL(origin).port) });
  expect((await client.descriptor(config)).tree).toMatchObject({ update: merged.update.id, root: merged.update.root, conflicted: true });
  expect(running.canopy.execution.resolve(token)).toBeUndefined();
  expect((await client.access(bobProfileTree)).policy).toEqual(accepted.access.map(safeResourceRule));
  const page = await client.conflicts(config, merged.update.id, merged.update.root);
  expect(page.decisions).toHaveLength(1);
  const resolves = page.decisions.map(d => ({ state: merged.update.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }));
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]), { ifCurrent: merged.update.id, resolves: resolves.map(r => ({ ...r, alternatives: [] })) })).rejects.toThrow();
  const resolved = await client.submitUpdate(config, merged.update.id, policy(["read"]), { ifCurrent: merged.update.id, resolves });
  expect(resolved.update.conflicted).toBe(false);
  await expect(client.submitUpdate(config, merged.update.id, policy(["write"]), { ifCurrent: merged.update.id, resolves })).rejects.toThrow();
});

test("access metadata exposes a tree's redacted rules to its administrators only", async () => {
  const client = new ProtocolClient(running.url, bobCredential);
  const digest = `sha256:${"a".repeat(64)}`;
  await editBob(client, (values) => ({ ...values, access: [...values.access, { who: { link: digest }, app: "tr_supplies", allow: ["read"] }] }));
  const visible = await client.access(bobProfileTree);
  expect(visible.policy).toContainEqual({ who: { link: true }, app: "tr_supplies", allow: ["read"] });
  expect(JSON.stringify(visible)).not.toContain(digest);
  await expect(owner.access(bobProfileTree)).rejects.toThrow();
  const token = running.canopy.execution.issue({ code: "tr_supplies", version: "v1", caller: bobProfileTree, subject: "bob", expiresAt: Date.now() + 60000, active: () => true,
    grants: [{ lender: null, tree: bobProfileTree, within: "/", allow: ["read"] }] });
  await expect(new ProtocolClient(running.url, token).access(bobProfileTree)).rejects.toThrow();
  await expect(new ProtocolClient(running.url, token).account()).rejects.toThrow();
});

test("removing an app approval wins a concurrent expansion and re-adding needs resolution", async () => {
  const client = new ProtocolClient(running.url, bobCredential);
  const config = treeConfigurationID(bobProfileTree);
  const { values } = await bobPerson(client);
  const foreign = generateArborID("tr");
  const approved = { ...values, apps: { ...values.apps, tr_supplies: [{ resource: foreign, who: "me" as const, allow: ["read" as const] }] } };
  const head = await client.descriptor(config);
  const base = await client.submitUpdate(config, head.tree.update, snapshotTreeConfig(approved));
  const expanded = { ...approved, apps: { ...approved.apps, tr_supplies: [{ resource: foreign, who: "me" as const, allow: ["write" as const] }] } };
  await client.submitUpdate(config, base.update.id, snapshotTreeConfig(expanded));
  const { tr_supplies: _removed, ...remaining } = approved.apps;
  const deleted = { ...approved, apps: remaining };
  const merged = await client.submitUpdate(config, base.update.id, snapshotTreeConfig(deleted));
  expect(merged.update.conflicted).toBe(true);
  const effective = readTreeConfigGraph(await client.snapshot(config, merged.update.root), "person", bobProfileTree);
  expect(effective.apps!.tr_supplies ?? []).toEqual([]);
  await expect(client.submitUpdate(config, merged.update.id, snapshotTreeConfig(expanded))).rejects.toThrow(/guarded resolution/);
  const conflicts = await client.conflicts(config, merged.update.id, merged.update.root);
  const resolves = conflicts.decisions.map(d => ({ state: merged.update.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }));
  const { sources: _sources, ...effectiveValues } = effective;
  const confirmed = await client.submitUpdate(config, merged.update.id, snapshotTreeConfig(effectiveValues), { ifCurrent: merged.update.id, resolves });
  expect(confirmed.update.conflicted).toBe(false);
  const readded = await client.submitUpdate(config, confirmed.update.id, snapshotTreeConfig(approved), { ifCurrent: confirmed.update.id });
  expect(readded.update.conflicted).toBe(false);
});

test("the old account files are not a valid tree configuration, and an edit cannot remove the last administrator", async () => {
  const client = new ProtocolClient(running.url, bobCredential);
  const config = treeConfigurationID(bobProfileTree);
  const head = await client.descriptor(config);
  const { values } = await bobPerson(client);
  const valid = snapshotTreeConfig(values);
  const legacy = snapshotTreeConfigFiles({
    ...Object.fromEntries(decodeProtocolDirectory(valid.objects.get(valid.root)!).entries.map((entry) => [entry.name, new TextDecoder().decode(valid.objects.get(entry.file!)!)])),
    ["trees.yaml" as "access.yaml"]: "{}\n",
  });
  await expect(client.submitUpdate(config, head.tree.update, legacy)).rejects.toThrow();
  const noAdministrator = snapshotTreeConfigFiles({
    "access.yaml": "- who: everyone\n  allow: [read]\n",
    "mounts.yaml": "{}\n",
    "devices.yaml": new TextDecoder().decode(valid.objects.get(decodeProtocolDirectory(valid.objects.get(valid.root)!).entries.find((entry) => entry.name === "devices.yaml")!.file!)!),
  });
  await expect(client.submitUpdate(config, head.tree.update, noAdministrator)).rejects.toThrow();
  expect((await client.descriptor(config)).tree.update).toBe(head.tree.update);
});

test("community administrators may mount a tree at an unclaimed /~name, which then cannot be reserved", async () => {
  const community = running.canopy.community();
  const ownerAccount = running.canopy.accountByHandle("owner")!;
  expect(running.canopy.canAdminister(ownerAccount, community)).toBe(true);
  const snapshot = await resolveSnapshot(await snapshotDirectory(await profileFolder("garden-club", "group", [
    { profile: `arbor://${ownerAccount.profileTree}/` },
  ])));
  const club = await hostTree(owner, snapshot);
  // A name a person holds cannot be mounted.
  await expect(editTreeConfig(owner, community.id, "group", (values) => ({ ...values, mounts: { ...values.mounts, "~alice": club } })))
    .rejects.toThrow("reserved for a person");
  await editTreeConfig(owner, community.id, "group", (values) => ({ ...values, mounts: { ...values.mounts, "~garden-club": club } }));
  expect(running.canopy.boundary("/~garden-club")?.id).toBe(club);

  const source = await profileFolder("community-reserving-a-tree-name", "group", [
    { profile: `arbor://${ownerAccount.profileTree}/`, handle: "owner" },
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

  // A group that administers a tree keeps a member: its plants tree is the club's.
  const plants = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(await profileFolder("plants", "person"))), { administrators: [club] });
  expect(running.canopy.canAdminister(ownerAccount, plants)).toBe(true);
  const emptied = await profileFolder("garden-club-empty", "group", []);
  const clubHead = await owner.descriptor(club);
  await expect(owner.submitUpdate(club, clubHead.tree.update, await resolveSnapshot(await snapshotDirectory(emptied))))
    .rejects.toThrow("keep at least one member");
});
