import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { arborDataRoot, prepareArborDataRoot } from "./private-state.ts";

export interface SafeConnectionRecord {
  name: string;
  driver: "postgres";
  host: string;
  port?: number;
  database: string;
  user?: string;
  ssl?: boolean;
  credential: string;
}

const SERVICE = "org.arbor.connections";

export class ConnectionStore {
  private directory = join(arborDataRoot(), "system", "connections");

  private assertName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid connection name: ${name}`);
  }

  async set(name: string, dsn: string): Promise<SafeConnectionRecord> {
    await prepareArborDataRoot();
    this.assertName(name);
    const url = new URL(dsn);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("Connection must be a PostgreSQL URL");
    const record: SafeConnectionRecord = {
      name,
      driver: "postgres",
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      database: url.pathname.replace(/^\//, ""),
      user: url.username ? decodeURIComponent(url.username) : undefined,
      ssl: url.searchParams.get("sslmode") !== "disable",
      credential: `${SERVICE}/${name}`,
    };
    await mkdir(this.directory, { recursive: true });
    await Bun.secrets.set({ service: SERVICE, name, value: dsn });
    const fields = [
      "---",
      "driver: postgres",
      `host: ${JSON.stringify(record.host)}`,
      ...(record.port ? [`port: ${record.port}`] : []),
      `database: ${JSON.stringify(record.database)}`,
      ...(record.user ? [`user: ${JSON.stringify(record.user)}`] : []),
      `ssl: ${record.ssl ? "true" : "false"}`,
      `credential: ${JSON.stringify(record.credential)}`,
      "---",
      "",
      `# ${name}`,
      "",
      "The connection secret is stored in the operating-system credential store.",
      "",
    ];
    await writeFile(join(this.directory, `${name}.md`), fields.join("\n"), { mode: 0o600 });
    return record;
  }

  async get(name: string): Promise<{ record: SafeConnectionRecord; dsn: string } | null> {
    await prepareArborDataRoot();
    this.assertName(name);
    try {
      const source = await readFile(join(this.directory, `${name}.md`), "utf8");
      const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match?.[1]) return null;
      const values = parseDocument(match[1]).toJS() as Omit<SafeConnectionRecord, "name">;
      const dsn = await Bun.secrets.get({ service: SERVICE, name });
      if (!dsn) return null;
      return { record: { name, ...values }, dsn };
    } catch {
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    await prepareArborDataRoot();
    this.assertName(name);
    await Bun.secrets.delete({ service: SERVICE, name });
    await rm(join(this.directory, `${name}.md`), { force: true });
  }
}

export function connectionName(reference: string): string {
  const prefix = "system:connections/";
  if (!reference.startsWith(prefix)) throw new Error(`Expected ${prefix}<name>`);
  return reference.slice(prefix.length);
}
