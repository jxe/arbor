import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@arbor/core";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.community-account";
const LEGACY_SERVICE = "org.arbor.personal-server";
const LEGACY_NAME = "owner";

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
}

export interface SafeCommunityRecord extends CommunityAccountMetadata {
  origin: string;
  credential: string;
  tokenDigest: string;
  connected: true;
}

export class CommunityConfigStore {
  private path = join(arborDataRoot(), "system", "community.md");
  private legacyPath = join(arborDataRoot(), "system", "server.md");
  private credentialName = communityCredentialName();

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
      credential: `${SERVICE}/${this.credentialName}`,
      tokenDigest: sha256(accountToken),
      connected: true,
    };
    await Bun.secrets.set({ service: SERVICE, name: this.credentialName, value: accountToken });
    await mkdir(join(arborDataRoot(), "system"), { recursive: true, mode: 0o700 });
    await writeFile(this.path, [
      "---",
      `origin: ${JSON.stringify(origin)}`,
      `id: ${JSON.stringify(record.id)}`,
      `handle: ${JSON.stringify(record.handle)}`,
      ...(record.profileTree ? [`profileTree: ${JSON.stringify(record.profileTree)}`] : []),
      ...(record.profileURL ? [`profileURL: ${JSON.stringify(record.profileURL)}`] : []),
      `communityTree: ${JSON.stringify(record.communityTree)}`,
      `communityURL: ${JSON.stringify(record.communityURL)}`,
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
      const credential = value("credential");
      const tokenDigest = value("tokenDigest");
      if (!origin || !id || !handle || !communityTree || !communityURL || !credential || !tokenDigest) return null;
      return {
        origin,
        id,
        handle,
        profileTree: value("profileTree") ?? null,
        profileURL: value("profileURL") ?? null,
        communityTree,
        communityURL,
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
    const accountToken = await Bun.secrets.get(location);
    return accountToken && sha256(accountToken) === record.tokenDigest ? { record, accountToken } : null;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    const location = record ? credentialLocation(record.credential) : null;
    await Bun.secrets.delete(location ?? { service: SERVICE, name: this.credentialName });
    await rm(this.path, { force: true });
  }

  async legacy(): Promise<{ origin: string; accountToken: string } | null> {
    try {
      const source = await readFile(this.legacyPath, "utf8");
      const origin = source.match(/^origin:\s+"([^"]+)"/m)?.[1];
      const accountToken = await Bun.secrets.get({ service: LEGACY_SERVICE, name: LEGACY_NAME });
      return origin && accountToken ? { origin, accountToken } : null;
    } catch {
      return null;
    }
  }

  async finishLegacyMigration(): Promise<void> {
    await Bun.secrets.delete({ service: LEGACY_SERVICE, name: LEGACY_NAME });
    await rm(this.legacyPath, { force: true });
  }
}

/** Transitional source alias for callers that have not yet renamed their field. */
export { CommunityConfigStore as ServerConfigStore };
