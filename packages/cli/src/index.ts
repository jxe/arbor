#!/usr/bin/env bun
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { ShareAudience } from "@arbor/core";
import { ConnectionStore } from "@arbor/stores";
import { serveWireHost, WireClient, type CommunityBootstrapAccount } from "@arbor/wire";

function usage(): never {
  console.error(`Usage:
  arbor browse <path> [--port <number>] [--no-open]
  arbor connect <community-url>
  arbor share <local-path> <canonical-url> (--private|--public-read|--public-write|--with <profile-url>)
  arbor sync <local-path> <canonical-url> [--private|--public-read|--public-write]
  arbor sync <canonical-url> <local-path>
  arbor serve [data-directory] [--url <canonical-url>] [--port <number>] [--community <handle>] [--name <name>] [--first-writer <handle>]
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

interface CanonicalTarget {
  endpoint: string;
  canonicalPath: string;
  supplied: string;
}

function canonicalTarget(input: string): CanonicalTarget {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "arbor:") {
    throw new Error("Use an HTTP or arbor:// canonical URL");
  }
  if (url.protocol === "arbor:" && url.hostname === "tree") {
    throw new Error("A raw TreeID is not a canonical community URL");
  }
  const endpoint = url.protocol === "arbor:"
    ? `${url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "http" : "https"}://${url.host}`
    : url.origin;
  const canonicalPath = `/${url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
  return {
    endpoint,
    canonicalPath: canonicalPath === "/" ? "/" : canonicalPath.replace(/\/$/, ""),
    supplied: input.replace(/\/$/, ""),
  };
}

function audience(args: string[], requireExplicit = false): ShareAudience {
  const withIndex = args.indexOf("--with");
  if (withIndex >= 0) {
    const locator = args[withIndex + 1];
    if (!locator) throw new Error("--with requires a profile URL");
    return { kind: "profile", locator, access: "read" };
  }
  const flags = args.filter((arg) => /^--?(?:private|public-read|public-write)$/.test(arg));
  if (flags.length === 0) {
    if (requireExplicit) throw new Error("Choose an audience: --private, --public-read, --public-write, or --with <profile-url>");
    return { kind: "private" };
  }
  if (flags.length !== 1) throw new Error("Choose exactly one audience");
  const mode = flags[0]!.replace(/^--?/, "");
  return mode === "private"
    ? { kind: "private" }
    : { kind: "everyone", access: mode === "public-write" ? "write" : "read" };
}

async function systemTrees(client: ArbordClient): Promise<Array<Record<string, unknown>>> {
  const directory = await client.node({ tree: "system", path: "/trees" });
  return Promise.all((directory.children ?? []).map(async (child) =>
    (await client.node({ tree: "system", path: child.path })).document?.frontmatter ?? {}
  ));
}

async function communityRecord(client: ArbordClient): Promise<Record<string, unknown>> {
  return (await client.node({ tree: "system", path: "/community" })).document?.frontmatter ?? {};
}

async function withArbord<T>(path: string, run: (client: ArbordClient) => Promise<T>): Promise<T> {
  const running = await serveArbor(path, { port: 0 });
  try {
    return await run(new ArbordClient({ baseURL: running.url }));
  } finally {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  }
}

async function connectCommand(args: string[]): Promise<void> {
  if (args.length !== 1) usage();
  const target = canonicalTarget(args[0]!);
  const token = process.env.ARBOR_ACCOUNT_TOKEN ?? await readSecret(`Account/device credential for ${target.endpoint}: `);
  if (!token) throw new Error("No account credential supplied");
  await withArbord(process.cwd(), async (client) => {
    await client.mutateSystem({ op: "connectCommunity", origin: target.endpoint, accountToken: token });
    const record = await communityRecord(client);
    console.log(`Connected as ~${record.handle} to ${record.communityURL ?? target.endpoint}`);
  });
}

async function promoteLocal(
  first: string,
  second: string,
  args: string[],
  requireExplicitAudience: boolean,
): Promise<void> {
  const path = await realpath(resolve(first));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const target = canonicalTarget(second);
  const selectedAudience = audience(args, requireExplicitAudience);
  await withArbord(path, async (client) => {
    const community = await communityRecord(client);
    if (community.origin !== target.endpoint) {
      throw new Error(`Claim or activate a writable profile at ${target.endpoint} before sharing there`);
    }
    const existing = (await systemTrees(client)).find((record) => record.path === path);
    let tree = typeof existing?.id === "string" && existing.placement === "shared" ? existing.id : undefined;
    if (tree && existing) {
      const samePath = existing.canonicalPath === target.canonicalPath
        || existing.canonical === target.supplied
        || existing.http === target.supplied;
      if (!samePath) throw new Error(`${path} already has a different canonical URL`);
    } else {
      const receipt = await client.mutateSystem({
        op: "promoteTree",
        path,
        canonicalPath: target.canonicalPath,
        audience: selectedAudience,
      });
      tree = receipt.effects.find((effect) => effect.tree?.startsWith("tr_"))?.tree;
      if (!tree) throw new Error("Sharing did not return a TreeID");
    }
    if (tree && existing) {
      if (selectedAudience.kind === "everyone") {
        await client.mutateSystem({ op: "setTreeAccess", tree, subject: { kind: "everyone" }, access: selectedAudience.access });
      } else if (selectedAudience.kind === "private") {
        await client.mutateSystem({ op: "setTreeAccess", tree, subject: { kind: "everyone" }, access: "none" });
      } else {
        await client.mutateSystem({
          op: "setTreeAccess",
          tree,
          subject: { kind: "profile", locator: selectedAudience.locator },
          access: selectedAudience.access,
        });
      }
    }
    const record = (await systemTrees(client)).find((item) => item.id === tree);
    console.log(`${record?.canonical ?? target.supplied} ↔ ${path}`);
  });
}

async function syncCommand(args: string[]): Promise<void> {
  const positional = args.filter((arg, index) =>
    !arg.startsWith("-") && args[index - 1] !== "--with"
  );
  if (positional.length !== 2) usage();
  const [first, second] = positional as [string, string];
  const firstIsURL = /^(?:https?|arbor):\/\//.test(first);
  if (!firstIsURL) {
    await promoteLocal(first, second, args, false);
    return;
  }
  if (args.some((arg) => arg.startsWith("-"))) throw new Error("The remote sync form does not take an audience");
  const target = canonicalTarget(first);
  const remote = await new WireClient(target.endpoint).resolve(target.canonicalPath);
  const requestedDestination = resolve(second);
  await mkdir(dirname(requestedDestination), { recursive: true });
  const destination = await realpath(requestedDestination).catch(async () =>
    join(await realpath(dirname(requestedDestination)), basename(requestedDestination))
  );
  await withArbord(dirname(destination), async (client) => {
    const existing = (await systemTrees(client)).find((record) => record.id === remote.id && record.path === destination);
    if (!existing) {
      await client.mutateSystem({
        op: "placeTree",
        tree: remote.id,
        path: destination,
        endpoint: target.endpoint,
        canonical: remote.arborURL,
      });
    }
    console.log(`${remote.arborURL} ↔ ${destination} (${remote.publicAccess === "write" ? "write" : "read"})`);
  });
}

function commandOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function commandPositionals(args: string[], options: string[]): string[] {
  const values = new Set(options);
  return args.filter((arg, index) =>
    !arg.startsWith("--") && (index === 0 || !values.has(args[index - 1]!))
  );
}

function defaultHandle(input: string | undefined, fallback: string): string {
  const normalized = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(normalized) ? normalized : fallback;
}

async function serveCommand(args: string[]): Promise<void> {
  const valuedOptions = ["--url", "--port", "--hostname", "--community", "--name", "--first-writer"];
  const positional = commandPositionals(args, valuedOptions);
  if (positional.length > 1) usage();
  const unknown = args.filter((arg) =>
    arg.startsWith("--") && !valuedOptions.includes(arg)
  );
  if (unknown.length) throw new Error(`Unknown serve option: ${unknown[0]}`);

  const requestedPort = Number(commandOption(args, "--port") ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Serve port must be an integer from 0 through 65535");
  }
  const onRailway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const configuredPublicOrigin = commandOption(args, "--url") ?? process.env.ARBOR_PUBLIC_ORIGIN;
  if (onRailway && !configuredPublicOrigin && !railwayDomain) {
    throw new Error("Railway needs a public domain before first start. Generate one or set ARBOR_PUBLIC_ORIGIN, then redeploy.");
  }
  if (onRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Railway needs a persistent volume attached before start; mount it at /data.");
  }
  const publicOrigin = configuredPublicOrigin
    ?? (railwayDomain
      ? (/^https?:\/\//.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`)
      : undefined)
    ?? `http://127.0.0.1:${requestedPort}`;
  const dataRoot = resolve(
    positional[0]
      ?? process.env.ARBOR_HOST_DATA
      ?? process.env.RAILWAY_VOLUME_MOUNT_PATH
      ?? ".arbor-community",
  );
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const existingAuthority = await stat(join(dataRoot, "authority.sqlite3"))
    .then(() => true)
    .catch(() => false);
  const configuredAccounts = process.env.ARBOR_ACCOUNTS_JSON
    ? JSON.parse(process.env.ARBOR_ACCOUNTS_JSON) as CommunityBootstrapAccount[]
    : null;
  const accountToken = process.env.ARBOR_ACCOUNT_TOKEN ?? process.env.ARBOR_OWNER_TOKEN;
  const accounts = configuredAccounts ?? (accountToken
    ? [{
        handle: process.env.ARBOR_ACCOUNT_HANDLE ?? "owner",
        token: accountToken,
        name: process.env.ARBOR_ACCOUNT_NAME ?? "Owner",
        communityWriter: true,
      }]
    : []);
  const communityHandle = defaultHandle(
    commandOption(args, "--community") ?? process.env.ARBOR_COMMUNITY_HANDLE ?? basename(resolve(dataRoot)),
    "community",
  );
  const firstWriterHandle = !existingAuthority && !accounts.length
    ? defaultHandle(
        commandOption(args, "--first-writer")
          ?? process.env.ARBOR_FIRST_WRITER_HANDLE
          ?? process.env.USER,
        "owner",
      )
    : undefined;
  if (firstWriterHandle && new URL(publicOrigin).port === "0") {
    throw new Error("A new claim-first community needs a stable nonzero --port or explicit --url");
  }
  const running = await serveWireHost({
    dataRoot,
    publicOrigin,
    community: {
      handle: communityHandle,
      name: commandOption(args, "--name") ?? process.env.ARBOR_COMMUNITY_NAME ?? communityHandle,
      ...(firstWriterHandle ? { firstWriter: { handle: firstWriterHandle } } : {}),
    },
    accounts,
    port: requestedPort,
    hostname: commandOption(args, "--hostname") ?? "0.0.0.0",
  });
  console.log(`${existingAuthority ? "Serving" : "Created"} ${running.authority.communityHandle()} at ${running.url}`);
  console.log(`Data: ${dataRoot}`);
  if (firstWriterHandle) {
    console.log(`First writer profile: ${running.url}/~${firstWriterHandle}`);
    console.log("Open Arbor locally and claim this address from the profile control.");
  }
  const shutdown = async () => {
    running.server.stop(true);
    await running.authority[Symbol.asyncDispose]();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "browse") {
    const path = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4317;
    const { service, workspace, server, start, url } = await serveArbor(resolve(path), { port });
    const descriptor = workspace.descriptor();
    const scope = descriptor.placement === "shared"
      ? `shared tree "${descriptor.name}"`
      : descriptor.legacy
        ? `"${descriptor.name}" needs a URL`
        : "ordinary local files";
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
  if (command === "connect") {
    await connectCommand(args);
    process.exit(0);
  }
  if (command === "share") {
    const positional = args.filter((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--with");
    if (positional.length !== 2) usage();
    await promoteLocal(positional[0]!, positional[1]!, args, true);
    process.exit(0);
  }
  if (command === "sync") {
    await syncCommand(args);
    process.exit(0);
  }
  if (command === "serve") {
    await serveCommand(args);
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
