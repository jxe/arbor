#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AccountDirectory } from "./accounts.ts";
import { HostDaemon, SchemaMismatchError, serveHost, type HostBootstrapAccount } from "./index.ts";

const USAGE = `Usage:
  overstoryd init <community> --founder <handle>=<TreeID> [--data <directory>]
  overstoryd [serve] [<directory>] [--url <canonical-url>] [--port <number>] [--hostname <host>]
  overstoryd recover <handle> [--data <directory>] [--url <canonical-url>]

init creates a new community once: its handle, and the founder account that
only the named self-certifying profile may claim. The data directory defaults
to ./<community>. serve runs an existing community; it is the default command.
An unattended serve of an empty directory (Railway, Compose) creates the
community from OVERSTORYD_COMMUNITY_HANDLE, OVERSTORYD_FIRST_WRITER_HANDLE, and
OVERSTORYD_FIRST_WRITER_PROFILE, or from OVERSTORYD_ACCOUNTS_JSON: accounts, each with
its first key device's DeviceID and key.
recover is the operator's help for a person who has lost every administrator
device: it prints a one-day recovery pairing code for their account, which they
claim from a new device as an ordinary pairing. That device becomes the
account's only one; until then every existing device keeps working. Run it
where the data lives (on Railway, over \`railway ssh\`), never in logs.`;

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
  if (unknown.length) throw new Error(`Unknown overstoryd option: ${unknown[0]}\n${USAGE}`);
}

function hostnameOption(args: string[]): string {
  return option(args, "--hostname") ?? "0.0.0.0";
}

function parsePort(args: string[]): number {
  const port = Number(option(args, "--port") ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("overstoryd port must be an integer from 0 through 65535");
  }
  return port;
}

/**
 * Whether the data root holds a community: its database file is there.
 *
 * Rename 001 cutover guard: a data root that still holds the database under
 * its old name, `canopy.sqlite3`, and none under the new name is refused.
 * Treating it as empty would bootstrap a second, empty community beside the
 * real one.
 */
export async function hasCommunity(dataRoot: string): Promise<boolean> {
  const present = (name: string) => stat(resolve(dataRoot, name)).then(() => true).catch(() => false);
  if (await present("overstoryd.sqlite3")) return true;
  // Rename 001 cutover guard: `canopy.sqlite3` is the pre-rename file name.
  if (await present("canopy.sqlite3")) {
    throw new Error(
      `${dataRoot} holds canopy.sqlite3 but no overstoryd.sqlite3. The database must be renamed before this build serves it: `
      + "stop the host, checkpoint the WAL, rename canopy.sqlite3 to overstoryd.sqlite3, and remove any stale canopy.sqlite3-wal and canopy.sqlite3-shm.",
    );
  }
  return false;
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
      if (pathname === "/" || pathname === "/.overstory/health") {
        return Response.json({ status: "maintenance" }, { headers: { "cache-control": "no-store" } });
      }
      return Response.json(
        { error: "internal-error", message: "This Overstory host is in maintenance; try again later", retryable: true },
        { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } },
      );
    },
  });
  console.log(`overstoryd in maintenance mode at http://${hostname}:${server.port}; migrate the data root or unset OVERSTORYD_MAINTENANCE, then restart.`);
  return server;
}

/** Serve maintenance mode until the process is told to stop. */
function maintainUntilStopped(port: number, hostname: string): void {
  const server = serveMaintenance(port, hostname);
  const stop = () => { server.stop(true); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** `overstoryd init <community> --founder <handle>=<TreeID> [--data <directory>]` */
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
    throw new Error(`${dataRoot} already holds a community; run \`overstoryd serve ${dataRoot}\` instead`);
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const overstoryd = await HostDaemon.open(dataRoot, {
    handle,
    name: handle,
    firstWriter: { handle: founderHandle, profileTree: founderProfile },
    accounts: [],
  });
  await overstoryd[Symbol.asyncDispose]();
  console.log(`Created community ${handle} in ${dataRoot}`);
  console.log(`Founder account ~${founderHandle} is reserved for profile ${founderProfile}`);
  console.log(`Start it with: overstoryd serve ${dataRoot}`);
}

/** `overstoryd [serve] [<directory>] [--url ...] [--port ...] [--hostname ...]` */
export async function serveCommunity(args: string[]): Promise<void> {
  const valued = ["--url", "--port", "--hostname"];
  rejectUnknown(args, valued);
  const positional = positionals(args, valued);
  if (positional.length > 1) usage();

  const requestedPort = parsePort(args);
  if (process.env.OVERSTORYD_MAINTENANCE?.trim()) return maintainUntilStopped(requestedPort, hostnameOption(args));
  const onRailway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const hostDomain = process.env.OVERSTORYD_DOMAIN;
  const configuredPublicOrigin = option(args, "--url") ?? (hostDomain ? `https://${hostDomain}` : undefined);
  if (onRailway && !configuredPublicOrigin && !railwayDomain) {
    throw new Error("Railway needs a public domain before first start. Generate one, set OVERSTORYD_DOMAIN, or pass --url, then redeploy.");
  }
  if (onRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Railway needs a persistent volume attached before start; mount it at /data.");
  }
  const publicOrigin = configuredPublicOrigin
    ?? (railwayDomain ? (/^https?:\/\//.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`) : undefined)
    ?? `http://127.0.0.1:${requestedPort}`;
  const dataRoot = resolve(positional[0] ?? process.env.OVERSTORYD_DATA ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".overstoryd");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const existingHost = await hasCommunity(dataRoot);

  // Unattended bootstrap of an empty data directory comes only from the
  // environment; the interactive path is `overstoryd init`.
  const accounts = process.env.OVERSTORYD_ACCOUNTS_JSON
    ? JSON.parse(process.env.OVERSTORYD_ACCOUNTS_JSON) as HostBootstrapAccount[]
    : [];
  const envCommunity = process.env.OVERSTORYD_COMMUNITY_HANDLE;
  const envFounderHandle = process.env.OVERSTORYD_FIRST_WRITER_HANDLE;
  const envFounderProfile = process.env.OVERSTORYD_FIRST_WRITER_PROFILE;
  let firstWriter: { handle: string; profileTree: string } | undefined;
  if (!existingHost) {
    if (!envCommunity) {
      throw new Error(
        `No community at ${dataRoot}. Create one with \`overstoryd init <community> --founder <handle>=<TreeID> --data ${dataRoot}\`, `
        + "or set OVERSTORYD_COMMUNITY_HANDLE with OVERSTORYD_FIRST_WRITER_HANDLE and OVERSTORYD_FIRST_WRITER_PROFILE for an unattended start.",
      );
    }
    if (!accounts.length) {
      if (!envFounderHandle || !envFounderProfile) {
        throw new Error("An unattended new community requires OVERSTORYD_FIRST_WRITER_HANDLE and OVERSTORYD_FIRST_WRITER_PROFILE (or OVERSTORYD_ACCOUNTS_JSON)");
      }
      firstWriter = { handle: envFounderHandle, profileTree: envFounderProfile };
    }
  }
  const communityHandle = envCommunity ?? "community";

  let running: Awaited<ReturnType<typeof serveHost>>;
  try {
    running = await serveHost({
      dataRoot,
      publicOrigin,
      community: { handle: communityHandle, name: communityHandle, ...(firstWriter ? { firstWriter } : {}) },
      accounts,
      port: requestedPort,
      hostname: hostnameOption(args),
      rateLimits: process.env.OVERSTORYD_RATE_LIMITS === "1",
    });
  } catch (error) {
    // A data root whose schema this build does not serve is not served and
    // not touched; the process stays up in maintenance mode so an operator can
    // run the migration in place, then restart.
    if (error instanceof SchemaMismatchError) {
      console.error(error.message);
      return maintainUntilStopped(requestedPort, hostnameOption(args));
    }
    throw error;
  }
  console.log(`${existingHost ? "Serving" : "Created and serving"} ${running.overstoryd.communityHandle()} at ${running.url}`);
  console.log(`Data: ${dataRoot}`);
  const unclaimed = running.overstoryd.unclaimedFounderHandle();
  if (unclaimed) {
    if (new URL(publicOrigin).port === "0") {
      throw new Error("A community whose founder account is still unclaimed needs a stable nonzero --port or an explicit --url");
    }
    console.log(`Founder account ${running.url}/~${unclaimed} is reserved and unclaimed; open it in Story and claim it with the founder's profile.`);
  }
  const shutdown = async () => {
    running.server.stop(true);
    await running.overstoryd[Symbol.asyncDispose]();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * `overstoryd recover <handle> [--data <directory>] [--url <canonical-url>]`:
 * a recovery pairing for the account, written beside a running server (the
 * database is shared in WAL mode) and printed as the pairing code a client
 * pastes or scans.
 */
export async function recoverAccount(args: string[]): Promise<void> {
  const valued = ["--data", "--url"];
  rejectUnknown(args, valued);
  const positional = positionals(args, valued);
  if (positional.length !== 1) usage();
  const handle = positional[0]!.replace(/^~/, "");
  const dataRoot = resolve(option(args, "--data") ?? process.env.OVERSTORYD_DATA ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".overstoryd");
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const origin = option(args, "--url") ?? (process.env.OVERSTORYD_DOMAIN ? `https://${process.env.OVERSTORYD_DOMAIN}` : undefined)
    ?? (railwayDomain ? (/^https?:\/\//.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`) : undefined);
  if (!origin) throw new Error("recover needs the community's public origin: pass --url or set OVERSTORYD_DOMAIN");
  if (!await hasCommunity(dataRoot)) throw new Error(`No community at ${dataRoot}`);
  const db = new Database(join(dataRoot, "overstoryd.sqlite3"));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const accounts = new AccountDirectory(db);
    const account = accounts.accountByHandle(handle);
    if (!account) throw new Error(`Unknown account: ~${handle}`);
    const offer = accounts.createPairing(account, { recovery: true });
    console.log(`Recovery pairing for ~${handle}, valid until ${new Date(offer.expiresAt).toISOString()}.`);
    console.log("Claim it from the new device as a pairing code; it becomes the account's only device.");
    console.log(`Confirmation code: ${offer.confirmationCode}`);
    console.log(JSON.stringify({ version: 1, origin: new URL(origin).origin, pairing: { id: offer.id, secret: offer.secret } }));
  } finally {
    db.close();
  }
}

export async function runHostDaemon(args = process.argv.slice(2)): Promise<void> {
  const [first, ...rest] = args;
  if (first === "init") return initCommunity(rest);
  if (first === "recover") return recoverAccount(rest);
  if (first === "serve") return serveCommunity(rest);
  if (first === "--help" || first === "-h" || first === "help") usage();
  return serveCommunity(args);
}

if (import.meta.main) {
  runHostDaemon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
