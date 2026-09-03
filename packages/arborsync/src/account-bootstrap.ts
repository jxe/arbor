import { homedir, hostname } from "node:os";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MutationReceipt } from "@arbor/core";
import { SYSTEM_TREE, canonicalArborLocator, generateArborID, isGeneratedArborID, sha256 } from "@arbor/core";
import { snapshotDirectory } from "@arbor/fs";
import {
  CanopyAccountStore,
  arborDataRoot,
  arborPrivateRoot,
  loadCanopyAccountConfigurations,
  loadLocalPlacements,
  saveCurrentAccountDeviceID,
  saveCurrentDeviceID,
  type CommunityConfigStore,
} from "@arbor/stores";
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

interface PendingAccountClaimBootstrap {
  version: 2;
  account: string;
  origin: string;
  path: string;
  label: string;
  profileTree: string;
  configurationTree: string;
  deviceID: string;
  credentialDigest: `sha256:${string}`;
  files: { account: string; trees: string; devices: string; placements: string };
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
  if (!account.handle) throw new Error("The legacy account adapter requires a Canopy handle");
  return {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: account.profileURL,
    communityTree: account.community.id,
    communityURL: canonicalArborLocator(account.community.canonical!),
    configurationTree: account.configuration.id,
    configurationRef: account.configuration.root,
    configurationUpdate: account.configuration.update,
  };
}

async function claimLegacyProfileBootstrap(
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

/**
 * Fresh-home v2 bootstrap. The legacy singleton writer above is an isolated
 * compatibility path and this function never emits the v1 graph.
 */
async function claimAccountProfileBootstrap(
  deps: AccountBootstrapDeps,
  accountLocator: string,
  inputPath: string,
  displayName?: string,
): Promise<MutationReceipt["effects"]> {
  let accountURL: URL;
  try {
    accountURL = new URL(accountLocator);
  } catch {
    throw new ProtocolError("invalid-request", "Account must be a canonical HTTPS Canopy URL", 400);
  }
  const loopback = accountURL.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(accountURL.hostname);
  if (
    (accountURL.protocol !== "https:" && !loopback)
    || accountURL.username || accountURL.password || accountURL.search || accountURL.hash
  ) {
    throw new ProtocolError("invalid-request", "Account must be a canonical HTTPS Canopy URL", 400);
  }
  const origin = accountURL.origin;
  const account = `${origin}${accountURL.pathname}`.replace(/\/$/, "");
  const accountLabel = accountURL.pathname.split("/").filter(Boolean).at(-1) ?? "Profile";
  const requested = resolveUserPath(inputPath);
  await mkdir(requested, { recursive: true });
  const path = await realpath(requested);
  const index = join(path, "_index.md");
  const exists = await stat(index).then(() => true).catch(() => false);
  if (!exists) {
    await writeFile(index, `---\ntype: person\n---\n\n# ${displayName?.trim() || accountLabel}\n`);
  } else if (!/^type:\s*person\s*$/m.test(await readFile(index, "utf8"))) {
    throw new ProtocolError("invalid-reference", "Profile _index.md must declare type: person", 409, { path });
  }
  const profileTree = (await deps.trees.openSession(path)).tree;
  if (!isGeneratedArborID(profileTree, "tr")) {
    throw new ProtocolError(
      "conflict",
      "This local tree still has a legacy root identity; migrate it to a generated TreeID before claiming a Canopy account",
      409,
      { path },
    );
  }

  const pendingPath = join(arborPrivateRoot(), "bootstrap-account-claim.json");
  let pending: PendingAccountClaimBootstrap | undefined;
  try { pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingAccountClaimBootstrap; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let credential: string | null = null;
  if (pending) {
    if (pending.version !== 2 || pending.account !== account || pending.origin !== origin || pending.path !== path || pending.profileTree !== profileTree) {
      throw new ProtocolError("conflict", "A different account bootstrap is already pending in this data home", 409);
    }
    credential = await new CanopyAccountStore(pending.configurationTree).provisionalCredential();
    if (!credential || `sha256:${sha256(credential)}` !== pending.credentialDigest) {
      throw new ProtocolError("conflict", "The pending account credential is unavailable", 409);
    }
  } else {
    const legacyAuthoredFiles = [
      join(arborDataRoot(), "account.yaml"),
      join(arborDataRoot(), "trees.yaml"),
    ];
    const hasLegacyLayout = (await Promise.all([
      ...legacyAuthoredFiles.map((candidate) => stat(candidate).then(() => true).catch(() => false)),
      readdir(join(arborDataRoot(), "devices")).then((entries) => entries.length > 0).catch(() => false),
    ])).some(Boolean);
    if (hasLegacyLayout) {
      throw new ProtocolError("conflict", "Account bootstrap will not mix the plural layout with legacy account files", 409);
    }
    const existingAccounts = await loadCanopyAccountConfigurations();
    if (existingAccounts.some((candidate) => candidate.diagnostics.length || !candidate.account || !candidate.trees || !candidate.devices || !candidate.currentDevice)) {
      throw new ProtocolError("conflict", "All existing account checkouts must be valid before another account is added", 409);
    }
    const otherProfile = existingAccounts.find((candidate) => candidate.account!.profile !== profileTree);
    if (otherProfile) {
      throw new ProtocolError(
        "conflict",
        `Account ${otherProfile.configurationTree} belongs to another local profile identity`,
        409,
        { path },
      );
    }
    const placements = await loadLocalPlacements();
    if (placements.diagnostics.length) {
      throw new ProtocolError("conflict", "placements.yaml must be valid before another account is added", 409);
    }
    const configurationTree = generateArborID("tr");
    const deviceID = generateArborID("dv");
    credential = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const label = hostname() || "Initial device";
    const files = {
      account: [
        `canopy: ${JSON.stringify(origin)}`,
        `profile: ${JSON.stringify(profileTree)}`,
        "",
      ].join("\n"),
      trees: "{}\n",
      devices: [
        `${JSON.stringify(deviceID)}:`,
        `  label: ${JSON.stringify(label)}`,
        "  administrator: true",
        "",
      ].join("\n"),
      placements: "{}\n",
    };
    const staging = join(arborPrivateRoot(), `bootstrap-account-config-${crypto.randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(staging, "account.yaml"), files.account, { mode: 0o600 });
      await writeFile(join(staging, "trees.yaml"), files.trees, { mode: 0o600 });
      await writeFile(join(staging, "devices.yaml"), files.devices, { mode: 0o600 });
      pending = {
        version: 2,
        account,
        origin,
        path,
        label,
        profileTree,
        configurationTree,
        deviceID,
        credentialDigest: `sha256:${sha256(credential)}`,
        files,
        configuration: persistableBootstrapSnapshot(await snapshotDirectory(staging)),
      };
      await new CanopyAccountStore(configurationTree).storeProvisionalCredential(credential);
      await mkdir(arborPrivateRoot(), { recursive: true, mode: 0o700 });
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
  const accountPath = join(arborDataRoot(), "accounts", pending.configurationTree);
  await mkdir(accountPath, { recursive: true, mode: 0o700 });
  await install(join(accountPath, "account.yaml"), pending.files.account);
  await install(join(accountPath, "trees.yaml"), pending.files.trees);
  await install(join(accountPath, "devices.yaml"), pending.files.devices);
  const placementsPath = join(arborDataRoot(), "placements.yaml");
  if (!await stat(placementsPath).then(() => true).catch(() => false)) {
    await install(placementsPath, pending.files.placements);
  }
  await saveCurrentAccountDeviceID(pending.configurationTree, pending.deviceID);

  if (!credential) throw new ProtocolError("conflict", "The bootstrap credential is unavailable", 409);
  const result = await new WireClient(origin).joinAccount({
    account: pending.account,
    profileTree: pending.profileTree,
    configurationTree: pending.configurationTree,
    device: { id: pending.deviceID, label: pending.label, credentialDigest: pending.credentialDigest },
    configuration: bootstrapSnapshot(pending.configuration),
  });
  if (result.account.configuration.id !== pending.configurationTree || result.account.profileTree !== pending.profileTree) {
    throw new ProtocolError("conflict", "Claimed account identity disagrees with the prepared bootstrap", 409);
  }
  await new CanopyAccountStore(pending.configurationTree).set(credential, {
    origin,
    account: pending.account,
    accountID: result.account.id,
    ...(result.account.handle ? { handle: result.account.handle } : {}),
    profileTree: pending.profileTree,
    deviceID: pending.deviceID,
    configurationRef: result.account.configuration.root,
    configurationUpdate: result.account.configuration.update,
  });
  await rm(pendingPath, { force: true });
  await deps.trees.refreshConfiguration();
  return [
    { kind: "updated", ref: { tree: result.configuration.id, path: "/account.yaml", stableKey: null } },
    { kind: "created", ref: { tree: result.configuration.id, path: "/trees.yaml", stableKey: null } },
  ];
}

/**
 * Claim one Canopy-chosen account locator for an already identified local
 * profile tree. This does not declare or upload the profile tree.
 */
export async function claimCanopyAccountBootstrap(
  deps: AccountBootstrapDeps,
  accountLocator: string,
  inputPath: string,
  displayName?: string,
): Promise<MutationReceipt["effects"]> {
  return claimAccountProfileBootstrap(deps, accountLocator, inputPath, displayName);
}

export async function claimProfileBootstrap(
  deps: AccountBootstrapDeps,
  originInput: string,
  handle: string,
  inputPath: string,
  displayName?: string,
  layout: "legacy" | "accounts" = "legacy",
): Promise<MutationReceipt["effects"]> {
  return layout === "accounts"
    // Removable bridge for clients that still present the current Canopy's
    // handle UI instead of sending its complete account locator.
    ? claimAccountProfileBootstrap(deps, `${new URL(originInput).origin}/~${handle}`, inputPath, displayName)
    : claimLegacyProfileBootstrap(deps, originInput, handle, inputPath, displayName);
}

export async function forgetLocalAccount(deps: AccountBootstrapDeps): Promise<void> {
  await deps.communityConfig.remove();
  deps.trees.invalidateDescriptors();
  deps.events.emit({ tree: SYSTEM_TREE, kind: "updated", ref: { tree: SYSTEM_TREE, path: "/credentials", stableKey: null }, origin: "api" });
}

export async function createPairingBootstrap(deps: AccountBootstrapDeps, configurationTree?: string) {
  if (configurationTree) {
    const configured = await new CanopyAccountStore(configurationTree).get();
    if (!configured) throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${configurationTree}`, 409);
    return new WireClient(configured.record.origin, configured.accountToken).createPairing();
  }
  const plural = await CanopyAccountStore.list();
  if (plural.length > 1) {
    throw new ProtocolError("invalid-request", "Pairing requires an explicit configuration TreeID when several accounts are connected", 400);
  }
  if (plural.length === 1) {
    const configured = await new CanopyAccountStore(plural[0]!.configurationTree).get();
    if (!configured) throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${plural[0]!.configurationTree}`, 409);
    return new WireClient(configured.record.origin, configured.accountToken).createPairing();
  }
  const { client } = await configuredWire(deps);
  return client.createPairing();
}
