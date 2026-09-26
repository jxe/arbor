import { homedir, hostname } from "node:os";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MutationReceipt } from "@overstory/protocol";
import { generateArborID, initialPersonConfig, isPersonProfileTreeID, sha256, treeConfigSources, treeConfigurationID, type AccountChallenge, HostAccountStore, arborDataRoot, arborPrivateRoot, loadAccountConfigurations, saveCurrentAccountDeviceID, ProtocolClient, decodeTreeSnapshotJSON, encodeTreeSnapshotJSON, type TreeSnapshotJSON, ProtocolError } from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { withLocalStateLock, ProfileIdentityStore, loadLocalPlacements } from "@overstory/arborsync/state";
import type { AccountBootstrapDeps } from "./ports.ts";

interface PendingAccountClaimBootstrap {
  version: 3;
  stage?: "prepared" | "submitting";
  account: string;
  origin: string;
  path: string;
  label: string;
  profileTree: string;
  configurationTree: string;
  deviceID: string;
  credentialDigest: `sha256:${string}`;
  /** The profile configuration's files, installed as the account checkout, and `placements.yaml`. */
  files: Record<string, string>;
  configuration: TreeSnapshotJSON;
  challenge?: AccountChallenge;
  publicKey?: string;
  signature?: string;
  inviteCode?: string;
}

const bootstrapSnapshot = decodeTreeSnapshotJSON;
const persistableBootstrapSnapshot = encodeTreeSnapshotJSON;

export function resolveUserPath(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return resolve(value);
}

/** Fresh-home bootstrap for an exact, self-certifying profile identity. */
async function claimAccountProfileBootstrap(
  deps: AccountBootstrapDeps,
  accountLocator: string,
  inputPath: string,
  displayName?: string,
  inviteCode?: string,
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
  if (!isPersonProfileTreeID(profileTree)) {
    throw new ProtocolError(
      "conflict",
      "This local profile is not bound to a self-certifying person identity; run `arbor me create` first",
      409,
      { path },
    );
  }
  const identity = new ProfileIdentityStore();
  const identityStatus = await identity.status();
  if (!identityStatus || identityStatus.profileTree !== profileTree || !identityStatus.keyAvailable) {
    throw new ProtocolError("credential-unavailable", `The private identity key for ${profileTree} is unavailable`, 409, { path });
  }

  const pendingPath = join(arborPrivateRoot(), "bootstrap-account-claim.json");
  let pending: PendingAccountClaimBootstrap | undefined;
  try { pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingAccountClaimBootstrap; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let credential: string | null = null;
  if (pending) {
    if (pending.version !== 3 || (pending.account !== account && account !== origin) || pending.origin !== origin || pending.path !== path || pending.profileTree !== profileTree) {
      throw new ProtocolError("conflict", "A different account bootstrap is already pending in this data home", 409);
    }
    credential = await new HostAccountStore(pending.configurationTree).provisionalCredential();
    if (inviteCode && pending.inviteCode && inviteCode !== pending.inviteCode) {
      throw new ProtocolError("conflict", "A different invitation code is already pending for this account", 409);
    }
    if (inviteCode && !pending.inviteCode) pending.inviteCode = inviteCode;
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
    const existingAccounts = await loadAccountConfigurations();
    if (existingAccounts.some((candidate) => candidate.diagnostics.length || !candidate.configuration || !candidate.currentDevice)) {
      throw new ProtocolError("conflict", "All existing account checkouts must be valid before another account is added", 409);
    }
    const otherProfile = existingAccounts.find((candidate) => candidate.profile !== profileTree);
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
    // One host per profile: the account's configuration is the profile's, at its derived TreeID.
    const configurationTree = treeConfigurationID(profileTree);
    if (existingAccounts.some((candidate) => candidate.configurationTree === configurationTree)) {
      throw new ProtocolError("conflict", "This profile already has an account in this data home; a profile has one home host", 409);
    }
    const deviceID = generateArborID("dv");
    credential = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const label = hostname() || "Initial device";
    // The profile is the person's public card: readable by everyone, administered by the person alone.
    const initial = initialPersonConfig(profileTree, { id: deviceID, label });
    const configuration = treeConfigSources({ ...initial, access: [...initial.access, { who: "everyone", allow: ["read"] }] });
    const files: Record<string, string> = { ...configuration, placements: "{}\n" };
    const staging = join(arborPrivateRoot(), `bootstrap-account-config-${crypto.randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const [name, source] of Object.entries(configuration)) await writeFile(join(staging, name), source, { mode: 0o600 });
      pending = {
        version: 3,
        stage: "prepared",
        account,
        origin,
        path,
        label,
        profileTree,
        configurationTree,
        deviceID,
        credentialDigest: `sha256:${sha256(credential)}`,
        ...(inviteCode ? { inviteCode } : {}),
        files,
        configuration: persistableBootstrapSnapshot(await resolveSnapshot(await snapshotDirectory(staging))),
      };
      await new HostAccountStore(configurationTree).storeProvisionalCredential(credential);
      await mkdir(arborPrivateRoot(), { recursive: true, mode: 0o700 });
      const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
      await rename(temporary, pendingPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  if (!credential) throw new ProtocolError("conflict", "The bootstrap credential is unavailable", 409);
  const client = new ProtocolClient(origin);
  if (!pending.challenge || !pending.publicKey || !pending.signature) {
    pending.challenge = await client.createAccountChallenge({
      account: pending.account === origin ? undefined : pending.account,
      profileTree: pending.profileTree,
      configurationTree: pending.configurationTree,
      inviteCode: pending.inviteCode,
    });
    if (pending.challenge.origin !== origin || pending.challenge.profileTree !== pending.profileTree || pending.challenge.configurationTree !== pending.configurationTree || (pending.account !== origin && pending.challenge.account !== pending.account)) {
      throw new ProtocolError("conflict", "Account challenge target disagrees with the requested community", 409);
    }
    pending.account = pending.challenge.account;
    const signed = await identity.signChallenge(pending.challenge);
    pending.publicKey = signed.publicKey;
    pending.signature = signed.signature;
    const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    await rename(temporary, pendingPath);
  }
  const submitClaim = async () => {
    pending.stage = "submitting";
    const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    await rename(temporary, pendingPath);
    return client.joinAccount({
      account: pending.account,
      profileTree: pending.profileTree,
      configurationTree: pending.configurationTree,
      inviteCode: pending.inviteCode,
      challenge: pending.challenge!,
      publicKey: pending.publicKey!,
      signature: pending.signature!,
      device: { id: pending.deviceID, label: pending.label, credentialDigest: pending.credentialDigest },
      configuration: bootstrapSnapshot(pending.configuration),
    });
  };
  let result;
  try {
    result = await submitClaim();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Account challenge is expired")) throw error;
    pending.challenge = await client.createAccountChallenge({
      account: pending.account === origin ? undefined : pending.account,
      profileTree: pending.profileTree,
      configurationTree: pending.configurationTree,
      inviteCode: pending.inviteCode,
    });
    if (pending.challenge.origin !== origin || pending.challenge.profileTree !== pending.profileTree || pending.challenge.configurationTree !== pending.configurationTree || (pending.account !== origin && pending.challenge.account !== pending.account)) {
      throw new ProtocolError("conflict", "Account challenge target disagrees with the requested community", 409);
    }
    pending.account = pending.challenge.account;
    const signed = await identity.signChallenge(pending.challenge);
    pending.publicKey = signed.publicKey;
    pending.signature = signed.signature;
    const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    await rename(temporary, pendingPath);
    result = await submitClaim();
  }
  if (result.account.configuration.id !== pending.configurationTree || result.account.profileTree !== pending.profileTree) {
    throw new ProtocolError("conflict", "Claimed account identity disagrees with the prepared bootstrap", 409);
  }
  const install = async (destination: string, source: string) => {
    const existing = await readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing !== null && existing !== source) throw new ProtocolError("conflict", `Bootstrap will not overwrite ${destination}`, 409);
    if (existing === null) await writeFile(destination, source, { mode: 0o600, flag: "wx" });
  };
  const accountPath = join(arborDataRoot(), "accounts", pending.configurationTree);
  await mkdir(accountPath, { recursive: true, mode: 0o700 });
  for (const [name, source] of Object.entries(pending.files)) {
    if (name !== "placements") await install(join(accountPath, name), source);
  }
  const placementsPath = join(arborDataRoot(), "placements.yaml");
  if (!await stat(placementsPath).then(() => true).catch(() => false)) {
    await install(placementsPath, pending.files.placements ?? "{}\n");
  }
  await saveCurrentAccountDeviceID(pending.configurationTree, pending.deviceID);

  await new HostAccountStore(pending.configurationTree).set(credential, {
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
  // The claim declared the profile tree; its first snapshot activates it at
  // the community's /~handle. A later retry can do the same.
  const hosted = new ProtocolClient(origin, credential);
  await hosted.submitUpdate(pending.profileTree, null, await resolveSnapshot(await snapshotDirectory(path)))
    .catch((error: unknown) => console.warn(`The profile ${pending.profileTree} was claimed but not yet activated: ${error instanceof Error ? error.message : String(error)}`));
  await deps.trees.refreshConfiguration();
  return [
    { kind: "created", ref: { tree: result.configuration.id, path: "/access.yaml", stableKey: null } },
    { kind: "created", ref: { tree: result.configuration.id, path: "/devices.yaml", stableKey: null } },
  ];
}

/**
 * Claim one Canopy-chosen account locator for an already identified local
 * profile tree. This does not declare or upload the profile tree.
 */
export async function claimHostAccountBootstrap(
  deps: AccountBootstrapDeps,
  accountLocator: string,
  inputPath: string,
  displayName?: string,
  inviteCode?: string,
): Promise<MutationReceipt["effects"]> {
  return withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"),
    () => claimAccountProfileBootstrap(deps, accountLocator, inputPath, displayName, inviteCode));
}

/** Only preparations which have never been submitted can be abandoned. */
export async function cancelPendingAccountClaim(): Promise<void> {
  await withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    const path = join(arborPrivateRoot(), "bootstrap-account-claim.json");
    let pending: PendingAccountClaimBootstrap;
    try { pending = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (pending.version !== 3 || pending.stage !== "prepared") {
      throw new ProtocolError("conflict", "This connection may already have reached the community. Resume it to preserve its device credential.", 409);
    }
    // Prepared claims never install checkouts. Refuse unexpected state rather
    // than remove anything another operation might have adopted.
    const checkout = join(arborDataRoot(), "accounts", pending.configurationTree);
    if (await stat(checkout).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false; throw error;
    }) || await new HostAccountStore(pending.configurationTree).safe()) {
      throw new ProtocolError("conflict", "This preparation already has local account state; resume it instead", 409);
    }
    await new HostAccountStore(pending.configurationTree).remove();
    await rm(path);
  });
}
