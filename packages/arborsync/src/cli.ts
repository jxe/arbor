#!/usr/bin/env bun
import { resolve } from "node:path";
import { serveArborSync, serveArborSyncControl } from "./index.ts";

function usage(): never {
  console.error(`Usage:
  arborsync [workspace] [--port <number>] [--runtime-kind <persistent|foreground|cloud>] [--instance-id <id>]
  arborsync --control [--port <number>] [--runtime-kind <persistent|foreground|cloud>] [--instance-id <id>]`);
  process.exit(2);
}

export async function runArborSyncDaemon(args = process.argv.slice(2)): Promise<void> {
  const control = args.includes("--control");
  const portIndex = args.indexOf("--port");
  const portValue = portIndex >= 0 ? args[portIndex + 1] : undefined;
  if (portIndex >= 0 && (!portValue || portValue.startsWith("--"))) throw new Error("--port requires a number");
  const port = Number(portValue ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Arbor Sync port must be an integer from 0 through 65535");
  const kindIndex = args.indexOf("--runtime-kind");
  const runtimeKind = kindIndex >= 0 ? args[kindIndex + 1] : undefined;
  if (kindIndex >= 0 && !["persistent", "foreground", "cloud"].includes(runtimeKind ?? "")) {
    throw new Error("--runtime-kind requires persistent, foreground, or cloud");
  }
  const instanceIndex = args.indexOf("--instance-id");
  const instanceID = instanceIndex >= 0 ? args[instanceIndex + 1] : undefined;
  if (instanceIndex >= 0 && (!instanceID || instanceID.startsWith("--"))) throw new Error("--instance-id requires a value");
  const valueIndexes = new Set([portIndex + 1, kindIndex + 1, instanceIndex + 1].filter((index) => index > 0));
  const positionals = args.filter((arg, index) => !arg.startsWith("--") && !valueIndexes.has(index));
  const known = new Set(["--control", "--port", "--runtime-kind", "--instance-id"]);
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length || positionals.length > 1 || (control && positionals.length)) usage();

  const serverOptions = {
    port,
    ...(runtimeKind ? { runtimeKind: runtimeKind as "persistent" | "foreground" | "cloud" } : {}),
    ...(instanceID ? { instanceID } : {}),
  };
  const running = control
    ? await serveArborSyncControl(serverOptions)
    : await serveArborSync(resolve(positionals[0] ?? "."), serverOptions);
  if (running.mode === "workspace") console.log(`Arbor Sync is serving ${running.start} at ${running.url}`);
  else console.log(`Arbor Sync control service is listening at ${running.url}`);
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (runtimeKind === "cloud") {
      try { await running.service.synchronizeNow(); }
      catch (error) {
        console.error(`Final cloud synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
    }
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
    process.exit(exitCode);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  void running.service.trees.fatalConfiguration.then((error) => {
    console.error(error.message);
    void shutdown(1);
  });
}

if (import.meta.main) {
  runArborSyncDaemon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
