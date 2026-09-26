import { hostname } from "node:os";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arborPrivateRoot,
  deviceKeyFromSeed,
  generateArborID,
  generateDeviceKeySeed,
  HostAccountStore,
  ProtocolClient,
  ProtocolError,
  validateProfileResetChallenge,
  type PendingProfileReset,
} from "@overstory/protocol";
import { ProfileIdentityStore, withLocalStateLock } from "@overstory/arborsync/state";
import { connectDevice } from "./account-pairing.ts";
import type { AccountBootstrapDeps } from "./ports.ts";

/**
 * A reset this installation requested with the profile key (accounts §5.3):
 * the new device it will become, and where its key waits. The seed lives in
 * a credential slot named by `slot`, like a pending pairing's.
 */
interface ResetJournal {
  version: 1;
  origin: string;
  profileTree: string;
  device: { id: string; label: string; key: string };
  slot: string;
  requestedAt: number;
  effectiveAt: number;
}

const journalPath = () => join(arborPrivateRoot(), "bootstrap-profile-reset.json");

async function readJournal(): Promise<ResetJournal | null> {
  try {
    const value = JSON.parse(await readFile(journalPath(), "utf8")) as ResetJournal;
    if (value.version !== 1 || typeof value.origin !== "string" || typeof value.slot !== "string" || !value.device?.key) throw new Error("Malformed profile reset journal");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** The reset this installation is waiting to complete, if any. */
export async function pendingLocalProfileReset(): Promise<Omit<ResetJournal, "slot" | "version"> | null> {
  const journal = await readJournal();
  if (!journal) return null;
  const { slot: _slot, version: _version, ...visible } = journal;
  return visible;
}

/**
 * Ask the profile's home host at `origin` to reset its devices to one new
 * administrator device: this installation, with a new key. The reset waits
 * (72 hours at canopyd) and any administrator device may cancel it.
 */
export async function requestProfileReset(originInput: string): Promise<PendingProfileReset> {
  const origin = new URL(originInput).origin;
  return withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    if (await readJournal()) throw new ProtocolError("conflict", "A profile reset is already waiting here; finish it with `arbor me reset --finish`", 409);
    const identity = new ProfileIdentityStore();
    const status = await identity.status();
    if (!status?.keyAvailable) throw new ProtocolError("conflict", "Resetting a profile needs its private key; restore a backup first", 409);
    const seed = generateDeviceKeySeed();
    const device = { id: generateArborID("dv"), label: hostname() || "Canopy device", key: deviceKeyFromSeed(seed) };
    const host = new ProtocolClient(origin);
    const challenge = validateProfileResetChallenge(await host.createProfileResetChallenge({ profileTree: status.profileTree, device }));
    if (challenge.origin !== origin || challenge.profileTree !== status.profileTree || JSON.stringify(challenge.device) !== JSON.stringify(device)) {
      throw new ProtocolError("conflict", "The host's reset challenge does not match the request", 409);
    }
    const signed = await identity.signResetChallenge(challenge);
    // Keep the key before the host can record a reset that names it.
    const slot = generateArborID("tr");
    await new HostAccountStore(slot).storeProvisionalCredential(seed);
    const reset = await host.requestProfileReset({ challenge, ...signed });
    const journal: ResetJournal = {
      version: 1, origin, profileTree: status.profileTree, device, slot,
      requestedAt: reset.requestedAt, effectiveAt: reset.effectiveAt,
    };
    const temporary = `${journalPath()}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
    await rename(temporary, journalPath());
    return reset;
  });
}

/** Drop a waiting reset here, and its unused key, after it was cancelled or will not be finished. */
export async function discardLocalProfileReset(): Promise<boolean> {
  return withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    const journal = await readJournal();
    if (!journal) return false;
    await rm(journalPath());
    await new HostAccountStore(journal.slot).clearProvisionalCredential();
    return true;
  });
}

/** Connect as the reset's new device once it has taken effect. */
export async function finishProfileReset(deps: AccountBootstrapDeps): Promise<void> {
  await withLocalStateLock(join(arborPrivateRoot(), "account-bootstrap-lock.sqlite"), async () => {
    const journal = await readJournal();
    if (!journal) throw new ProtocolError("not-found", "No profile reset is waiting here", 404);
    if (Date.now() < journal.effectiveAt) {
      throw new ProtocolError("conflict", `The reset takes effect at ${new Date(journal.effectiveAt).toISOString()}`, 409);
    }
    const store = new HostAccountStore(journal.slot);
    const seed = await store.provisionalCredential();
    if (!seed || deviceKeyFromSeed(seed) !== journal.device.key) throw new ProtocolError("credential-unavailable", "The reset's device key is unavailable", 409);
    await connectDevice(journal.origin, journal.profileTree, journal.device.id, { seed },
      "The reset account does not belong to this profile identity and community");
    await deps.trees.refreshConfiguration();
    await rm(journalPath());
    await store.clearProvisionalCredential();
  });
}

/** The pending reset of a connected account's profile, as its devices see it. */
export async function pendingAccountProfileReset(configurationTree: string): Promise<PendingProfileReset | null> {
  const connection = await new HostAccountStore(configurationTree).get();
  if (!connection) throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${configurationTree}`, 409);
  return new ProtocolClient(connection.record.origin, connection.accountToken).pendingProfileReset(connection.record.profileTree);
}

/** Cancel a pending reset from an administrator device of the profile. */
export async function cancelAccountProfileReset(configurationTree: string): Promise<void> {
  const connection = await new HostAccountStore(configurationTree).get();
  if (!connection) throw new ProtocolError("credential-unavailable", `Credential unavailable for account ${configurationTree}`, 409);
  await new ProtocolClient(connection.record.origin, connection.accountToken).cancelProfileReset(connection.record.profileTree);
}
