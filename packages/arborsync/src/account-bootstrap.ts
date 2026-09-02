import { homedir, hostname } from "node:os";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MutationReceipt } from "@arbor/core";
import { SYSTEM_TREE, canonicalArborLocator, generateArborID, sha256 } from "@arbor/core";
import { snapshotDirectory } from "@arbor/fs";
import { arborDataRoot, arborPrivateRoot, saveCurrentDeviceID, type CommunityConfigStore } from "@arbor/stores";
import { WireClient, decodeTreeSnapshotJSON, encodeTreeSnapshotJSON, type RemoteAccountDescriptor, type TreeSnapshotJSON } from "@arbor/wire";
import type { EventBus } from "./events.ts";
import type { TreeManager } from "./tree-manager.ts";
import { ProtocolError } from "./workspace.ts";

export interface AccountBootstrapDeps {
  trees: TreeManager;
  events: EventBus;
  communityConfig: CommunityConfigStore;
}

interface PendingClaimBootstrap {
  version: 1;
  origin: string;
  handle: string;
  path: string;
  label: string;
  profileTree: string;
  configurationTree: string;
  deviceID: string;
  credentialDigest: `sha256:${string}`;
  files: { account: string; trees: string; device: string };
  profile: TreeSnapshotJSON;
  configuration: TreeSnapshotJSON;
}

const bootstrapSnapshot = decodeTreeSnapshotJSON;
const persistableBootstrapSnapshot = encodeTreeSnapshotJSON;

export function resolveUserPath(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return resolve(value);
}

export async function configuredWire(deps: AccountBootstrapDeps): Promise<{ client: WireClient; origin: string }> {
  const configured = await deps.communityConfig.get();
  if (!configured) {
    const record = await deps.communityConfig.safe();
    if (record) {
      throw new ProtocolError(
        "credential-unavailable",
        `The credential for ~${record.handle} is unavailable. Run arbor connect ${record.origin} to restore it.`,
        409,
        { path: "system:credentials" },
      );
    }
    throw new ProtocolError("not-found", "Connect to an Arbor community first", 409, { path: "system:community" });
  }
  return {
    client: new WireClient(configured.record.origin, configured.accountToken),
    origin: configured.record.origin,
  };
}

export function accountMetadata(account: RemoteAccountDescriptor) {
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: account.profileURL,
    communityTree: account.community.id,
    communityURL: canonicalArborLocator(account.community.canonical!),
    configurationTree: account.configuration.id,
    configurationRef: account.configuration.ref,
    configurationUpdate: account.configuration.update,
  };
}

export async function claimProfileBootstrap(
  deps: AccountBootstrapDeps,
  originInput: string,
  handle: string,
  inputPath: string,
  displayName?: string,
): Promise<MutationReceipt["effects"]> {
  const origin = new URL(originInput).origin;
  const requested = resolveUserPath(inputPath);
  await mkdir(requested, { recursive: true });
  const path = await realpath(requested);
  const index = join(path, "_index.md");
  const exists = await stat(index).then(() => true).catch(() => false);
  if (!exists) {
    await writeFile(index, `---\ntype: person\n---\n\n# ${displayName?.trim() || handle}\n`);
  } else if (!/^type:\s*person\s*$/m.test(await readFile(index, "utf8"))) {
    throw new ProtocolError("invalid-reference", "Profile _index.md must declare type: person", 409, { path });
  }
  const dataHome = arborDataRoot();
  const accountPath = join(dataHome, "account.yaml");
  const treesPath = join(dataHome, "trees.yaml");
  const devicesPath = join(dataHome, "devices");
  const pendingPath = join(arborPrivateRoot(), "bootstrap-claim.json");
  let pending: PendingClaimBootstrap | undefined;
  try { pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingClaimBootstrap; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let credential = await deps.communityConfig.provisionalCredential();
  if (pending) {
    if (pending.version !== 1 || pending.origin !== origin || pending.handle !== handle || pending.path !== path) {
      throw new ProtocolError("conflict", "A different profile bootstrap is already pending in this data home", 409);
    }
    if (!credential || `sha256:${sha256(credential)}` !== pending.credentialDigest) {
      throw new ProtocolError("conflict", "The pending bootstrap credential is unavailable", 409);
    }
  } else {
    if (await Promise.any([accountPath, treesPath, devicesPath].map((candidate) => stat(candidate).then(() => true))).catch(() => false)) {
      throw new ProtocolError("conflict", "Account configuration already exists; bootstrap will not rewrite authored YAML", 409);
    }
    const profileTree = generateArborID("tr");
    const configurationTree = generateArborID("tr");
    const deviceID = generateArborID("dv");
    credential = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const label = hostname() || "Initial device";
    const files = {
      account: [
        "version: 1", `community: ${JSON.stringify(origin)}`, "profile:", `  tree: ${JSON.stringify(profileTree)}`,
        `  handle: ${JSON.stringify(handle)}`, "admins:", `  - ${JSON.stringify(deviceID)}`, "",
      ].join("\n"),
      trees: [
        "version: 1", "trees:", `  ${JSON.stringify(profileTree)}:`,
        `    canonicalPath: ${JSON.stringify(`/~${handle}`)}`, "    access:", "      - subject:",
        "          kind: everyone", "        access: read", "",
      ].join("\n"),
      device: [
        "version: 1", `label: ${JSON.stringify(label)}`, "placements:", `  ${JSON.stringify(profileTree)}:`,
        `    server: ${JSON.stringify(origin)}`, `    path: ${JSON.stringify(path)}`, "",
      ].join("\n"),
    };
    const staging = join(arborPrivateRoot(), `bootstrap-config-${crypto.randomUUID()}`);
    await mkdir(join(staging, "devices"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(staging, "account.yaml"), files.account, { mode: 0o600 });
      await writeFile(join(staging, "trees.yaml"), files.trees, { mode: 0o600 });
      await writeFile(join(staging, "devices", `${deviceID}.yaml`), files.device, { mode: 0o600 });
      pending = {
        version: 1, origin, handle, path, label, profileTree, configurationTree, deviceID,
        credentialDigest: `sha256:${sha256(credential)}`,
        files,
        profile: persistableBootstrapSnapshot(await snapshotDirectory(path)),
        configuration: persistableBootstrapSnapshot(await snapshotDirectory(staging)),
      };
      await deps.communityConfig.storeProvisionalCredential(credential);
      const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
      await rename(temporary, pendingPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const install = async (destination: string, source: string) => {
    const existing = await readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing !== null && existing !== source) throw new ProtocolError("conflict", `Bootstrap will not overwrite ${destination}`, 409);
    if (existing === null) await writeFile(destination, source, { mode: 0o600, flag: "wx" });
  };
  await mkdir(devicesPath, { recursive: true, mode: 0o700 });
  await install(accountPath, pending.files.account);
  await install(treesPath, pending.files.trees);
  await install(join(devicesPath, `${pending.deviceID}.yaml`), pending.files.device);
  await saveCurrentDeviceID(pending.deviceID);
  if (!credential) throw new ProtocolError("conflict", "The bootstrap credential is unavailable", 409);
  const result = await new WireClient(origin).claim(handle, {
    profileTree: pending.profileTree,
    configurationTree: pending.configurationTree,
    device: { id: pending.deviceID, label: pending.label, credentialDigest: pending.credentialDigest },
    profile: bootstrapSnapshot(pending.profile),
    configuration: bootstrapSnapshot(pending.configuration),
  });
  await deps.communityConfig.set(origin, credential, accountMetadata(result.account));
  await rm(pendingPath, { force: true });
  await deps.trees.refreshConfiguration();
  return [
    { kind: "updated", ref: { tree: result.configuration.id, path: "/account.yaml", stableKey: null } },
    { kind: "created", ref: { tree: result.configuration.id, path: "/trees.yaml", stableKey: null } },
    { kind: "created", ref: { tree: result.tree.id, path: "/", stableKey: null } },
  ];
}

export async function forgetLocalAccount(deps: AccountBootstrapDeps): Promise<void> {
  await deps.communityConfig.remove();
  deps.trees.invalidateDescriptors();
  deps.events.emit({ tree: SYSTEM_TREE, kind: "updated", ref: { tree: SYSTEM_TREE, path: "/credentials", stableKey: null }, origin: "api" });
}

export async function createPairingBootstrap(deps: AccountBootstrapDeps) {
  const { client } = await configuredWire(deps);
  return client.createPairing();
}
