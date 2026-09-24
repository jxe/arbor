import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../index.ts";
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
  credential: string;
  tokenDigest: string;
  configurationRef?: string;
  configurationUpdate?: string;
  connected: true;
}

/** Private connection metadata and credential lookup for one configuration TreeID. */
export class HostAccountStore {
  constructor(readonly configurationTree: string) {
    if (!/^tr_[a-z2-7]+$/.test(configurationTree)) throw new Error("Account store requires a configuration TreeID");
  }

  private get path(): string {
    return join(arborPrivateRoot(), "accounts", this.configurationTree, "connection.json");
  }

  private credentialLocation(): { service: string; name: string } {
    return { service: SERVICE, name: accountCredentialName(this.configurationTree) };
  }

  private get credentialPath(): string {
    return join(arborPrivateRoot(), "accounts", this.configurationTree, "credential");
  }

  private get usesFileCredentials(): boolean {
    return process.env.ARBOR_CREDENTIAL_STORE === "file";
  }

  /** Durable pre-network slot used while an exact account claim is pending. */
  async storeProvisionalCredential(value: string): Promise<void> {
    if (!value) throw new Error("Account credential must not be empty");
    if (this.usesFileCredentials) {
      await mkdir(join(arborPrivateRoot(), "accounts", this.configurationTree), { recursive: true, mode: 0o700 });
      await writeFile(this.credentialPath, value, { mode: 0o600 });
    } else {
      await Bun.secrets.set({ ...this.credentialLocation(), value });
    }
  }

  async provisionalCredential(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.credentialPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.credentialLocation()).catch(() => null);
  }

  async set(accountToken: string, metadata: Omit<HostAccountRecord, "configurationTree" | "credential" | "tokenDigest" | "connected">): Promise<HostAccountRecord> {
    await prepareArborDataRoot();
    if (!accountToken) throw new Error("Account credential must not be empty");
    const origin = new URL(metadata.origin).origin;
    const location = this.credentialLocation();
    const record: HostAccountRecord = {
      ...metadata,
      origin,
      configurationTree: this.configurationTree,
      credential: this.usesFileCredentials ? "file:credential" : `${location.service}/${location.name}`,
      tokenDigest: sha256(accountToken),
      connected: true,
    };
    await mkdir(join(arborPrivateRoot(), "accounts", this.configurationTree), { recursive: true, mode: 0o700 });
    if (this.usesFileCredentials) await writeFile(this.credentialPath, accountToken, { mode: 0o600 });
    else await Bun.secrets.set({ ...location, value: accountToken });
    await writeFile(this.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
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

  async get(): Promise<{ record: HostAccountRecord; accountToken: string } | null> {
    const record = await this.safe();
    if (!record) return null;
    if (record.credential === "file:credential") {
      const accountToken = await readFile(this.credentialPath, "utf8").catch(() => null);
      return accountToken && sha256(accountToken) === record.tokenDigest ? { record, accountToken } : null;
    }
    const location = credentialLocation(record.credential);
    if (!location) return null;
    const accountToken = await Bun.secrets.get(location).catch(() => null);
    return accountToken && sha256(accountToken) === record.tokenDigest ? { record, accountToken } : null;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    if (record?.credential === "file:credential" || this.usesFileCredentials) await rm(this.credentialPath, { force: true });
    else await Bun.secrets.delete(record ? credentialLocation(record.credential) ?? this.credentialLocation() : this.credentialLocation());
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
