import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountCheckoutPath, arborPrivateRoot, deviceKeyFromSeed, generateDeviceKeySeed, HostAccountStore, generateArborID,
  openDeviceSession, ProtocolError, saveCurrentAccountDeviceID, sha256, ProtocolClient } from "@overstory/protocol";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { withLocalStateLock, ProfileIdentityStore } from "@overstory/arborsync/state";
import type { AccountBootstrapDeps } from "./ports.ts";

export interface LocalPairingPayload {
  version: 1;
  origin: string;
  pairing: { id: string; secret: string };
}
interface PendingPairing {
  version: 1;
  origin: string;
  pairingID: string;
  credentialSlot: string;
}
/** A device pairs with a key; a pairing saved before keys resumes with its credential. */
type PairingSecrets =
  | { payload: LocalPairingPayload; device: { id: string; label: string; key: string }; seed: string }
  | { payload: LocalPairingPayload; device: { id: string; label: string; credentialDigest: `sha256:${string}` }; credential: string };
const pendingPath = () => join(arborPrivateRoot(), "bootstrap-pairing.json");
async function readPending(): Promise<PendingPairing | null> {
  try {
    const value = JSON.parse(await readFile(pendingPath(), "utf8"));
    if (value.version !== 1 || typeof value.origin !== "string" || typeof value.pairingID !== "string"
      || typeof value.credentialSlot !== "string") throw new Error("Malformed pending pairing");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function pendingLocalPairing(): Promise<{ origin: string } | null> {
  const pending = await readPending();
  return pending ? { origin: pending.origin } : null;
}
function validatePayload(input: unknown): LocalPairingPayload {
  const value = input as LocalPairingPayload | null;
  if (!value || value.version !== 1 || typeof value.origin !== "string" || !value.pairing
    || typeof value.pairing.id !== "string" || !value.pairing.id || typeof value.pairing.secret !== "string" || !value.pairing.secret) {
    throw new ProtocolError("invalid-request", "Malformed pairing code", 400);
  }
  const url = new URL(value.origin);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ProtocolError("invalid-request", "Pairing requires a canonical HTTPS community origin", 400);
  }
  return { version: 1, origin: url.origin, pairing: { id: value.pairing.id, secret: value.pairing.secret } };
}

/** Pair an already claimed account into the same account store used by Arbor Sync. */
export async function claimLocalPairing(deps: AccountBootstrapDeps, input?: unknown): Promise<void> {
  await withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    const identity = await new ProfileIdentityStore().status();
    if (!identity) throw new ProtocolError("conflict", "Recover your identity before pairing this Mac", 409);
    let pending = await readPending();
    const payload = input === undefined ? undefined : validatePayload(input);
    let secrets: PairingSecrets;
    if (pending) {
      const source = await new HostAccountStore(pending.credentialSlot).provisionalCredential();
      if (!source) throw new ProtocolError("credential-unavailable", "Unlock the credential store to resume this pairing", 409);
      secrets = JSON.parse(source);
      const matches = "seed" in secrets
        ? "key" in secrets.device && deviceKeyFromSeed(secrets.seed) === secrets.device.key
        : "credentialDigest" in secrets.device && `sha256:${sha256(secrets.credential)}` === secrets.device.credentialDigest;
      if (secrets.payload.origin !== pending.origin || secrets.payload.pairing.id !== pending.pairingID || !matches) {
        throw new ProtocolError("conflict", "Pending pairing does not match its saved credential", 409);
      }
      if (payload && JSON.stringify(payload) !== JSON.stringify(secrets.payload)) {
        throw new ProtocolError("conflict", "Resume the existing pairing before using another code", 409);
      }
    } else {
      if (!payload) throw new ProtocolError("invalid-request", "Paste a pairing code from an authorized device", 400);
      const seed = generateDeviceKeySeed();
      secrets = { payload, seed, device: { id: generateArborID("dv"), label: hostname() || "Canopy Mac", key: deviceKeyFromSeed(seed) } };
      pending = { version: 1, origin: payload.origin, pairingID: payload.pairing.id, credentialSlot: generateArborID("tr") };
      const store = new HostAccountStore(pending.credentialSlot);
      const source = JSON.stringify(secrets);
      await store.storeProvisionalCredential(source);
      if (await store.provisionalCredential() !== source) throw new Error("Pairing credential could not be verified after saving");
      const temporary = `${pendingPath()}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(pending), { mode: 0o600 });
      await rename(temporary, pendingPath());
    }
    // Persisted before the first request. Replays retain the same secret,
    // device and credential even if the host accepted a lost response.
    await new ProtocolClient(pending.origin).claimPairing(pending.pairingID, secrets.payload.pairing.secret, secrets.device);
    await connectDevice(pending.origin, identity.profileTree, secrets.device.id,
      "seed" in secrets ? { seed: secrets.seed } : { credential: secrets.credential }, "The paired account does not belong to this Mac’s profile identity and community");
    await deps.trees.refreshConfiguration();
    // Remove the journal first: a crash may leave an unused secret, never a
    // resumable journal whose exact credential has already been deleted.
    await rm(pendingPath());
    await new HostAccountStore(pending.credentialSlot).remove();
  });
}

/**
 * Connect this installation as `device` of `profileTree` at `origin`, once
 * the host lists it: check the account is that profile's at that community,
 * install its configuration as the account checkout (or confirm the one
 * already there), and store the connection. Shared by pairing and by a
 * completed profile reset.
 */
export async function connectDevice(
  origin: string,
  profileTree: string,
  device: string,
  secret: { seed: string } | { credential: string },
  mismatch: string,
): Promise<void> {
  const token = "seed" in secret ? (await openDeviceSession(origin, profileTree, device, secret.seed)).token : secret.credential;
  const wire = new ProtocolClient(origin, token);
  const { account } = await wire.account();
  if (account.device?.id !== device || account.profileTree !== profileTree
    || !account.community.canonical?.endpoint || new URL(account.community.canonical.endpoint).origin !== origin) {
    throw new ProtocolError("conflict", mismatch, 409);
  }
  const configuration = (await wire.descriptor(account.configuration.id)).tree;
  const snapshot = await wire.snapshot(configuration.id, configuration.root);
  const checkout = accountCheckoutPath(configuration.id);
  const exists = await stat(checkout).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false; throw error;
  });
  if (exists) {
    const local = await resolveSnapshot(await snapshotDirectory(checkout));
    if (local.root !== snapshot.root) {
      throw new ProtocolError("conflict", "The existing account checkout has different contents. Preserve and reconcile it before connecting this device.", 409);
    }
  } else {
    const staging = join(arborPrivateRoot(), `device-checkout-${crypto.randomUUID()}`);
    try {
      await materializeTree(staging, snapshot.root, async (hash) => {
        const value = snapshot.objects.get(hash);
        if (!value) throw new Error(`Account configuration is missing ${hash}`);
        return value;
      });
      await mkdir(join(checkout, ".."), { recursive: true, mode: 0o700 });
      await rename(staging, checkout);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const connection = {
    origin, account: `${origin}/~${account.handle ?? account.id}`,
    accountID: account.id, ...(account.handle ? { handle: account.handle } : {}), profileTree,
    deviceID: device, configurationRef: configuration.root, configurationUpdate: configuration.update,
  };
  const store = new HostAccountStore(configuration.id);
  if ("seed" in secret) await store.setDeviceKey(secret.seed, connection);
  else await store.set(secret.credential, connection);
  await saveCurrentAccountDeviceID(configuration.id, device);
}
