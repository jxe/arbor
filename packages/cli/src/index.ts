#!/usr/bin/env bun
import { resolve } from "node:path";
import { serveArbor } from "@arbor/arbord";
import { ConnectionStore } from "@arbor/stores";

function usage(): never {
  console.error(`Usage:
  arbor dev <path> [--port <number>] [--no-open]
  arbor connection set <name> [--dsn-stdin]
  arbor connection test <name>
  arbor connection remove <name>`);
  process.exit(2);
}

async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  return (prompt(promptText) ?? "").trim();
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "dev") {
    const path = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4317;
    const { service, workspace, server, start, url } = await serveArbor(resolve(path), { port });
    const scope = workspace.tracking === "tracked"
      ? `tracked root "${workspace.descriptor().name}"`
      : "untracked — session only";
    console.log(`Arbor is browsing ${start} (${scope})`);
    console.log(url);
    if (!args.includes("--no-open")) await openBrowser(`${url}/render${start}`);
    const shutdown = async () => {
      server.stop(true);
      await service[Symbol.asyncDispose]();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  if (command === "connection") {
    const [action, name] = args;
    if (!name) usage();
    const store = new ConnectionStore();
    if (action === "set") {
      const dsn = await readSecret("PostgreSQL DSN: ");
      if (!dsn) throw new Error("No DSN supplied");
      const record = await store.set(name, dsn);
      console.log(`Stored ${record.name} (${record.host}/${record.database}) in the system credential store.`);
      return;
    }
    if (action === "test") {
      const connection = await store.get(name);
      if (!connection) throw new Error(`Connection ${name} is not configured`);
      const sql = new Bun.SQL(connection.dsn);
      try { await sql`select 1 as ok`; console.log(`Connection ${name} succeeded.`); }
      finally { await sql.close(); }
      return;
    }
    if (action === "remove") {
      await store.remove(name);
      console.log(`Removed connection ${name}.`);
      return;
    }
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
