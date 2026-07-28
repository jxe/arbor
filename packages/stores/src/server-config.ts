import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@arbor/core";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.personal-server";
const NAME = "owner";

export interface SafeServerRecord {
  origin: string;
  credential: string;
  tokenDigest: string;
  configured: true;
}

export class ServerConfigStore {
  private path = join(arborDataRoot(), "system", "server.md");

  async set(originInput: string, ownerToken: string): Promise<SafeServerRecord> {
    await prepareArborDataRoot();
    const origin = new URL(originInput).origin;
    if (!ownerToken) throw new Error("Owner token must not be empty");
    const record: SafeServerRecord = {
      origin,
      credential: `${SERVICE}/${NAME}`,
      tokenDigest: sha256(ownerToken),
      configured: true,
    };
    await Bun.secrets.set({ service: SERVICE, name: NAME, value: ownerToken });
    await mkdir(join(arborDataRoot(), "system"), { recursive: true, mode: 0o700 });
    await writeFile(this.path, [
      "---",
      `origin: ${JSON.stringify(origin)}`,
      `credential: ${JSON.stringify(record.credential)}`,
      `tokenDigest: ${JSON.stringify(record.tokenDigest)}`,
      "configured: true",
      "---",
      "",
      "# Personal server",
      "",
      "The owner token is stored in the operating-system credential store.",
      "",
    ].join("\n"), { mode: 0o600 });
    return record;
  }

  async safe(): Promise<SafeServerRecord | null> {
    try {
      const source = await readFile(this.path, "utf8");
      const origin = source.match(/^origin:\s+"([^"]+)"/m)?.[1];
      const credential = source.match(/^credential:\s+"([^"]+)"/m)?.[1];
      const tokenDigest = source.match(/^tokenDigest:\s+"([^"]+)"/m)?.[1];
      if (!origin || !credential || !tokenDigest) return null;
      return { origin, credential, tokenDigest, configured: true };
    } catch {
      return null;
    }
  }

  async get(): Promise<{ record: SafeServerRecord; ownerToken: string } | null> {
    const record = await this.safe();
    if (!record) return null;
    const ownerToken = await Bun.secrets.get({ service: SERVICE, name: NAME });
    return ownerToken ? { record, ownerToken } : null;
  }

  async remove(): Promise<void> {
    await Bun.secrets.delete({ service: SERVICE, name: NAME });
    await rm(this.path, { force: true });
  }
}
