import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../index.ts";
import { ProtocolHTTPError } from "../transport.ts";
import { deviceKeyFromSeed, generateDeviceKeySeed, openDeviceSession } from "./device-key.ts";
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
  /** Where the secret lives: the bearer credential, or for a key device its private key. */
  credential: string;
  tokenDigest: string;
  /** A key device's `devices.yaml` key; absent for a digest device. */
  deviceKey?: string;
  configurationRef?: string;
  configurationUpdate?: string;
  connected: true;
}

/** A session within this long of expiring is replaced before it is handed out. */
const SESSION_MARGIN_MS = 5 * 60_000;
/** How often a digest device with a prepared key asks whether the host lists it yet. */
const ADOPTION_RETRY_MS = 60_000;
const sessions = new Map<string, { token: string; expiresAt: number }>();
const adoptionAttempts = new Map<string, number>();

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

  /** Durable pre-network slot used while an exact account claim is pending. */
  async storeProvisionalCredential(value: string): Promise<void> {
    if (!value) throw new Error("Account credential must not be empty");
    if (this.usesFileCredentials) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.credentialPath, value, { mode: 0o600 });
    } else {
      await Bun.secrets.set({ ...this.credentialLocation(), value });
    }
  }

  async provisionalCredential(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.credentialPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.credentialLocation()).catch(() => null);
  }

  async set(accountToken: string, metadata: Omit<HostAccountRecord, "configurationTree" | "credential" | "tokenDigest" | "connected" | "deviceKey">): Promise<HostAccountRecord> {
    await prepareArborDataRoot();
    if (!accountToken) throw new Error("Account credential must not be empty");
    const location = this.credentialLocation();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.usesFileCredentials) await writeFile(this.credentialPath, accountToken, { mode: 0o600 });
    else await Bun.secrets.set({ ...location, value: accountToken });
    return this.writeRecord({
      ...metadata,
      origin: new URL(metadata.origin).origin,
      configurationTree: this.configurationTree,
      credential: this.usesFileCredentials ? "file:credential" : `${location.service}/${location.name}`,
      tokenDigest: sha256(accountToken),
      connected: true,
    });
  }

  /**
   * This installation's device key for the account, created on first use and
   * kept in the key slot. Until the host lists it (`adoptDeviceKey`), the
   * device keeps authenticating with its credential.
   */
  async prepareDeviceKey(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.readKeySeed();
    if (existing) return deviceKeyFromSeed(existing);
    const seed = generateDeviceKeySeed();
    if (this.usesFileCredentials) await writeFile(this.keyPath, seed, { mode: 0o600, flag: "wx" });
    else await Bun.secrets.set({ ...this.keyLocation(), value: seed });
    if (await this.readKeySeed() !== seed) throw new Error("Device key could not be verified after saving");
    return deviceKeyFromSeed(seed);
  }

  /**
   * Become a key device once the host lists the prepared key: the record then
   * names the key slot, and the credential the host no longer accepts is
   * deleted.
   */
  async adoptDeviceKey(): Promise<HostAccountRecord> {
    const record = await this.safe();
    if (!record) throw new Error(`No account connection for ${this.configurationTree}`);
    if (record.deviceKey) return record;
    const seed = await this.readKeySeed();
    if (!seed) throw new Error("No device key has been prepared for this account");
    const key = this.keyLocation();
    const adopted = await this.writeRecord({
      ...record,
      credential: this.usesFileCredentials ? "file:device-key" : `${key.service}/${key.name}`,
      tokenDigest: sha256(seed),
      deviceKey: deviceKeyFromSeed(seed),
    });
    if (record.credential === "file:credential") await rm(this.credentialPath, { force: true });
    else {
      const location = credentialLocation(record.credential);
      if (location) await Bun.secrets.delete(location).catch(() => {});
    }
    return adopted;
  }

  /** Connect as a key device with a new seed, as pairing with a key does. */
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
   * The connection and the bearer token its requests send: a digest device's
   * credential, or a session its key opens, reused until close to expiry. A
   * digest device with a prepared key adopts it as soon as the host lists it.
   */
  async get(): Promise<{ record: HostAccountRecord; accountToken: string } | null> {
    const record = await this.safe();
    if (!record) return null;
    const secret = await this.readSecret(record.credential);
    if (!secret || sha256(secret) !== record.tokenDigest) return null;
    if (!record.deviceKey) {
      const adopted = await this.adoptIfListed(record);
      return adopted ? this.get() : { record, accountToken: secret };
    }
    return { record, accountToken: await this.session(record, secret) };
  }

  /**
   * After the host refused this device: forget its session so the next `get`
   * opens another, or for a digest device with a prepared key, ask again at
   * once whether the host lists it.
   */
  async forgetSession(): Promise<void> {
    sessions.delete(this.configurationTree);
    adoptionAttempts.delete(this.configurationTree);
    await rm(this.sessionPath, { force: true });
  }

  private async session(record: HostAccountRecord, seed: string): Promise<string> {
    const usable = (value?: { token: string; expiresAt: number }) => value && value.expiresAt - SESSION_MARGIN_MS > Date.now() ? value : undefined;
    let cached = usable(sessions.get(this.configurationTree));
    if (!cached) {
      try {
        const saved = JSON.parse(await readFile(this.sessionPath, "utf8")) as { device?: string; token?: string; expiresAt?: number };
        if (saved.device === record.deviceID && typeof saved.token === "string" && typeof saved.expiresAt === "number") cached = usable({ token: saved.token, expiresAt: saved.expiresAt });
      } catch {}
    }
    if (cached) {
      sessions.set(this.configurationTree, cached);
      return cached.token;
    }
    const opened = await openDeviceSession(record.origin, record.profileTree, record.deviceID, seed);
    const value = { token: opened.token, expiresAt: opened.expiresAt };
    sessions.set(this.configurationTree, value);
    const temporary = `${this.sessionPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ device: record.deviceID, ...value }), { mode: 0o600 });
    await rename(temporary, this.sessionPath);
    return value.token;
  }

  private async adoptIfListed(record: HostAccountRecord): Promise<boolean> {
    const last = adoptionAttempts.get(this.configurationTree) ?? 0;
    if (Date.now() - last < ADOPTION_RETRY_MS) return false;
    const seed = await this.readKeySeed();
    if (!seed) return false;
    adoptionAttempts.set(this.configurationTree, Date.now());
    try {
      await this.session({ ...record, deviceKey: deviceKeyFromSeed(seed) }, seed);
    } catch (error) {
      // Not listed yet, or the host is out of reach: keep the credential.
      if (error instanceof ProtocolHTTPError || error instanceof TypeError) return false;
      throw error;
    }
    await this.adoptDeviceKey();
    return true;
  }

  private async readSecret(reference: string): Promise<string | null> {
    if (reference === "file:credential") return readFile(this.credentialPath, "utf8").catch(() => null);
    if (reference === "file:device-key") return readFile(this.keyPath, "utf8").catch(() => null);
    const location = credentialLocation(reference);
    if (!location) return null;
    return Bun.secrets.get(location).catch(() => null);
  }

  /** Whether this installation holds a key for the account, adopted or prepared. */
  async hasDeviceKey(): Promise<boolean> {
    return (await this.readKeySeed()) !== null;
  }

  private async readKeySeed(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.keyPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.keyLocation()).catch(() => null);
  }

  private async writeRecord(record: HostAccountRecord): Promise<HostAccountRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return record;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    if (record?.credential === "file:credential" || record?.credential === "file:device-key" || this.usesFileCredentials) {
      await rm(this.credentialPath, { force: true });
      await rm(this.keyPath, { force: true });
    } else {
      await Bun.secrets.delete(record ? credentialLocation(record.credential) ?? this.credentialLocation() : this.credentialLocation());
      await Bun.secrets.delete(this.credentialLocation()).catch(() => {});
      await Bun.secrets.delete(this.keyLocation()).catch(() => {});
    }
    await this.forgetSession();
    await rm(this.path, { force: true });
  }

  static async list(): Promise<HostAccountRecord[]> {
    let names: string[];
    try { names = await readdir(join(arborPrivateRoot(), "accounts")); }
    catch { return []; }
    const records = await Promise.all(names.filter((name) => /^tr_[a-z2-7]+$/.test(name)).map((name) => new HostAccountStore(name).safe()));
    return records.filter((record): record is HostAccountRecord => record !== null).sort((a, b) => a.configurationTree.localeCompare(b.configurationTree));
  }
}
