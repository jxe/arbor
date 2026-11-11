import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import {
  accountChallengeBytes,
  activationElement,
  decodeProtocolDirectory,
  deviceSessionChallengeBytes,
  generateOverstoryID,
  initialPersonConfig,
  openVisitorSession,
  personProfileTreeID,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
  type TreeSnapshot,
} from "@ovst/protocol";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { editTreeConfig, hostTree } from "../../helpers/tree-config.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";
import { directoryStamper } from "@ovst/protocol";

/**
 * Visitor sessions (accounts §5.6): Dana's home is A. B's community has never
 * heard of her, but a tree on B grants her profile, by its locator at A, read.
 * Her device opens a visitor session on B, which B checks against the keys A
 * publishes; it reads what B's rules grant that locator and nothing more, and
 * it ends when A stops listing the device.
 */

const LIFETIME_MS = 1_000;

interface Key { key: string; sign(bytes: Uint8Array): string; seed: string }

function ed25519Key(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  // The 32-byte seed is the PKCS#8 encoding's last 32 bytes.
  const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32).toString("base64url");
  return { key: `ed25519:${raw.toString("base64url")}`, sign: (bytes) => sign(null, bytes, privateKey).toString("base64url"), seed };
}

function profileIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  return {
    profileTree: personProfileTreeID(raw),
    publicKey: raw.toString("base64url"),
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString("base64url"),
  };
}

async function snapshotOf(files: Record<string, string>): Promise<TreeSnapshot> {
  const directory = await mkdtemp(join(sandbox, "snapshot-"));
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
  return resolveSnapshot(await snapshotDirectory(directory));
}

async function reserve(url: string, ownerName: string, members: Record<string, string>): Promise<void> {
  const owner = await deviceClient(url, ownerName);
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const lines = ["---", "type: group", "members:",
    "  -", `    profile: "overstory://${account.account.profileTree!}/"`, `    handle: "owner"`,
    ...Object.entries(members).flatMap(([handle, profile]) => ["  -", `    profile: "overstory://${profile}/"`, `    handle: "${handle}"`]),
    "---", "", "# Community", ""];
  const source = await mkdtemp(join(sandbox, "community-"));
  await writeFile(join(source, "_index.md"), lines.join("\n"));
  // Every tree the community root mounts keeps its entry: only _index.md changes.
  const head = await owner.snapshot(community.tree.id, community.tree.root);
  const mounted = decodeProtocolDirectory(head.objects.get(head.root)!).entries.flatMap((entry) =>
    entry.tree ? [[join(source, entry.name), entry.tree] as [string, string]] : []);
  await owner.submitUpdate(community.tree.id, community.tree.update, await resolveSnapshot(await snapshotDirectory(source, new Map(mounted))));
}

async function homeSession(url: string, profileTree: string, device: string, key: Key): Promise<ProtocolClient> {
  const anonymous = new ProtocolClient(url);
  const challenge = await anonymous.createDeviceSessionChallenge({ profileTree, device });
  const session = await anonymous.openDeviceSession(challenge, key.sign(deviceSessionChallengeBytes(challenge)));
  return new ProtocolClient(url, session.token);
}

const dana = profileIdentity();
const mac = ed25519Key(), macID = generateOverstoryID("dv");
const phone = ed25519Key(), phoneID = generateOverstoryID("dv");
let sandbox: string;
let a: Awaited<ReturnType<typeof serveHost>>;
let b: Awaited<ReturnType<typeof serveHost>>;
let home: string;
let shared: string;
let hidden: string;
let owner: ProtocolClient;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-visitors-"));
  a = await serveHost({
    dataRoot: join(sandbox, "a"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [testAccount("owner", "visitor-owner-a", { communityWriter: true })],
  });
  b = await serveHost({
    dataRoot: join(sandbox, "b"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "orchard", name: "Orchard" },
    accounts: [testAccount("owner", "visitor-owner-b", { communityWriter: true })],
    lifetimes: { deviceKeyLifetimeMs: LIFETIME_MS, deviceKeyRefetchMs: 200, deviceKeyStaleMs: 3_000 },
  });
  home = new URL(a.url).origin;

  // Dana claims ~dana at A with her Mac and pairs her phone; her profile is public.
  await reserve(a.url, "visitor-owner-a", { dana: dana.profileTree });
  const configurationTree = treeConfigurationID(dana.profileTree);
  const anonymous = new ProtocolClient(a.url);
  const challenge = await anonymous.createAccountChallenge({ account: `${home}/~dana`, profileTree: dana.profileTree, configurationTree });
  const config = initialPersonConfig(dana.profileTree, { id: macID, label: "Dana's Mac", key: mac.key });
  await anonymous.joinAccount({
    account: `${home}/~dana`, profileTree: dana.profileTree, configurationTree, challenge,
    publicKey: dana.publicKey, signature: dana.sign(accountChallengeBytes(challenge)),
    device: { id: macID, label: "Dana's Mac", key: mac.key },
    configuration: activationElement(snapshotTreeConfig({ ...config, access: [...config.access, { who: "everyone", allow: ["read"] }] }, directoryStamper(undefined, 0))),
  });
  const macAtA = await homeSession(a.url, dana.profileTree, macID, mac);
  await macAtA.submitUpdate(dana.profileTree, null, await snapshotOf({ "_index.md": "---\ntype: person\ndisplayName: Dana\n---\n" }));
  const offer = await macAtA.createPairing();
  await new ProtocolClient(a.url).claimPairing(offer.id, offer.secret, { id: phoneID, label: "Dana's phone", key: phone.key });

  // On B, the owner shares one tree with Dana by her locator at A, and keeps another private.
  owner = await deviceClient(b.url, "visitor-owner-b");
  const ownerProfile = (await owner.account()).account.profileTree!;
  shared = await hostTree(owner, await snapshotOf({ "_index.md": "# Shared\n" }), {
    parent: { tree: ownerProfile, name: "shared", kind: "person" },
    access: [{ who: { profile: `${home}/~dana` }, allow: ["write"] }],
  });
  hidden = await hostTree(owner, await snapshotOf({ "_index.md": "# Hidden\n" }), {
    parent: { tree: ownerProfile, name: "hidden", kind: "person" },
  });
});

afterAll(async () => {
  for (const host of [b, a]) {
    host?.server.stop(true);
    await host?.overstoryd[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("visitor sessions (accounts §5.6)", () => {
  test("a device A lists opens a visitor session on B, where Dana has no account", async () => {
    expect(b.overstoryd.account(dana.profileTree)).toBeNull();
    const session = await openVisitorSession(b.url, dana.profileTree, macID, mac.seed, home);
    expect(session.token).toStartWith("arv_");
    expect(session.device).toBe(macID);
    // Nothing of the visitor is stored as an account.
    expect(b.overstoryd.account(dana.profileTree)).toBeNull();
  });

  test("it reads what B's rules grant her locator at A, read only, and nothing else", async () => {
    const visitor = new ProtocolClient(b.url, (await openVisitorSession(b.url, dana.profileTree, macID, mac.seed, home)).token);
    const descriptor = await visitor.descriptor(shared);
    expect(descriptor.tree.access).toBe("read");
    const snapshot = await visitor.snapshot(shared, descriptor.tree.root);
    expect(snapshot.root).toBe(descriptor.tree.root);
    expect((await visitor.list()).snapshot.map((tree) => tree.id)).toContain(shared);
    await expect(visitor.descriptor(hidden)).rejects.toThrow("not-found");
    // A visitor never writes, whatever the rule allows.
    const write = await visitor.submitUpdate(shared, descriptor.tree.update, await snapshotOf({ "_index.md": "# Shared\n\nVisited.\n" })).catch((error: unknown) => error);
    // The update route reads a visitor as anyone, to whom the tree does not exist.
    expect(String(write)).toContain("not-found");
    // Account routes treat a visitor as no account at all.
    await expect(visitor.account()).rejects.toThrow();
  });

  test("a home host that does not list the device, or B itself, cannot vouch for it", async () => {
    await expect(openVisitorSession(b.url, dana.profileTree, generateOverstoryID("dv"), mac.seed, home)).rejects.toThrow("not-found");
    // The key A lists for the Mac is not the phone's.
    const anonymous = new ProtocolClient(b.url);
    const challenge = await anonymous.createDeviceSessionChallenge({ profileTree: dana.profileTree, device: macID, homeHost: home });
    await expect(anonymous.openDeviceSession(challenge, phone.sign(deviceSessionChallengeBytes(challenge)))).rejects.toThrow("permission-denied");
    await expect(openVisitorSession(b.url, dana.profileTree, macID, mac.seed, new URL(b.url).origin)).rejects.toThrow();
  });

  test("a rule naming her locator at another host does not reach a visitor vouched for by A", async () => {
    const elsewhere = await hostTree(owner, await snapshotOf({ "_index.md": "# Elsewhere\n" }), {
      access: [{ who: { profile: dana.profileTree }, allow: ["read"] }],
    });
    const visitor = new ProtocolClient(b.url, (await openVisitorSession(b.url, dana.profileTree, macID, mac.seed, home)).token);
    await expect(visitor.descriptor(elsewhere)).rejects.toThrow("not-found");
  });

  test("a rule naming her by her own domain reaches her as a visitor, once her profile names the domain back", async () => {
    // Dana's "domain" is a loopback host serving the well-known file (locators §1.1).
    const domain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
      new URL(request.url).pathname === "/.well-known/overstory-profile" ? Response.json({ profile: `${home}/~dana` }) : new Response("", { status: 404 }) });
    try {
      const name = `127.0.0.1:${domain.port}`;
      const share = async (label: string) => hostTree(owner, await snapshotOf({ "_index.md": `# ${label}\n` }), {
        access: [{ who: { profile: `http://${name}` }, allow: ["read"] }],
      });
      // Until her profile lists the domain, the domain names nobody.
      await expect(share("Too soon")).rejects.toThrow("names it back");
      const macAtA = await homeSession(a.url, dana.profileTree, macID, mac);
      const profile = await macAtA.descriptor(dana.profileTree);
      await macAtA.submitUpdate(dana.profileTree, profile.tree.update,
        await snapshotOf({ "_index.md": `---\ntype: person\ndisplayName: Dana\ndomains: ["${name}"]\n---\n` }));
      const byDomain = await share("By domain");
      const visitor = new ProtocolClient(b.url, (await openVisitorSession(b.url, dana.profileTree, macID, mac.seed, home)).token);
      expect((await visitor.descriptor(byDomain)).tree.access).toBe("read");
      // Vouched for by B itself, not her home, she is not the domain's profile.
      await expect(openVisitorSession(b.url, dana.profileTree, macID, mac.seed, new URL(b.url).origin)).rejects.toThrow();
    } finally {
      domain.stop(true);
    }
  });

  test("a visitor's watch ends when the rule goes, and its session when A stops listing the device", async () => {
    const phoneVisitor = new ProtocolClient(b.url, (await openVisitorSession(b.url, dana.profileTree, phoneID, phone.seed, home)).token);
    const watching = (async () => {
      for await (const _event of phoneVisitor.watch(shared, null)) { /* frames */ }
      return "ended";
    })();
    await Bun.sleep(100);
    const macAtA = await homeSession(a.url, dana.profileTree, macID, mac);
    await editTreeConfig(macAtA, dana.profileTree, "person", (values) => {
      const { [phoneID]: _phone, ...rest } = values.devices!;
      return { ...values, devices: rest };
    });
    expect(await Promise.race([watching, Bun.sleep(LIFETIME_MS + 1_500).then(() => "still open")])).toBe("ended");
    await expect(phoneVisitor.descriptor(shared)).rejects.toThrow("unauthenticated");

    const macVisitor = new ProtocolClient(b.url, (await openVisitorSession(b.url, dana.profileTree, macID, mac.seed, home)).token);
    expect((await macVisitor.descriptor(shared)).tree.id).toBe(shared);
    await editTreeConfig(owner, shared, "tree", (values) => ({ ...values, access: values.access.filter((rule) => !(typeof rule.who === "object" && "profile" in rule.who && rule.who.profile.startsWith("http"))) }));
    await expect(macVisitor.descriptor(shared)).rejects.toThrow("not-found");
  });
});
