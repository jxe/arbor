import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../index.ts";
import { deviceKeyFromSeed, openDeviceSession } from "./device-key.ts";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.community-account";

export function accountCredentialName(configurationTree: string, dataRoot = arborDataRoot()): string {
  return `account-${sha256(`${dataRoot}\0${configurationTree}`).slice(0, 24)}`;
}

function credentialLocation(reference: string): { service: string; name: string } | null {
  const separator = reference.lastIndexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return { service: reference.slice(0, separator), name: reference.slice(separator + 1) };
}

export interface HostAccountRecord {
  configurationTree: string;
  origin: string;
  account: string;
  accountID: string;
  /** Optional Canopy-specific presentation hint; never account identity. */
  handle?: string;
  profileTree: string;
  deviceID: string;
  /** Where the device key's seed lives: `file:device-key` or a credential-store slot. */
  credential: string;
  /** SHA-256 of the seed, to confirm the slot still holds this device's key. */
  tokenDigest: string;
  /** The device's `devices.yaml` key. */
  deviceKey: string;
  configurationRef?: string;
  configurationUpdate?: string;
  connected: true;
}

/** A session within this long of expiring is replaced before it is handed out. */
const SESSION_MARGIN_MS = 5 * 60_000;
/** Keyed by the account's private directory: one data home, one account. */
const sessions = new Map<string, { token: string; expiresAt: number }>();
/** Session opens in flight, so concurrent callers share one challenge and one session. */
const sessionOpens = new Map<string, Promise<{ token: string; expiresAt: number }>>();
/**
 * Each account's record and secret as last read, so a request does not reread
 * the connection file and the keychain. Writes through this store replace it;
 * another process's edits show within a minute, or at once after a refusal.
 */
const CREDENTIAL_READ_TTL_MS = 60_000;
const credentialReads = new Map<string, { record: HostAccountRecord; secret: string | null; readAt: number }>();

/** Private connection metadata and credential lookup for one configuration TreeID. */
export class HostAccountStore {
  constructor(readonly configurationTree: string) {
    if (!/^tr_[a-z2-7]+$/.test(configurationTree)) throw new Error("Account store requires a configuration TreeID");
  }

  private get directory(): string {
    return join(arborPrivateRoot(), "accounts", this.configurationTree);
  }

  private get path(): string {
    return join(this.directory, "connection.json");
  }

  private credentialLocation(): { service: string; name: string } {
    return { service: SERVICE, name: accountCredentialName(this.configurationTree) };
  }

  private keyLocation(): { service: string; name: string } {
    return { service: SERVICE, name: `${accountCredentialName(this.configurationTree)}-key` };
  }

  private get credentialPath(): string {
    return join(this.directory, "credential");
  }

  private get keyPath(): string {
    return join(this.directory, "device-key");
  }

  private get sessionPath(): string {
    return join(this.directory, "session.json");
  }

  private get usesFileCredentials(): boolean {
    return process.env.ARBOR_CREDENTIAL_STORE === "file";
  }

  /** Durable pre-network slot for a new device's key seed while a claim or pairing is pending. */
  async storeProvisionalCredential(value: string): Promise<void> {
    if (!value) throw new Error("Account credential must not be empty");
    if (this.usesFileCredentials) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.credentialPath, value, { mode: 0o600 });
    } else {
      await Bun.secrets.set({ ...this.credentialLocation(), value });
    }
  }

  /** Empty the pre-network slot once a claim has installed the device's key instead. */
  async clearProvisionalCredential(): Promise<void> {
    if (this.usesFileCredentials) await rm(this.credentialPath, { force: true });
    else await Bun.secrets.delete(this.credentialLocation()).catch(() => {});
  }

  async provisionalCredential(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.credentialPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.credentialLocation()).catch(() => null);
  }

  /** Connect as a key device with its seed, as claiming and pairing do. */
  async setDeviceKey(seed: string, metadata: Omit<HostAccountRecord, "configurationTree" | "credential" | "tokenDigest" | "connected" | "deviceKey">): Promise<HostAccountRecord> {
    await prepareArborDataRoot();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.usesFileCredentials) await writeFile(this.keyPath, seed, { mode: 0o600 });
    else await Bun.secrets.set({ ...this.keyLocation(), value: seed });
    const key = this.keyLocation();
    return this.writeRecord({
      ...metadata,
      origin: new URL(metadata.origin).origin,
      configurationTree: this.configurationTree,
      credential: this.usesFileCredentials ? "file:device-key" : `${key.service}/${key.name}`,
      tokenDigest: sha256(seed),
      deviceKey: deviceKeyFromSeed(seed),
      connected: true,
    });
  }

  async safe(): Promise<HostAccountRecord | null> {
    try {
      const decoded = JSON.parse(await readFile(this.path, "utf8")) as HostAccountRecord & { account?: string };
      // Removable compatibility adapter for early Interface 005 records.
      if (!decoded.account && !decoded.handle) return null;
      const record: HostAccountRecord = decoded.account
        ? decoded
        : { ...decoded, account: `${decoded.origin}/~${decoded.handle!}` };
      if (
        record.configurationTree !== this.configurationTree
        || new URL(record.origin).origin !== record.origin
        || new URL(record.account).origin !== record.origin
        || !record.accountID || !record.profileTree || !record.deviceID
        || !record.credential || !record.tokenDigest || record.connected !== true
      ) return null;
      return record;
    } catch { return null; }
  }

  /**
   * The connection and the bearer token its requests send: a session its key
   * opens, reused until close to expiry.
   */
  async get(): Promise<{ record: HostAccountRecord; accountToken: string } | null> {
    let read = credentialReads.get(this.directory);
    if (!read || Date.now() - read.readAt > CREDENTIAL_READ_TTL_MS) {
      const record = await this.safe();
      if (!record) { credentialReads.delete(this.directory); return null; }
      read = { record, secret: await this.readSecret(record.credential), readAt: Date.now() };
      credentialReads.set(this.directory, read);
    }
    const { record, secret } = read;
    if (!record.deviceKey || !secret || sha256(secret) !== record.tokenDigest) return null;
    return { record, accountToken: await this.session(record, secret) };
  }

  /** After the host refused this device: forget its session so the next `get` opens another. */
  async forgetSession(): Promise<void> {
    sessions.delete(this.directory);
    credentialReads.delete(this.directory);
    await rm(this.sessionPath, { force: true });
  }

  private async session(record: HostAccountRecord, seed: string): Promise<string> {
    const usable = (value?: { token: string; expiresAt: number }) => value && value.expiresAt - SESSION_MARGIN_MS > Date.now() ? value : undefined;
    let cached = usable(sessions.get(this.directory));
    if (!cached) {
      try {
        const saved = JSON.parse(await readFile(this.sessionPath, "utf8")) as { device?: string; token?: string; expiresAt?: number };
        if (saved.device === record.deviceID && typeof saved.token === "string" && typeof saved.expiresAt === "number") cached = usable({ token: saved.token, expiresAt: saved.expiresAt });
      } catch {}
    }
    if (cached) {
      sessions.set(this.directory, cached);
      return cached.token;
    }
    let opening = sessionOpens.get(this.directory);
    if (!opening) {
      opening = (async () => {
        const opened = await openDeviceSession(record.origin, record.profileTree, record.deviceID, seed);
        const value = { token: opened.token, expiresAt: opened.expiresAt };
        sessions.set(this.directory, value);
        const temporary = `${this.sessionPath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ device: record.deviceID, ...value }), { mode: 0o600 });
        await rename(temporary, this.sessionPath);
        return value;
      })().finally(() => sessionOpens.delete(this.directory));
      sessionOpens.set(this.directory, opening);
    }
    return (await opening).token;
  }

  private async readSecret(reference: string): Promise<string | null> {
    if (reference === "file:device-key") return readFile(this.keyPath, "utf8").catch(() => null);
    const location = credentialLocation(reference);
    if (!location) return null;
    return Bun.secrets.get(location).catch(() => null);
  }

  /** Whether this installation holds a key for the account. */
  async hasDeviceKey(): Promise<boolean> {
    return (await this.readKeySeed()) !== null;
  }

  private async readKeySeed(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.keyPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.keyLocation()).catch(() => null);
  }

  private async writeRecord(record: HostAccountRecord): Promise<HostAccountRecord> {
    credentialReads.delete(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    credentialReads.delete(this.directory);
    return record;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    if (record?.credential === "file:device-key" || this.usesFileCredentials) {
      await rm(this.credentialPath, { force: true });
      await rm(this.keyPath, { force: true });
    } else {
      await Bun.secrets.delete(record ? credentialLocation(record.credential) ?? this.credentialLocation() : this.credentialLocation());
      await Bun.secrets.delete(this.credentialLocation()).catch(() => {});
      await Bun.secrets.delete(this.keyLocation()).catch(() => {});
    }
    await this.forgetSession();
    await rm(this.path, { force: true });
    credentialReads.delete(this.directory);
  }

  static async list(): Promise<HostAccountRecord[]> {
    let names: string[];
    try { names = await readdir(join(arborPrivateRoot(), "accounts")); }
    catch { return []; }
    const records = await Promise.all(names.filter((name) => /^tr_[a-z2-7]+$/.test(name)).map((name) => new HostAccountStore(name).safe()));
    return records.filter((record): record is HostAccountRecord => record !== null).sort((a, b) => a.configurationTree.localeCompare(b.configurationTree));
  }
}
