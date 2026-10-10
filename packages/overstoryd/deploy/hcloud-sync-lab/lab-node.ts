#!/usr/bin/env bun
/**
 * Steps of the hcloud sync lab that run on one lab machine. Each mode reads
 * one JSON object from standard input and writes one JSON object to standard
 * output, so credentials travel only over SSH standard input.
 */
import { createPrivateKey, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configurationCheckoutPath,
  storyDataRoot,
  decodeProtocolDirectory,
  deviceKeyFromSeed,
  deviceSessionChallengeBytes,
  encodeProtocolDirectory,
  generateOverstoryID,
  generateDeviceKeySeed,
  hashObject,
  HostAccountStore,
  ProtocolClient,
  ProtocolHTTPError,
  readTreeConfigGraph,
  saveCurrentAccountDeviceID,
  snapshotTreeConfig,
  type TreeConfigKind,
  type TreeConfigValues,
  type TreeSnapshot,
} from "@ovst/protocol";

/** The community's canonical origin inside the tailnet, and the same host from the community itself. The
 * environment overrides exist only to rehearse these modes against a local overstoryd. */
export const COMMUNITY = process.env.OVERSTORYD_LAB_COMMUNITY ?? "http://story-community:4318";
export const LOCAL_COMMUNITY = process.env.OVERSTORYD_LAB_LOCAL_COMMUNITY ?? "http://127.0.0.1:4318";

export async function input<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text()) as T;
}

export function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

/** A key device the lab holds: its profile, DeviceID and Ed25519 seed. */
export interface LabDevice {
  profileTree: string;
  device: string;
  seed: string;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A client for `device` at `endpoint`, through a session it opens by signing
 * the host's challenge. The challenge names the host's canonical origin even
 * when the lab reaches it at 127.0.0.1, so the lab trusts the host it asked.
 */
export async function labClient(endpoint: string, device: LabDevice, options: { timeoutMs?: number } = {}): Promise<ProtocolClient> {
  return new ProtocolClient(endpoint, await labSession(endpoint, device, options), options);
}

/** The session token `labClient` sends. */
export async function labSession(endpoint: string, device: LabDevice, options: { timeoutMs?: number } = {}): Promise<string> {
  const host = new ProtocolClient(endpoint, undefined, options);
  const challenge = await host.createDeviceSessionChallenge({ profileTree: device.profileTree, device: device.device });
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(device.seed, "base64url")]), format: "der", type: "pkcs8" });
  return (await host.openDeviceSession(challenge, sign(null, deviceSessionChallengeBytes(challenge), key).toString("base64url"))).token;
}

/** Resolve when `read` fails with the existence-hiding 404; fail otherwise. */
export async function expectNotFound(read: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await read();
  } catch (error) {
    if (error instanceof ProtocolHTTPError && error.status === 404) return;
    if (error instanceof Error && /\b404\b|not-found|Not found/.test(error.message)) return;
    throw error;
  }
  throw new Error(message);
}

/** A tree's current descriptor and exact accepted snapshot. */
export async function readAccepted(client: ProtocolClient, tree: string) {
  const current = await client.descriptor(tree);
  return { descriptor: current.tree, snapshot: await client.snapshot(tree, current.tree.root) };
}

/** The bytes of one file directly under a snapshot's root. */
export function rootFile(snapshot: TreeSnapshot, name: string): Uint8Array {
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const hash = root.entries.find((entry) => entry.name === name)?.file;
  const bytes = hash ? snapshot.objects.get(hash) : undefined;
  if (!bytes) throw new Error(`${name} is missing from ${snapshot.root}`);
  return bytes;
}

export function rootText(snapshot: TreeSnapshot, name: string): string {
  return new TextDecoder().decode(rootFile(snapshot, name));
}

/** Directory entries are ordered by the UTF-8 bytes of their names. */
function byUTF8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** The snapshot with one root file added or replaced; every other entry is kept exactly. */
export function withRootFile(snapshot: TreeSnapshot, name: string, contents: string | Uint8Array): TreeSnapshot {
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const file = hashObject(bytes);
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  const entries = root.entries.some((entry) => entry.name === name)
    ? root.entries.map((entry) => entry.name === name ? { name, file } : entry)
    : [...root.entries, { name, file }].sort((a, b) => byUTF8(a.name, b.name));
  const encoded = encodeProtocolDirectory({ ...root, entries });
  const next = hashObject(encoded);
  return { root: next, objects: new Map([...snapshot.objects, [file, bytes], [next, encoded]]) };
}

/** A snapshot of a directory holding exactly the given root files. */
export function filesSnapshot(files: Record<string, string>): TreeSnapshot {
  const objects = new Map<string, Uint8Array>();
  const entries = Object.keys(files).sort(byUTF8).map((name) => {
    const bytes = new TextEncoder().encode(files[name]!);
    const file = hashObject(bytes);
    objects.set(file, bytes);
    return { name, file };
  });
  const encoded = encodeProtocolDirectory({ type: "directory", entries });
  const root = hashObject(encoded);
  objects.set(root, encoded);
  return { root, objects };
}

/** Edit a tree's configuration as one of its administrators. */
export async function editTreeConfig(
  client: ProtocolClient,
  tree: string,
  kind: TreeConfigKind,
  change: (values: TreeConfigValues) => TreeConfigValues,
): Promise<void> {
  const { tree: descriptor, snapshot } = await client.treeConfiguration(tree);
  const { sources: _sources, ...values } = readTreeConfigGraph(snapshot, kind, tree);
  await client.submitUpdate(descriptor.id, descriptor.update, snapshotTreeConfig(change(values)), { ifCurrent: descriptor.update });
}

/**
 * Declare, mount and activate a tree administered by `client`'s profile: its
 * configuration grants the profile `admin` plus `access`, its parent mounts it
 * at `name`, and its first snapshot activates it.
 */
export async function hostTree(
  client: ProtocolClient,
  snapshot: TreeSnapshot,
  options: { access?: TreeConfigValues["access"]; mount?: { parent: string; kind: TreeConfigKind; name: string } } = {},
): Promise<string> {
  const { account } = await client.account();
  if (!account.profileTree) throw new Error("The account has no profile");
  const tree = generateOverstoryID("tr");
  await client.declareTree(tree, snapshotTreeConfig({
    access: [{ who: { profile: account.profileTree }, allow: ["admin"] }, ...(options.access ?? [])],
    mounts: {},
  }));
  if (options.mount) {
    const { parent, kind, name } = options.mount;
    await editTreeConfig(client, parent, kind, (values) => ({ ...values, mounts: { ...values.mounts, [name]: tree } }));
  }
  const activated = await client.submitUpdate(tree, null, snapshot);
  if (activated.outcome !== "accepted") throw new Error(`Activating ${tree} was ${activated.outcome}`);
  return tree;
}

/**
 * Pair a new key device into the owner's account: the owner offers a
 * pairing, the new device claims it with a key only it holds, and the owner
 * optionally makes it an administrator in its profile's `devices.yaml`.
 */
export async function pairDevice(
  owner: ProtocolClient,
  origin: string,
  label: string,
  administrator: boolean,
): Promise<LabDevice> {
  const offer = await owner.createPairing();
  const { account } = await owner.account();
  const device = generateOverstoryID("dv");
  const seed = generateDeviceKeySeed();
  const claimed = await new ProtocolClient(origin).claimPairing(offer.id, offer.secret, { id: device, label, key: deviceKeyFromSeed(seed) });
  if (claimed.device.id !== device) throw new Error("Pairing claimed a different DeviceID");
  if (administrator) {
    await editTreeConfig(owner, account.profileTree!, "person", (values) => ({
      ...values,
      devices: { ...values.devices, [device]: { ...values.devices![device]!, administrator: true } },
    }));
  }
  return { profileTree: account.profileTree!, device, seed };
}

/**
 * Pair this client machine into the owner's account and install the account
 * the way a connected Story Sync holds it: the account checkout (the profile's
 * configuration), an empty placement list, the current device, and its key
 * in the credential store. The owner's device is used only to offer the
 * pairing and is never stored here.
 */
async function connect(): Promise<void> {
  const value = await input<{ owner: LabDevice; label: string; administrator?: boolean }>();
  const owner = await labClient(COMMUNITY, value.owner, { timeoutMs: 30_000 });
  const paired = await pairDevice(owner, COMMUNITY, value.label, value.administrator === true);
  const { device } = paired;
  const client = await labClient(COMMUNITY, paired, { timeoutMs: 30_000 });
  const { account } = await client.account();
  if (!account.profileTree || !account.handle) throw new Error("The paired account has no profile");
  const configurationTree = account.configuration.id;
  const descriptor = await client.descriptor(configurationTree);
  const snapshot = await client.snapshot(configurationTree, descriptor.tree.root);
  const graph = readTreeConfigGraph(snapshot, "person", account.profileTree);
  const checkout = configurationCheckoutPath(configurationTree);
  await mkdir(checkout, { recursive: true, mode: 0o700 });
  for (const [path, source] of Object.entries(graph.sources)) await writeFile(join(checkout, path), source);
  await writeFile(join(storyDataRoot(), "placements.yaml"), `${JSON.stringify({ [configurationTree]: {} })}\n`, { mode: 0o600 });
  await saveCurrentAccountDeviceID(configurationTree, device);
  const origin = new URL(COMMUNITY).origin;
  await new HostAccountStore(configurationTree).setDeviceKey(paired.seed, {
    origin,
    account: `${origin}/~${account.handle}`,
    accountID: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    deviceID: device,
    configurationRef: descriptor.tree.root,
    configurationUpdate: descriptor.tree.update,
  });
  output({ device, configurationTree });
}

/**
 * Canonical semantic replay: the same change submitted twice against the same
 * base is one accepted update with one receipt.
 */
async function replay(): Promise<void> {
  const value = await input<{ owner: LabDevice }>();
  const client = await labClient(LOCAL_COMMUNITY, value.owner, { timeoutMs: 30_000 });
  const initial = filesSnapshot({ "note.md": "one\n" });
  const tree = await hostTree(client, initial);
  const { descriptor } = await readAccepted(client, tree);
  const next = filesSnapshot({ "note.md": "two\n" });
  const change = crypto.randomUUID();
  const first = await client.submitUpdate(tree, descriptor.update, next, { change });
  const second = await client.submitUpdate(tree, descriptor.update, next, { change });
  if (first.outcome !== "accepted") throw new Error(`Replay's first submission was ${first.outcome}`);
  if (first.requestDigest !== second.requestDigest || first.update.id !== second.update.id) {
    throw new Error("Semantic replay changed its accepted result");
  }
  output({ tree, historical: initial.root, current: next.root });
}

/**
 * Resolve an accepted binary alternative on `path` in favour of the bytes
 * `keep`, as a new update that declares the decision resolved.
 */
async function resolveBinary(): Promise<void> {
  const value = await input<{ owner: LabDevice; tree: string; path: string; keep: string }>();
  const client = await labClient(LOCAL_COMMUNITY, value.owner, { timeoutMs: 30_000 });
  const { descriptor, snapshot } = await readAccepted(client, value.tree);
  if (!descriptor.conflicted) throw new Error(`${value.tree} has no unresolved alternative`);
  const page = await client.conflicts(value.tree, descriptor.update, snapshot.root);
  const bytes = new TextEncoder().encode(value.keep);
  const file = hashObject(bytes);
  const decision = page.decisions.find((candidate) =>
    candidate.alternatives.some((alternative) => "file" in alternative.value && alternative.value.file === file)
  );
  if (!decision) throw new Error(`No decision on ${value.tree} offers the requested bytes`);
  const candidate = withRootFile(snapshot, value.path, bytes);
  const result = await client.submitUpdate(value.tree, descriptor.update, candidate, {
    resolves: [{ state: page.state, conflict: decision.id, alternatives: decision.alternatives.map((alternative) => alternative.id) }],
  });
  if (result.outcome !== "accepted") throw new Error(`Resolution was ${result.outcome}`);
  const after = await client.descriptor(value.tree);
  if (after.tree.conflicted) throw new Error(`${value.tree} is still conflicted after its resolution`);
  output({ root: after.tree.root, update: after.tree.update });
}

/**
 * Pair a short-lived device, prove it reads `tree`, revoke it by deleting its
 * `devices.yaml` entry, and prove its session is then refused.
 */
async function deviceRevocation(): Promise<void> {
  const value = await input<{ owner: LabDevice; tree: string }>();
  const owner = await labClient(LOCAL_COMMUNITY, value.owner, { timeoutMs: 30_000 });
  const pairedDevice = await pairDevice(owner, LOCAL_COMMUNITY, "Hetzner acceptance device", false);
  const { device } = pairedDevice;
  const paired = await labClient(LOCAL_COMMUNITY, pairedDevice, { timeoutMs: 30_000 });
  await paired.descriptor(value.tree);
  const { account } = await owner.account();
  await editTreeConfig(owner, account.profileTree!, "person", (values) => {
    const devices = { ...values.devices };
    if (!devices[device]) throw new Error(`Paired device ${device} is missing from devices.yaml`);
    delete devices[device];
    return { ...values, devices };
  });
  try {
    await paired.account();
  } catch (error) {
    if (error instanceof ProtocolHTTPError && error.status === 401) {
      output({ device });
      return;
    }
    throw error;
  }
  throw new Error("A revoked device's session still authenticates");
}

/** The community owner's first device, made once before the community's
 * first start and kept root-only on the community machine. */
function ownerDevice(): void {
  output({ profileTree: generateOverstoryID("tr"), device: generateOverstoryID("dv"), seed: generateDeviceKeySeed() } satisfies LabDevice);
}

/** The `OVERSTORYD_ACCOUNTS_JSON` that bootstraps the owner account with that device. */
async function ownerAccounts(): Promise<void> {
  const owner = await input<LabDevice>();
  output([{ handle: "owner", name: "Owner", communityWriter: true, profileTree: owner.profileTree, device: { id: owner.device, key: deviceKeyFromSeed(owner.seed) } }]);
}

/** A session token for the owner's device, for the lab's raw HTTP checks on the community. */
async function ownerSession(): Promise<void> {
  process.stdout.write(await labSession(LOCAL_COMMUNITY, await input<LabDevice>(), { timeoutMs: 30_000 }));
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "connect") await connect();
  else if (mode === "replay") await replay();
  else if (mode === "resolve-binary") await resolveBinary();
  else if (mode === "device-revocation") await deviceRevocation();
  else if (mode === "owner-device") ownerDevice();
  else if (mode === "owner-accounts") await ownerAccounts();
  else if (mode === "owner-session") await ownerSession();
  else throw new Error(`Unknown lab-node mode: ${mode ?? "(missing)"}`);
}
