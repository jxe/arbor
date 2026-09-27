#!/usr/bin/env bun
/**
 * Steps of the hcloud sync lab that run on one lab machine. Each mode reads
 * one JSON object from standard input and writes one JSON object to standard
 * output, so credentials travel only over SSH standard input.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accountCheckoutPath,
  arborDataRoot,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  generateArborID,
  hashObject,
  HostAccountStore,
  ProtocolClient,
  ProtocolHTTPError,
  readTreeConfigGraph,
  saveCurrentAccountDeviceID,
  sha256,
  snapshotTreeConfig,
  type TreeConfigKind,
  type TreeConfigValues,
  type TreeSnapshot,
} from "@overstory/protocol";

/** The community's canonical origin inside the tailnet, and the same host from the community itself. The
 * environment overrides exist only to rehearse these modes against a local canopyd. */
export const COMMUNITY = process.env.ARBOR_LAB_COMMUNITY ?? "http://arbor-community:4318";
export const LOCAL_COMMUNITY = process.env.ARBOR_LAB_LOCAL_COMMUNITY ?? "http://127.0.0.1:4318";

export async function input<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text()) as T;
}

export function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
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
  const tree = generateArborID("tr");
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
 * Pair a new digest device into the owner's account: the owner offers a
 * pairing, the new device claims it with a credential only it holds, and the
 * owner optionally makes it an administrator in its profile's `devices.yaml`.
 */
export async function pairDevice(
  owner: ProtocolClient,
  origin: string,
  label: string,
  administrator: boolean,
): Promise<{ device: string; credential: string }> {
  const offer = await owner.createPairing();
  const device = generateArborID("dv");
  const credential = `arb_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const claimed = await new ProtocolClient(origin).claimPairing(offer.id, offer.secret, {
    id: device,
    label,
    credentialDigest: `sha256:${sha256(credential)}`,
  });
  if (claimed.device.id !== device) throw new Error("Pairing claimed a different DeviceID");
  if (administrator) {
    const { account } = await owner.account();
    await editTreeConfig(owner, account.profileTree!, "person", (values) => ({
      ...values,
      devices: { ...values.devices, [device]: { ...values.devices![device]!, administrator: true } },
    }));
  }
  return { device, credential };
}

/**
 * Pair this client machine into the owner's account and install the account
 * the way a connected Arbor Sync holds it: the account checkout (the profile's
 * configuration), an empty placement list, the current device, and the
 * credential in the credential store. The owner credential is used only to
 * offer the pairing and is never stored here.
 */
async function connect(): Promise<void> {
  const value = await input<{ ownerToken: string; label: string; administrator?: boolean }>();
  const owner = new ProtocolClient(COMMUNITY, value.ownerToken, { timeoutMs: 30_000 });
  const { device, credential } = await pairDevice(owner, COMMUNITY, value.label, value.administrator === true);
  const client = new ProtocolClient(COMMUNITY, credential, { timeoutMs: 30_000 });
  const { account } = await client.account();
  if (!account.profileTree || !account.handle) throw new Error("The paired account has no profile");
  const configurationTree = account.configuration.id;
  const descriptor = await client.descriptor(configurationTree);
  const snapshot = await client.snapshot(configurationTree, descriptor.tree.root);
  const graph = readTreeConfigGraph(snapshot, "person", account.profileTree);
  const checkout = accountCheckoutPath(configurationTree);
  await mkdir(checkout, { recursive: true, mode: 0o700 });
  for (const [path, source] of Object.entries(graph.sources)) await writeFile(join(checkout, path), source);
  await writeFile(join(arborDataRoot(), "placements.yaml"), `${JSON.stringify({ [configurationTree]: {} })}\n`, { mode: 0o600 });
  await saveCurrentAccountDeviceID(configurationTree, device);
  const origin = new URL(COMMUNITY).origin;
  await new HostAccountStore(configurationTree).set(credential, {
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
  const value = await input<{ ownerToken: string }>();
  const client = new ProtocolClient(LOCAL_COMMUNITY, value.ownerToken, { timeoutMs: 30_000 });
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
  const value = await input<{ ownerToken: string; tree: string; path: string; keep: string }>();
  const client = new ProtocolClient(LOCAL_COMMUNITY, value.ownerToken, { timeoutMs: 30_000 });
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
 * `devices.yaml` entry, and prove the same credential is then refused.
 */
async function deviceRevocation(): Promise<void> {
  const value = await input<{ ownerToken: string; tree: string }>();
  const owner = new ProtocolClient(LOCAL_COMMUNITY, value.ownerToken, { timeoutMs: 30_000 });
  const { device, credential } = await pairDevice(owner, LOCAL_COMMUNITY, "Hetzner acceptance device", false);
  const paired = new ProtocolClient(LOCAL_COMMUNITY, credential, { timeoutMs: 30_000 });
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
  throw new Error("A revoked device credential still authenticates");
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "connect") await connect();
  else if (mode === "replay") await replay();
  else if (mode === "resolve-binary") await resolveBinary();
  else if (mode === "device-revocation") await deviceRevocation();
  else throw new Error(`Unknown lab-node mode: ${mode ?? "(missing)"}`);
}
