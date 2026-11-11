import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activationElement,
  buildInviteLocator,
  decodeProtocolDirectory,
  initialPersonConfig,
  inviteCodeDigest,
  isInviteCode,
  loadProtocolContent,
  parseMarkdown,
  ProtocolClient,
  resolveLogicalURL,
  snapshotTreeConfig,
  treeConfigurationID,
} from "@ovst/protocol";
import { serveHost } from "@ovst/overstoryd";
import { cancelInvitation, createInvitation, editTreeFile, pendingInvitations, renewInvitation } from "@ovst/client";
import { testProfileIdentity } from "../../helpers/profile-identity.ts";
import { deviceClient, newTestDevice, testAccount } from "../../helpers/devices.ts";
import { directoryStamper } from "@ovst/protocol";

const ownerToken = "invitations-owner";
const memberToken = "invitations-member";
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;
let owner: ProtocolClient;
let community: string;
let ownerProfile: string;
let memberProfile: string;

async function read(path: string): Promise<string> {
  const head = (await owner.descriptor(community)).tree;
  const snapshot = await owner.snapshot(community, head.root);
  let directory = decodeProtocolDirectory(snapshot.objects.get(head.root)!);
  const names = path.split("/");
  for (const name of names.slice(0, -1)) {
    if (directory.type !== "directory") throw new Error("not a directory");
    directory = decodeProtocolDirectory(snapshot.objects.get(directory.entries.find((entry) => entry.name === name)!.directory!)!);
  }
  if (directory.type !== "directory") throw new Error("not a directory");
  const entry = directory.entries.find((candidate) => candidate.name === names.at(-1))!;
  return new TextDecoder().decode(await loadProtocolContent(entry, async (hash) => snapshot.objects.get(hash)!));
}

async function setIndex(source: string): Promise<void> {
  await editTreeFile(owner, community, "_index.md", () => source);
}

/** Claim the account a join link names, as a new identity; returns the claimed handle's profile. */
async function claim(link: string): Promise<string> {
  const resolved = resolveLogicalURL("/", link);
  if (resolved?.kind !== "overstory" || !resolved.invite) throw new Error("not a join link");
  const inviteCode = resolved.invite;
  const identity = testProfileIdentity();
  const configurationTree = treeConfigurationID(identity.profileTree);
  const device = newTestDevice("invited");
  const client = new ProtocolClient(running.url);
  const challenge = await client.createAccountChallenge({ profileTree: identity.profileTree, configurationTree, inviteCode });
  await client.joinAccount({
    account: challenge.account,
    profileTree: identity.profileTree,
    configurationTree,
    challenge,
    publicKey: identity.publicKey,
    signature: identity.sign(challenge),
    device: { id: device.device, label: "Invited Mac", key: device.key },
    configuration: activationElement(snapshotTreeConfig(initialPersonConfig(identity.profileTree, { id: device.device, label: "Invited Mac", key: device.key }), directoryStamper(undefined, 0))),
    inviteCode,
  });
  return identity.profileTree;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-invitations-"));
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [
      testAccount("owner", ownerToken, { communityWriter: true }),
      testAccount("member", memberToken, { communityWriter: false }),
    ],
  });
  owner = await deviceClient(running.url, ownerToken);
  const account = (await owner.account()).account;
  community = account.community.id;
  ownerProfile = `overstory://${account.profileTree!}/`;
  memberProfile = `overstory://${(await (await deviceClient(running.url, memberToken)).account()).account.profileTree!}/`;
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("invitation codes", () => {
  test("match the shared vectors", async () => {
    const vectors = await Bun.file(join(import.meta.dir, "../../../docs/overstory-spec/conformance/invitations.json")).json() as {
      invitations: Array<{ code: string; digest: string; account: string; link: string }>;
      invalid: string[];
    };
    expect(vectors.invitations.length).toBeGreaterThan(0);
    for (const vector of vectors.invitations) {
      expect(isInviteCode(vector.code)).toBe(true);
      expect(inviteCodeDigest(vector.code)).toBe(vector.digest);
      expect(buildInviteLocator(vector.account, vector.code)).toBe(vector.link);
    }
    for (const bad of vectors.invalid) expect(() => inviteCodeDigest(bad)).toThrow();
  });
});

describe("editTreeFile", () => {
  test("edits a file, submits nothing for an unchanged result, and errs on a missing file", async () => {
    const before = (await owner.descriptor(community)).tree.update;
    const unchanged = await editTreeFile(owner, community, "_index.md", (text) => text);
    expect(unchanged).toEqual({ changed: false, update: before });
    const edited = await editTreeFile(owner, community, "_index.md", (text) => `${text}\nAn edit.\n`);
    expect(edited.changed).toBe(true);
    expect(await read("_index.md")).toContain("An edit.");
    await expect(editTreeFile(owner, community, "missing.md", (text) => text)).rejects.toThrow("has no missing.md");
  });

  test("keeps a concurrent accepted update by reading again", async () => {
    let raced = false;
    await editTreeFile(owner, community, "_index.md", async (text) => {
      if (!raced) {
        raced = true;
        // Another writer gets in between the read and the submit.
        await editTreeFile(owner, community, "_index.md", (inner) => `${inner}\nFirst writer.\n`);
      }
      return `${text}\nSecond writer.\n`;
    });
    const source = await read("_index.md");
    expect(source).toContain("First writer.");
    expect(source).toContain("Second writer.");
  });
});

describe("invitations", () => {
  const frontmatter = (members: string) => `---\ntype: group\n${members}---\n\n# Garden\n`;

  test("an invitation made here is claimed through the join path", async () => {
    await setIndex(frontmatter(`members:\n  - profile: ${JSON.stringify(ownerProfile)}\n    handle: owner\n  - profile: ${JSON.stringify(memberProfile)}\n    handle: member\n`));
    const invitation = await createInvitation(owner, "dana");
    expect(invitation.account).toBe(`${new URL(running.url).origin}/~dana`);
    expect(invitation.link.startsWith(`${invitation.account}#overstory-invite=`)).toBe(true);
    expect((await pendingInvitations(owner)).map((pending) => pending.handle)).toEqual(["dana"]);
    await expect(createInvitation(owner, "dana")).rejects.toThrow("already has a pending invitation");
    await expect(createInvitation(owner, "owner")).rejects.toThrow("already a member");
    await expect(createInvitation(owner, "Not A Handle")).rejects.toThrow("is not a handle");
    const profile = await claim(invitation.link);
    expect(running.overstoryd.accountByHandle("dana")?.id).toBe(profile);
    expect(await pendingInvitations(owner)).toEqual([]);
  });

  test("a renewed invitation's old link fails and its new one works; a cancelled one fails", async () => {
    const first = await createInvitation(owner, "erin");
    const renewed = await renewInvitation(owner, "erin");
    expect(renewed.link).not.toBe(first.link);
    await expect(claim(first.link)).rejects.toThrow();
    await claim(renewed.link);
    expect(running.overstoryd.accountByHandle("erin")).not.toBeNull();

    const cancelled = await createInvitation(owner, "frank");
    await cancelInvitation(owner, "frank");
    await expect(claim(cancelled.link)).rejects.toThrow();
    await expect(cancelInvitation(owner, "frank")).rejects.toThrow("No invitation for ~frank is pending");
  });

  test("keeps comments, CRLF and flow style, and handles absent or empty members", async () => {
    const cases: Array<[string, string]> = [
      ["block with comments", `members:\n  # the founders\n  - profile: ${JSON.stringify(ownerProfile)}  # first\n    handle: owner\n  - { profile: ${JSON.stringify(memberProfile)}, handle: member }\n`],
      ["flow", `members: [{ profile: ${JSON.stringify(ownerProfile)}, handle: owner }, { profile: ${JSON.stringify(memberProfile)}, handle: member }]\n`],
    ];
    for (const [name, members] of cases) {
      for (const crlf of [false, true]) {
        const source = crlf ? frontmatter(members).replaceAll("\n", "\r\n") : frontmatter(members);
        await setIndex(source);
        await createInvitation(owner, "gail");
        const invited = await read("_index.md");
        expect(invited.startsWith(source.slice(0, source.indexOf("members") === -1 ? 3 : source.indexOf("members"))), name).toBe(true);
        for (const comment of ["# the founders", "# first"]) if (source.includes(comment)) expect(invited, name).toContain(comment);
        if (crlf) expect(invited.replaceAll("\r\n", ""), name).not.toContain("\n");
        const declared = parseMarkdown(invited).frontmatter.members as Array<Record<string, unknown>>;
        expect(declared.at(-1)?.handle, name).toBe("gail");
        await cancelInvitation(owner, "gail");
        const after = await read("_index.md");
        expect(parseMarkdown(after).frontmatter.members ?? [], name).toEqual(parseMarkdown(source).frontmatter.members ?? []);
        for (const comment of ["# the founders", "# first"]) if (source.includes(comment)) expect(after, name).toContain(comment);
      }
    }
  });

  test("refuses a caller who may not write the community", async () => {
    const member = await deviceClient(running.url, memberToken);
    await expect(createInvitation(member, "ivan")).rejects.toThrow("only its community's administrators can");
  });

});
