#!/usr/bin/env bun
import { mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { serveCanopy, type CanopyBootstrapAccount } from "./index.ts";

function usage(): never {
  console.error(`Usage:
  canopyd [data-directory] [--url <canonical-url>] [--port <number>] [--hostname <host>]
          [--community <handle>] [--first-writer <handle>] [--first-writer-profile <TreeID>]`);
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positionals(args: string[], options: string[]): string[] {
  const valued = new Set(options);
  return args.filter((arg, index) => !arg.startsWith("--") && (index === 0 || !valued.has(args[index - 1]!)));
}

function defaultHandle(input: string | undefined, fallback: string): string {
  const normalized = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(normalized) ? normalized : fallback;
}

/**
 * Maintenance mode answers the health check and nothing else, without opening
 * the data root. A host whose volume operations require a running service uses
 * it while the operator migrates or replaces the data root out of band.
 */
export function serveMaintenance(port: number, hostname: string): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 30,
    fetch(request) {
      const { pathname } = new URL(request.url);
      // Railway checks the configured lightweight root path. Keep both health
      // probes live while every application route remains unavailable.
      if (pathname === "/" || pathname === "/.arbor/health") {
        return Response.json({ status: "maintenance" }, { headers: { "cache-control": "no-store" } });
      }
      return Response.json(
        { error: "internal-error", message: "This Arbor server is in maintenance; try again later", retryable: true },
        { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } },
      );
    },
  });
  console.log(`Canopy in maintenance mode at http://${hostname}:${server.port}; migrate the data root or unset ARBOR_CANOPY_MAINTENANCE, then restart.`);
  return server;
}

export async function runCanopyDaemon(args = process.argv.slice(2)): Promise<void> {
  const valuedOptions = ["--url", "--port", "--hostname", "--community", "--first-writer", "--first-writer-profile"];
  const positional = positionals(args, valuedOptions);
  if (positional.length > 1) usage();
  const unknown = args.filter((arg) => arg.startsWith("--") && !valuedOptions.includes(arg));
  if (unknown.length) throw new Error(`Unknown canopyd option: ${unknown[0]}`);

  const requestedPort = Number(option(args, "--port") ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Canopy port must be an integer from 0 through 65535");
  }
  if (process.env.ARBOR_CANOPY_MAINTENANCE?.trim()) {
    const server = serveMaintenance(requestedPort, option(args, "--hostname") ?? "0.0.0.0");
    const stop = () => { server.stop(true); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  const onRailway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const arborDomain = process.env.ARBOR_DOMAIN;
  const configuredPublicOrigin = option(args, "--url") ?? (arborDomain ? `https://${arborDomain}` : undefined);
  if (onRailway && !configuredPublicOrigin && !railwayDomain) {
    throw new Error("Railway needs a public domain before first start. Generate one, set ARBOR_DOMAIN, or pass --url, then redeploy.");
  }
  if (onRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Railway needs a persistent volume attached before start; mount it at /data.");
  }
  const publicOrigin = configuredPublicOrigin
    ?? (railwayDomain ? (/^https?:\/\//.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`) : undefined)
    ?? `http://127.0.0.1:${requestedPort}`;
  const dataRoot = resolve(positional[0] ?? process.env.ARBOR_CANOPY_DATA ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".arbor-canopy");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const existingCanopy = await stat(resolve(dataRoot, "canopy.sqlite3")).then(() => true).catch(() => false);
  const configuredAccounts = process.env.ARBOR_ACCOUNTS_JSON
    ? JSON.parse(process.env.ARBOR_ACCOUNTS_JSON) as CanopyBootstrapAccount[]
    : null;
  const accountToken = process.env.ARBOR_ACCOUNT_TOKEN ?? process.env.ARBOR_OWNER_TOKEN;
  const accounts = configuredAccounts ?? (accountToken ? [{
    handle: process.env.ARBOR_ACCOUNT_HANDLE ?? "owner",
    token: accountToken,
    name: process.env.ARBOR_ACCOUNT_NAME ?? "Owner",
    communityWriter: true,
  }] : []);
  const requestedCommunityHandle = option(args, "--community") ?? process.env.ARBOR_COMMUNITY_HANDLE;
  const requestedFirstWriterHandle = option(args, "--first-writer") ?? process.env.ARBOR_FIRST_WRITER_HANDLE;
  const requestedFirstWriterProfile = option(args, "--first-writer-profile") ?? process.env.ARBOR_FIRST_WRITER_PROFILE;
  if (!existingCanopy && !accounts.length && !process.stdin.isTTY) {
    if (!requestedCommunityHandle) throw new Error("A new unattended community requires --community <handle>");
    if (!requestedFirstWriterHandle) throw new Error("A new unattended community requires --first-writer <handle>");
    if (!requestedFirstWriterProfile) throw new Error("A new unattended community requires --first-writer-profile <TreeID>");
  }
  const communityHandle = defaultHandle(requestedCommunityHandle ?? basename(dataRoot), "community");
  const firstWriterHandle = !existingCanopy && !accounts.length
    ? defaultHandle(requestedFirstWriterHandle ?? process.env.USER, "owner")
    : undefined;
  if (firstWriterHandle && !requestedFirstWriterProfile) {
    throw new Error("A new claim-first community requires --first-writer-profile <TreeID>");
  }
  if (firstWriterHandle && new URL(publicOrigin).port === "0") {
    throw new Error("A new claim-first community needs a stable nonzero --port or explicit --url");
  }

  let running: Awaited<ReturnType<typeof serveCanopy>>;
  try {
    running = await serveCanopy({
      dataRoot,
      publicOrigin,
      community: {
        handle: communityHandle,
        name: communityHandle,
        ...(firstWriterHandle ? { firstWriter: { handle: firstWriterHandle, profileTree: requestedFirstWriterProfile! } } : {}),
      },
      accounts,
      port: requestedPort,
      hostname: option(args, "--hostname") ?? "0.0.0.0",
    });
  } catch (error) {
    // A data root written by another schema version is not served and not
    // touched; the process stays up in maintenance mode so an operator can run
    // the migration in place, then restart.
    if (error instanceof Error && /schema version/.test(error.message)) {
      console.error(error.message);
      const server = serveMaintenance(requestedPort, option(args, "--hostname") ?? "0.0.0.0");
      const stop = () => { server.stop(true); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    throw error;
  }
  const resetAccount = process.env.ARBOR_RESET_ACCOUNT?.trim();
  if (resetAccount) {
    if (!accountToken) throw new Error("ARBOR_RESET_ACCOUNT requires ARBOR_ACCOUNT_TOKEN");
    running.canopy.resetAccountToken(resetAccount, accountToken);
    console.log(`Reset the device credential for ~${resetAccount}; remove ARBOR_RESET_ACCOUNT after recovery.`);
  }
  console.log(`${existingCanopy ? "Serving" : "Created"} ${running.canopy.communityHandle()} at ${running.url}`);
  console.log(`Data: ${dataRoot}`);
  if (firstWriterHandle) {
    console.log(`First writer profile: ${running.url}/~${firstWriterHandle}`);
    console.log("Open Arbor locally and claim this address from the profile control.");
  }
  const shutdown = async () => {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  runCanopyDaemon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
