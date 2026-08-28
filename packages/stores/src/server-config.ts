import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@arbor/core";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.community-account";

export function communityCredentialName(dataRoot = arborDataRoot()): string {
  return `active-${sha256(dataRoot).slice(0, 16)}`;
}

function credentialLocation(reference: string): { service: string; name: string } | null {
  const separator = reference.lastIndexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return { service: reference.slice(0, separator), name: reference.slice(separator + 1) };
}

export interface CommunityAccountMetadata {
  id: string;
  handle: string;
  profileTree: string | null;
  profileURL: string | null;
  communityTree: string;
  communityURL: string;
  configurationTree: string;
  configurationRef?: string;
  configurationUpdate?: string;
}

export interface SafeCommunityRecord extends CommunityAccountMetadata {
  origin: string;
  credential: string;
  tokenDigest: string;
  connected: true;
}

export class CommunityConfigStore {
  private path = join(arborPrivateRoot(), "system", "community.md");
  private credentialName = communityCredentialName();

  private credentialReference(): string {
    return `${SERVICE}/${this.credentialName}`;
  }

  async storeProvisionalCredential(value: string): Promise<void> {
    if (!value) throw new Error("Device credential must not be empty");
    await Bun.secrets.set({ service: SERVICE, name: this.credentialName, value });
  }

  async provisionalCredential(): Promise<string | null> {
    return Bun.secrets.get({ service: SERVICE, name: this.credentialName }).catch(() => null);
  }

  async set(
    originInput: string,
    accountToken: string,
    metadata: CommunityAccountMetadata,
  ): Promise<SafeCommunityRecord> {
    await prepareArborDataRoot();
    const origin = new URL(originInput).origin;
    if (!accountToken) throw new Error("Account token must not be empty");
    const record: SafeCommunityRecord = {
      ...metadata,
      origin,
      credential: this.credentialReference(),
      tokenDigest: sha256(accountToken),
      connected: true,
    };
    await Bun.secrets.set({ service: SERVICE, name: this.credentialName, value: accountToken });
    await mkdir(join(arborPrivateRoot(), "system"), { recursive: true, mode: 0o700 });
    await writeFile(this.path, [
      "---",
      `origin: ${JSON.stringify(origin)}`,
      `id: ${JSON.stringify(record.id)}`,
      `handle: ${JSON.stringify(record.handle)}`,
      ...(record.profileTree ? [`profileTree: ${JSON.stringify(record.profileTree)}`] : []),
      ...(record.profileURL ? [`profileURL: ${JSON.stringify(record.profileURL)}`] : []),
      `communityTree: ${JSON.stringify(record.communityTree)}`,
      `communityURL: ${JSON.stringify(record.communityURL)}`,
      `configurationTree: ${JSON.stringify(record.configurationTree)}`,
      ...(record.configurationRef ? [`configurationRef: ${JSON.stringify(record.configurationRef)}`] : []),
      ...(record.configurationUpdate ? [`configurationUpdate: ${JSON.stringify(record.configurationUpdate)}`] : []),
      `credential: ${JSON.stringify(record.credential)}`,
      `tokenDigest: ${JSON.stringify(record.tokenDigest)}`,
      "connected: true",
      "---",
      "",
      "# Community account",
      "",
      "The account credential is stored in the operating-system credential store.",
      "",
    ].join("\n"), { mode: 0o600 });
    return record;
  }

  async safe(): Promise<SafeCommunityRecord | null> {
    try {
      const source = await readFile(this.path, "utf8");
      const value = (key: string) => source.match(new RegExp(`^${key}:\\s+"([^"]+)"`, "m"))?.[1];
      const origin = value("origin");
      const id = value("id");
      const handle = value("handle");
      const communityTree = value("communityTree");
      const communityURL = value("communityURL");
      const configurationTree = value("configurationTree");
      const credential = value("credential");
      const tokenDigest = value("tokenDigest");
      if (!origin || !id || !handle || !communityTree || !communityURL || !configurationTree || !credential || !tokenDigest) return null;
      return {
        origin,
        id,
        handle,
        profileTree: value("profileTree") ?? null,
        profileURL: value("profileURL") ?? null,
        communityTree,
        communityURL,
        configurationTree,
        ...(value("configurationRef") ? { configurationRef: value("configurationRef") } : {}),
        ...(value("configurationUpdate") ? { configurationUpdate: value("configurationUpdate") } : {}),
        credential,
        tokenDigest,
        connected: true,
      };
    } catch {
      return null;
    }
  }

  async get(): Promise<{ record: SafeCommunityRecord; accountToken: string } | null> {
    const record = await this.safe();
    if (!record) return null;
    const location = credentialLocation(record.credential);
    if (!location) return null;
    const accountToken = await Bun.secrets.get(location).catch(() => null);
    if (!accountToken || sha256(accountToken) !== record.tokenDigest) return null;
    if (record.credential === this.credentialReference()) return { record, accountToken };

    // Older Arbor versions used one process-wide credential name. Migrate a
    // still-valid legacy reference into this data home's isolated slot.
    try {
      const migrated = await this.set(record.origin, accountToken, {
        id: record.id,
        handle: record.handle,
        profileTree: record.profileTree,
        profileURL: record.profileURL,
        communityTree: record.communityTree,
        communityURL: record.communityURL,
        configurationTree: record.configurationTree,
        ...(record.configurationRef ? { configurationRef: record.configurationRef } : {}),
        ...(record.configurationUpdate ? { configurationUpdate: record.configurationUpdate } : {}),
      });
      return { record: migrated, accountToken };
    } catch {
      // The referenced credential is still usable even if its opportunistic
      // migration could not be persisted during this read.
      return { record, accountToken };
    }
  }

  async status(): Promise<{ record: SafeCommunityRecord; credentialAvailable: boolean } | null> {
    const configured = await this.get();
    if (configured) return { record: configured.record, credentialAvailable: true };
    const record = await this.safe();
    return record ? { record, credentialAvailable: false } : null;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    const location = record ? credentialLocation(record.credential) : null;
    await Bun.secrets.delete(location ?? { service: SERVICE, name: this.credentialName });
    await rm(this.path, { force: true });
  }

}
