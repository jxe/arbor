#!/usr/bin/env bun
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CanopyDaemon, serveCanopy, type CanopyBootstrapAccount } from "./index.ts";

const USAGE = `Usage:
  canopyd init <community> --founder <handle>=<TreeID> [--data <directory>]
  canopyd [serve] [<directory>] [--url <canonical-url>] [--port <number>] [--hostname <host>]

init creates a new community once: its handle, and the founder account that
only the named self-certifying profile may claim. The data directory defaults
to ./<community>. serve runs an existing community; it is the default command.
An unattended serve of an empty directory (Railway, Compose) creates the
community from ARBOR_COMMUNITY_HANDLE, ARBOR_FIRST_WRITER_HANDLE, and
ARBOR_FIRST_WRITER_PROFILE, or from ARBOR_ACCOUNTS_JSON / ARBOR_ACCOUNT_TOKEN.`;

function usage(): never {
  console.error(USAGE);
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

function rejectUnknown(args: string[], known: string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.includes(arg));
  if (unknown.length) throw new Error(`Unknown canopyd option: ${unknown[0]}\n${USAGE}`);
}

function hostnameOption(args: string[]): string {
  return option(args, "--hostname") ?? "0.0.0.0";
}

function parsePort(args: string[]): number {
  const port = Number(option(args, "--port") ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Canopy port must be an integer from 0 through 65535");
  }
  return port;
}

async function hasCommunity(dataRoot: string): Promise<boolean> {
  return stat(resolve(dataRoot, "canopy.sqlite3")).then(() => true).catch(() => false);
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

/** `canopyd init <community> --founder <handle>=<TreeID> [--data <directory>]` */
export async function initCommunity(args: string[]): Promise<void> {
  const valued = ["--founder", "--data"];
  rejectUnknown(args, valued);
  const positional = positionals(args, valued);
  if (positional.length !== 1) usage();
  const handle = positional[0]!;
  const founder = option(args, "--founder");
  if (!founder) throw new Error("init requires --founder <handle>=<TreeID>: the account handle and the profile that may claim it");
  const separator = founder.indexOf("=");
  if (separator <= 0 || separator === founder.length - 1) {
    throw new Error(`--founder must be <handle>=<TreeID>, got ${JSON.stringify(founder)}`);
  }
  const founderHandle = founder.slice(0, separator);
  const founderProfile = founder.slice(separator + 1);
  const dataRoot = resolve(option(args, "--data") ?? handle);
  if (await hasCommunity(dataRoot)) {
    throw new Error(`${dataRoot} already holds a community; run \`canopyd serve ${dataRoot}\` instead`);
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const canopy = await CanopyDaemon.open(dataRoot, {
    handle,
    name: handle,
    firstWriter: { handle: founderHandle, profileTree: founderProfile },
    accounts: [],
  });
  await canopy[Symbol.asyncDispose]();
  console.log(`Created community ${handle} in ${dataRoot}`);
  console.log(`Founder account ~${founderHandle} is reserved for profile ${founderProfile}`);
  console.log(`Start it with: canopyd serve ${dataRoot}`);
}

/** `canopyd [serve] [<directory>] [--url ...] [--port ...] [--hostname ...]` */
export async function serveCommunity(args: string[]): Promise<void> {
  const valued = ["--url", "--port", "--hostname"];
  rejectUnknown(args, valued);
  const positional = positionals(args, valued);
  if (positional.length > 1) usage();

  const requestedPort = parsePort(args);
  if (process.env.ARBOR_CANOPY_MAINTENANCE?.trim()) {
    const server = serveMaintenance(requestedPort, hostnameOption(args));
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
  const existingCanopy = await hasCommunity(dataRoot);

  // Unattended bootstrap of an empty data directory comes only from the
  // environment; the interactive path is `canopyd init`.
  const configuredAccounts = process.env.ARBOR_ACCOUNTS_JSON
    ? JSON.parse(process.env.ARBOR_ACCOUNTS_JSON) as CanopyBootstrapAccount[]
    : null;
  const accountToken = process.env.ARBOR_ACCOUNT_TOKEN;
  const accounts = configuredAccounts ?? (accountToken ? [{
    handle: process.env.ARBOR_ACCOUNT_HANDLE ?? "owner",
    token: accountToken,
    name: process.env.ARBOR_ACCOUNT_NAME ?? "Owner",
    communityWriter: true,
  }] : []);
  const envCommunity = process.env.ARBOR_COMMUNITY_HANDLE;
  const envFounderHandle = process.env.ARBOR_FIRST_WRITER_HANDLE;
  const envFounderProfile = process.env.ARBOR_FIRST_WRITER_PROFILE;
  let firstWriter: { handle: string; profileTree: string } | undefined;
  if (!existingCanopy) {
    if (!envCommunity) {
      throw new Error(
        `No community at ${dataRoot}. Create one with \`canopyd init <community> --founder <handle>=<TreeID> --data ${dataRoot}\`, `
        + "or set ARBOR_COMMUNITY_HANDLE with ARBOR_FIRST_WRITER_HANDLE and ARBOR_FIRST_WRITER_PROFILE for an unattended start.",
      );
    }
    if (!accounts.length) {
      if (!envFounderHandle || !envFounderProfile) {
        throw new Error("An unattended new community requires ARBOR_FIRST_WRITER_HANDLE and ARBOR_FIRST_WRITER_PROFILE (or ARBOR_ACCOUNTS_JSON)");
      }
      firstWriter = { handle: envFounderHandle, profileTree: envFounderProfile };
    }
  }
  const communityHandle = envCommunity ?? "community";

  let running: Awaited<ReturnType<typeof serveCanopy>>;
  try {
    running = await serveCanopy({
      dataRoot,
      publicOrigin,
      community: { handle: communityHandle, name: communityHandle, ...(firstWriter ? { firstWriter } : {}) },
      accounts,
      port: requestedPort,
      hostname: hostnameOption(args),
    });
  } catch (error) {
    // A data root written by another schema version is not served and not
    // touched; the process stays up in maintenance mode so an operator can run
    // the migration in place, then restart.
    if (error instanceof Error && /schema version/.test(error.message)) {
      console.error(error.message);
      const server = serveMaintenance(requestedPort, hostnameOption(args));
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
  console.log(`${existingCanopy ? "Serving" : "Created and serving"} ${running.canopy.communityHandle()} at ${running.url}`);
  console.log(`Data: ${dataRoot}`);
  const unclaimed = running.canopy.unclaimedFounderHandle();
  if (unclaimed) {
    if (new URL(publicOrigin).port === "0") {
      throw new Error("A community whose founder account is still unclaimed needs a stable nonzero --port or an explicit --url");
    }
    console.log(`Founder account ${running.url}/~${unclaimed} is reserved and unclaimed; open it in Canopy and claim it with the founder's profile.`);
  }
  const shutdown = async () => {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function runCanopyDaemon(args = process.argv.slice(2)): Promise<void> {
  const [first, ...rest] = args;
  if (first === "init") return initCommunity(rest);
  if (first === "serve") return serveCommunity(rest);
  if (first === "--help" || first === "-h" || first === "help") usage();
  return serveCommunity(args);
}

if (import.meta.main) {
  runCanopyDaemon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
