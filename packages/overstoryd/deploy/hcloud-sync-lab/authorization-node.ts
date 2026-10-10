#!/usr/bin/env bun
/**
 * The distinct-user authorization scenario of the hcloud sync lab. Each mode
 * runs on one lab machine, reads one JSON object from standard input, and
 * writes one JSON object to standard output.
 *
 * Alice hosts a private tree whose tree configuration (`access.yaml`) grants
 * Bob `read` and Carol `write`. Bob reads it and is refused a write with the
 * existence-hiding 404; Carol writes; the community owner, who holds no rule
 * on the tree, and an anonymous reader see nothing.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import {
  accountChallengeBytes,
  activationElement,
  canonicalHTTPURL,
  deviceKeyFromSeed,
  generateOverstoryID,
  generateDeviceKeySeed,
  initialPersonConfig,
  personProfileTreeID,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
  type AccountChallenge,
} from "@ovst/protocol";
import {
  COMMUNITY,
  expectNotFound,
  filesSnapshot,
  hostTree,
  input,
  labClient,
  LOCAL_COMMUNITY,
  output,
  type LabDevice,
  readAccepted,
  rootText,
  withRootFile,
} from "./lab-node.ts";

const ROLES = ["alice", "bob", "carol"] as const;
type Role = typeof ROLES[number];

interface Identity {
  handle: string;
  /** The profile's canonical HTTP URL. */
  locator: string;
  profile: string;
  device: LabDevice;
}

const TIMEOUT = { timeoutMs: 30_000 };

/** A self-certifying person identity whose key exists only in this process. */
function profileIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const raw = der.subarray(Buffer.from("302a300506032b6570032100", "hex").byteLength);
  return {
    profileTree: personProfileTreeID(raw),
    publicKey: raw.toString("base64url"),
    sign: (challenge: AccountChallenge) => sign(null, accountChallengeBytes(challenge), privateKey).toString("base64url"),
  };
}

/**
 * On the community: reserve one handle per role for a fresh person identity
 * in the community's `members`, claim each account with its profile key and a
 * key device, and host each profile at `/~handle`.
 */
async function setup(): Promise<void> {
  const value = await input<{ owner: LabDevice; handles: Record<Role, string> }>();
  const owner = await labClient(LOCAL_COMMUNITY, value.owner, TIMEOUT);
  const identities = Object.fromEntries(ROLES.map((role) => [role, profileIdentity()])) as Record<Role, ReturnType<typeof profileIdentity>>;

  const { account } = await owner.account();
  const community = account.community.id;
  const { descriptor, snapshot } = await readAccepted(owner, community);
  const index = rootText(snapshot, "_index.md");
  if (!index.includes("\nmembers:\n")) throw new Error("The community profile has no members list");
  const reservations = ROLES.flatMap((role) => [
    "  -",
    `    profile: ${JSON.stringify(`overstory://${identities[role].profileTree}/`)}`,
    `    handle: ${JSON.stringify(value.handles[role])}`,
  ]).join("\n");
  await owner.submitUpdate(
    community,
    descriptor.update,
    withRootFile(snapshot, "_index.md", index.replace("\nmembers:\n", `\nmembers:\n${reservations}\n`)),
    { ifCurrent: descriptor.update },
  );

  const result = {} as Record<Role, Identity>;
  for (const role of ROLES) {
    const identity = identities[role];
    const configurationTree = treeConfigurationID(identity.profileTree);
    const device = generateOverstoryID("dv");
    const label = `${role} authorization device`;
    const seed = generateDeviceKeySeed();
    const key = deviceKeyFromSeed(seed);
    const anonymous = new ProtocolClient(LOCAL_COMMUNITY, undefined, TIMEOUT);
    const challenge = await anonymous.createAccountChallenge({ profileTree: identity.profileTree, configurationTree });
    await anonymous.joinAccount({
      account: challenge.account,
      profileTree: identity.profileTree,
      configurationTree,
      challenge,
      publicKey: identity.publicKey,
      signature: identity.sign(challenge),
      device: { id: device, label, key },
      configuration: activationElement(snapshotTreeConfig(initialPersonConfig(identity.profileTree, { id: device, label, key }))),
    });
    const held: LabDevice = { profileTree: identity.profileTree, device, seed };
    const client = await labClient(LOCAL_COMMUNITY, held, TIMEOUT);
    const profile = await client.submitUpdate(
      identity.profileTree,
      null,
      filesSnapshot({ "_index.md": `---\ntype: person\n---\n\n# ${role}\n` }),
    );
    if (profile.outcome !== "accepted") throw new Error(`${role}'s profile was not activated`);
    const hosted = await client.descriptor(identity.profileTree);
    if (hosted.tree.canonical?.path !== `/~${value.handles[role]}`) throw new Error(`${role}'s profile is not at /~${value.handles[role]}`);
    result[role] = {
      handle: value.handles[role],
      locator: canonicalHTTPURL(hosted.tree.canonical),
      profile: identity.profileTree,
      device: held,
    };
  }
  output(result);
}

/** Alice hosts the private tree below her profile, granting Bob read and Carol write. */
async function create(): Promise<void> {
  const value = await input<{ device: LabDevice; bob: string; carol: string; scenario: string; endpoint?: string }>();
  const client = await labClient(value.endpoint ?? COMMUNITY, value.device, TIMEOUT);
  const { account } = await client.account();
  if (!account.profileTree) throw new Error("Alice's account has no profile");
  const tree = await hostTree(client, filesSnapshot({ "note.md": `# ${value.scenario}\n\nalice initial\n` }), {
    access: [
      { who: { profile: value.bob }, allow: ["read"] },
      { who: { profile: value.carol }, allow: ["write"] },
    ],
    mount: { parent: account.profileTree, kind: "person", name: value.scenario },
  });
  const current = await client.descriptor(tree);
  if (current.tree.access !== "write" || !current.tree.canonical) throw new Error("Alice did not receive administrator write access");
  const { policy } = await client.access(tree);
  if (policy.some((rule) => typeof rule.who !== "object" || !("profile" in rule.who))) throw new Error("Private authorization tree grants a non-profile subject");
  const granted = (profile: string) => policy.find((rule) => typeof rule.who === "object" && "profile" in rule.who && rule.who.profile === profile)?.allow;
  if (!granted(value.bob)?.includes("read")) throw new Error("Bob read access is missing");
  if (!granted(value.carol)?.includes("write")) throw new Error("Carol write access is missing");
  output({ tree, root: current.tree.root, update: current.tree.update, canonical: canonicalHTTPURL(current.tree.canonical) });
}

/** Bob reads the exact current bytes; his write is refused with the existence-hiding 404 and changes nothing. */
async function denyWrite(): Promise<void> {
  const value = await input<{ device: LabDevice; tree: string; scenario: string; endpoint?: string }>();
  const client = await labClient(value.endpoint ?? COMMUNITY, value.device, TIMEOUT);
  const { descriptor, snapshot } = await readAccepted(client, value.tree);
  if (descriptor.access !== "read") throw new Error("Bob did not receive read-only access");
  if (!rootText(snapshot, "note.md").includes("alice initial")) throw new Error("Bob could not read Alice content");
  const candidate = withRootFile(snapshot, "note.md", `# ${value.scenario}\n\nbob denied write\n`);
  await expectNotFound(
    () => client.submitUpdate(value.tree, descriptor.update, candidate),
    "Bob read-only update was accepted",
  );
  const unchanged = await client.descriptor(value.tree);
  if (unchanged.tree.root !== descriptor.root || unchanged.tree.update !== descriptor.update) {
    throw new Error("Bob denial changed the accepted head");
  }
  output({ candidate: candidate.root });
}

/** Carol's write is accepted as the new head. */
async function write(): Promise<void> {
  const value = await input<{ device: LabDevice; tree: string; scenario: string; endpoint?: string }>();
  const client = await labClient(value.endpoint ?? COMMUNITY, value.device, TIMEOUT);
  const { descriptor, snapshot } = await readAccepted(client, value.tree);
  if (descriptor.access !== "write") throw new Error("Carol did not receive write access");
  const source = rootText(snapshot, "note.md");
  if (!source.includes("alice initial")) throw new Error("Carol could not read Alice content");
  const candidate = withRootFile(snapshot, "note.md", `${source}\ncarol permitted write\n`);
  const result = await client.submitUpdate(value.tree, descriptor.update, candidate);
  if (result.outcome !== "accepted") throw new Error(`Carol update was ${result.outcome}, not accepted`);
  const current = await client.descriptor(value.tree);
  if (current.tree.root !== candidate.root) throw new Error("Carol accepted bytes are not current");
  output({ root: current.tree.root, update: current.tree.update });
}

async function verifyReader(): Promise<void> {
  const value = await input<{ device: LabDevice; tree: string; root: string; update: string; endpoint?: string }>();
  const client = await labClient(value.endpoint ?? COMMUNITY, value.device, TIMEOUT);
  const { descriptor, snapshot } = await readAccepted(client, value.tree);
  if (descriptor.access !== "read" || descriptor.root !== value.root || descriptor.update !== value.update) {
    throw new Error("Bob did not observe Carol current head");
  }
  const source = rootText(snapshot, "note.md");
  if (!source.includes("alice initial") || !source.includes("carol permitted write") || source.includes("bob denied write")) {
    throw new Error("Bob observed incorrect accepted bytes");
  }
  output({ ok: true });
}

async function verifyWriter(): Promise<void> {
  const value = await input<{ device: LabDevice; tree: string; root: string; update: string; rejected: string; endpoint?: string }>();
  const client = await labClient(value.endpoint ?? COMMUNITY, value.device, TIMEOUT);
  const { descriptor, snapshot } = await readAccepted(client, value.tree);
  if (descriptor.root !== value.root || descriptor.update !== value.update) throw new Error("Alice did not observe Carol current head");
  if (!rootText(snapshot, "note.md").includes("carol permitted write")) throw new Error("Alice did not receive Carol bytes");
  await expectNotFound(() => client.object(value.tree, value.rejected), "Bob rejected candidate object became readable");
  output({ ok: true });
}

/** The community owner holds no rule on Alice's tree; neither they nor an anonymous reader can see it. */
async function verifyOwner(): Promise<void> {
  const value = await input<{ device: LabDevice; tree: string; root: string; canonical: string }>();
  const owner = await labClient(LOCAL_COMMUNITY, value.device, TIMEOUT);
  if ((await owner.list()).snapshot.some((tree) => tree.id === value.tree)) {
    throw new Error("No-access owner could list Alice private tree");
  }
  await expectNotFound(() => owner.descriptor(value.tree), "No-access owner could read Alice private descriptor");
  await expectNotFound(() => owner.snapshot(value.tree, value.root), "No-access owner could read Alice private snapshot");
  await expectNotFound(() => owner.object(value.tree, value.root), "No-access owner could read Alice private object");
  const canonical = new URL(new URL(value.canonical).pathname, LOCAL_COMMUNITY);
  if ((await fetch(canonical)).status !== 404) throw new Error("Anonymous reader could read Alice private tree");
  output({ ok: true });
}

const mode = process.argv[2];
if (mode === "setup") await setup();
else if (mode === "create") await create();
else if (mode === "deny-write") await denyWrite();
else if (mode === "write") await write();
else if (mode === "verify-reader") await verifyReader();
else if (mode === "verify-writer") await verifyWriter();
else if (mode === "verify-owner") await verifyOwner();
else throw new Error(`Unknown authorization-node mode: ${mode ?? "(missing)"}`);
