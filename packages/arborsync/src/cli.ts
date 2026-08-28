#!/usr/bin/env bun
import { resolve } from "node:path";
import { serveArborSync, serveArborSyncControl } from "./index.ts";

function usage(): never {
  console.error(`Usage:
  arborsync [workspace] [--port <number>]
  arborsync --control [--port <number>]`);
  process.exit(2);
}

export async function runArborSyncDaemon(args = process.argv.slice(2)): Promise<void> {
  const control = args.includes("--control");
  const portIndex = args.indexOf("--port");
  const portValue = portIndex >= 0 ? args[portIndex + 1] : undefined;
  if (portIndex >= 0 && (!portValue || portValue.startsWith("--"))) throw new Error("--port requires a number");
  const port = Number(portValue ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Arbor Sync port must be an integer from 0 through 65535");
  const positionals = args.filter((arg, index) => !arg.startsWith("--") && index !== portIndex + 1);
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--control" && arg !== "--port");
  if (unknown.length || positionals.length > 1 || (control && positionals.length)) usage();

  const running = control
    ? await serveArborSyncControl({ port })
    : await serveArborSync(resolve(positionals[0] ?? "."), { port });
  if (running.mode === "workspace") console.log(`Arbor Sync is serving ${running.start} at ${running.url}`);
  else console.log(`Arbor Sync control service is listening at ${running.url}`);
  const shutdown = async () => {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  runArborSyncDaemon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
