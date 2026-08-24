#!/usr/bin/env bun
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ArborService, serveArbor, serveArborControl } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { ShareAudience } from "@arbor/core";
import { ConnectionStore } from "@arbor/stores";
import { serveWireHost, type CommunityBootstrapAccount } from "@arbor/authority";
import { WireClient } from "@arbor/wire";

function usage(): never {
  console.error(`Usage:
  arbor browse <locator> [--port <number>] [--no-open]
  arbor connect <community-url>
  arbor sync [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
  arbor sync <canonical-url> <local-path>
  arbor unsync <local-path> [<canonical-url>]
  arbor unsync <canonical-url> <local-path>
  arbor serve [data-directory] [--url <canonical-url>] [--port <number>] [--community <handle>] [--first-writer <handle>]
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

export interface BrowseTarget {
  path?: string;
  remoteURL?: string;
  profile?: { origin: string; handle: string; path: string };
}

export function browseTarget(input: string, cwd = process.cwd()): BrowseTarget {
  if (!/^(?:https?|arbor):\/\//.test(input)) return { path: resolve(cwd, input) };
  const target = canonicalTarget(input);
  const source = new URL(input);
  const remoteURL = source.protocol === "arbor:"
    ? `${target.endpoint}${source.pathname}${source.search}${source.hash}`
    : source.toString();
  const profile = /^\/~([a-z0-9](?:[a-z0-9-]{0,62}))\/?$/.exec(target.canonicalPath);
  return {
    remoteURL,
    ...(profile ? { profile: { origin: target.endpoint, handle: profile[1]!, path: target.canonicalPath } } : {}),
  };
}

export async function isReservedProfile(target: BrowseTarget): Promise<boolean> {
  if (!target.profile || !target.remoteURL) return false;
  try {
    const response = await fetch(target.remoteURL, { headers: { accept: "text/html" } });
    if (!response.ok) return false;
    if (response.headers.get("x-arbor-profile-state") === "reserved") return true;
    return (await response.text()).includes("has not been claimed");
  } catch {
    return false;
  }
}

export async function placedRemotePath(target: BrowseTarget, service: ArborService): Promise<string | null> {
  if (!target.remoteURL) return null;
  try {
    const canonical = canonicalTarget(target.remoteURL);
    const account = await service.communityConfig.get();
    const token = account?.record.origin === canonical.endpoint ? account.accountToken : undefined;
    const remote = await new WireClient(canonical.endpoint, token).resolve(canonical.canonicalPath);
    const placement = service.trees.placementFor(remote.id);
    if (!placement || placement.source === "local") return null;
    return `${placement.path}${remote.path === "/" ? "" : remote.path}`;
  } catch {
    return null;
  }
}

type CliAudienceOperation =
  | { kind: "clear" }
  | { kind: "set"; subject: string; access: "none" | "read" | "write" };

function accessOperations(value: string): CliAudienceOperation[] {
  if (!value.trim()) throw new Error("--access requires at least one subject=read|write|none entry");
  return value.split(",").map((entry) => {
    const assignment = entry.trim();
    const separator = assignment.indexOf("=");
    if (separator <= 0 || assignment.indexOf("=", separator + 1) !== -1) {
      throw new Error(`Invalid access entry: ${assignment || "(empty)"}. Expected subject=read|write|none`);
    }
    const subject = assignment.slice(0, separator).trim();
    const access = assignment.slice(separator + 1).trim();
    if (!subject || !["none", "read", "write"].includes(access)) {
      throw new Error(`Invalid access entry: ${assignment}. Expected subject=read|write|none`);
    }
    return { kind: "set" as const, subject, access: access as "none" | "read" | "write" };
  });
}

function syncArguments(args: string[]): { operands: string[]; audience: CliAudienceOperation[] } {
  const operands: string[] = [];
  const audience: CliAudienceOperation[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--access" || arg.startsWith("--access=")) {
      const inline = arg.startsWith("--access=") ? arg.slice("--access=".length) : undefined;
      const value = inline ?? args[index + 1];
      if (value === undefined || (!inline && value.startsWith("-"))) {
        throw new Error("--access requires subject=read|write|none");
      }
      audience.push(...accessOperations(value));
      if (inline === undefined) index += 1;
    } else if (arg === "--clear-access") {
      audience.push({ kind: "clear" });
    } else if (["-r", "--read", "-rw", "--read-write", "--remove"].includes(arg)) {
      // Compatibility aliases for the pre-ACL-builder command surface.
      const subject = args[index + 1];
      if (!subject || subject.startsWith("-")) throw new Error(`${arg} requires public or ~<handle>`);
      audience.push({
        kind: "set",
        subject,
        access: arg === "--remove" ? "none" : arg === "-r" || arg === "--read" ? "read" : "write",
      });
      index += 1;
    } else if (arg === "--private") {
      // Compatibility alias for --clear-access.
      audience.push({ kind: "clear" });
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown sync option: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  return { operands, audience };
}

function accessSubject(subject: string, target: CanonicalTarget): { kind: "everyone" } | { kind: "profile"; locator: string } {
  if (subject === "public") return { kind: "everyone" };
  if (!/^~[a-z0-9](?:[a-z0-9-]{0,62})$/.test(subject)) {
    throw new Error(`Audience must be public or a same-community profile such as ~editors: ${subject}`);
  }
  return { kind: "profile", locator: `${target.endpoint}/${subject}` };
}

function initialAudience(operations: CliAudienceOperation[], target: CanonicalTarget): ShareAudience {
  const afterLastClear = operations.slice(operations.findLastIndex((operation) => operation.kind === "clear") + 1);
  const access = new Map<string, "read" | "write">();
  for (const operation of afterLastClear) {
    if (operation.kind !== "set") continue;
    if (operation.access === "none") access.delete(operation.subject);
    else access.set(operation.subject, operation.access);
  }
  if (!access.size) return { kind: "private" };
  return {
    kind: "rules",
    rules: [...access].map(([name, permission]) => {
      const subject = accessSubject(name, target);
      return subject.kind === "everyone"
        ? { subject: { kind: "everyone" as const }, access: permission }
        : { subject: { kind: "profile" as const, locator: subject.locator }, access: permission };
    }),
  };
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

async function withArbord<T>(
  path: string,
  run: (client: ArbordClient, service: ArborService) => Promise<T>,
): Promise<T> {
  const running = await serveArbor(path, { port: 0 });
  try {
    return await run(new ArbordClient({ baseURL: running.url }), running.service);
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
  const service = await ArborService.openControl();
  try {
    await service.executeMutation({
      mutationID: crypto.randomUUID(),
      operations: [{ op: "connectCommunity", origin: target.endpoint, accountToken: token }],
    });
    const record = await service.communityConfig.safe();
    if (!record) throw new Error("The community connection was not saved");
    console.log(`Connected as ~${record.handle} to ${record.communityURL ?? target.endpoint}`);
  } finally {
    await service[Symbol.asyncDispose]();
  }
}

async function promoteLocal(
  first: string,
  second: string,
  audience: CliAudienceOperation[],
): Promise<void> {
  const path = await realpath(resolve(first));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const target = canonicalTarget(second);
  await withArbord(path, async (client) => {
    const community = await communityRecord(client);
    if (community.origin !== target.endpoint) {
      throw new Error(`Claim or activate a writable profile at ${target.endpoint} before sharing there`);
    }
    const existing = (await systemTrees(client)).find((record) => record.path === path);
    let tree = typeof existing?.id === "string" && existing.placement === "shared" ? existing.id : undefined;
    const isNew = !tree;
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
        audience: initialAudience(audience, target),
      });
      tree = receipt.effects.find((effect) => effect.tree?.startsWith("tr_"))?.tree;
      if (!tree) throw new Error("Sharing did not return a TreeID");
    }
    if (tree && !isNew) {
      for (const operation of audience) {
        if (operation.kind === "clear") {
          await client.mutateSystem({ op: "setTreeAccess", tree, subject: { kind: "all" }, access: "none" });
        } else {
          await client.mutateSystem({
            op: "setTreeAccess",
            tree,
            subject: accessSubject(operation.subject, target),
            access: operation.access,
          });
        }
      }
    }
    const record = (await systemTrees(client)).find((item) => item.id === tree);
    if (isNew && audience.length === 0) {
      console.warn(`Warning: no audience options supplied; created ${record?.canonical ?? target.supplied} with private access.`);
    }
    console.log(`${record?.canonical ?? target.supplied} ↔ ${path}`);
  });
}

async function syncCommand(args: string[]): Promise<void> {
  const { operands, audience } = syncArguments(args);
  if (operands.length !== 2) usage();
  const [first, second] = operands as [string, string];
  const firstIsURL = /^(?:https?|arbor):\/\//.test(first);
  if (!firstIsURL) {
    await promoteLocal(first, second, audience);
    return;
  }
  if (audience.length) throw new Error("The remote-to-local sync form does not take audience options");
  const target = canonicalTarget(first);
  const requestedDestination = resolve(second);
  await mkdir(dirname(requestedDestination), { recursive: true });
  const destination = await realpath(requestedDestination).catch(async () =>
    join(await realpath(dirname(requestedDestination)), basename(requestedDestination))
  );
  await withArbord(dirname(destination), async (client, service) => {
    const configured = await service.communityConfig.get();
    const accountToken = configured?.record.origin === target.endpoint ? configured.accountToken : undefined;
    const remote = await new WireClient(target.endpoint, accountToken).resolve(target.canonicalPath);
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
    console.log(`${remote.arborURL} ↔ ${destination} (${remote.access})`);
  });
}

async function unsyncCommand(args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("-"))) usage();
  const urls = args.filter((arg) => /^(?:https?|arbor):\/\//.test(arg));
  if (urls.length > 1 || (args.length === 2 && urls.length !== 1) || (args.length === 1 && urls.length !== 0)) usage();
  const localInput = args.find((arg) => !/^(?:https?|arbor):\/\//.test(arg))!;
  const requestedPath = resolve(localInput);
  const path = await realpath(requestedPath).catch(() => requestedPath);
  const target = urls[0] ? canonicalTarget(urls[0]) : undefined;
  await withArbord(await stat(path).then((value) => value.isDirectory()).catch(() => false) ? path : dirname(path), async (client) => {
    const existing = (await systemTrees(client)).find((record) => record.path === path && record.placement === "shared");
    if (!existing) throw new Error(`No shared tree placement at ${path}`);
    await client.mutateSystem({
      op: "removeTreePlacement",
      path,
      ...(target ? { endpoint: target.endpoint, canonicalPath: target.canonicalPath } : {}),
    });
    console.log(`${existing.canonical ?? target?.supplied ?? "Shared tree"} ↮ ${path}`);
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
  const valuedOptions = ["--url", "--port", "--hostname", "--community", "--first-writer"];
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
  const arborDomain = process.env.ARBOR_DOMAIN;
  const configuredPublicOrigin = commandOption(args, "--url")
    ?? (arborDomain ? `https://${arborDomain}` : undefined);
  if (onRailway && !configuredPublicOrigin && !railwayDomain) {
    throw new Error("Railway needs a public domain before first start. Generate one, set ARBOR_DOMAIN, or pass --url, then redeploy.");
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
  const requestedCommunityHandle = commandOption(args, "--community");
  const requestedFirstWriterHandle = commandOption(args, "--first-writer");
  if (!existingAuthority && !accounts.length && !process.stdin.isTTY) {
    if (!requestedCommunityHandle) throw new Error("A new unattended community requires --community <handle>");
    if (!requestedFirstWriterHandle) throw new Error("A new unattended community requires --first-writer <handle>");
  }
  const communityHandle = defaultHandle(
    requestedCommunityHandle ?? basename(resolve(dataRoot)),
    "community",
  );
  const firstWriterHandle = !existingAuthority && !accounts.length
    ? defaultHandle(
        requestedFirstWriterHandle ?? process.env.USER,
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
      name: communityHandle,
      ...(firstWriterHandle ? { firstWriter: { handle: firstWriterHandle } } : {}),
    },
    accounts,
    port: requestedPort,
    hostname: commandOption(args, "--hostname") ?? "0.0.0.0",
  });
  const resetAccount = process.env.ARBOR_RESET_ACCOUNT?.trim();
  if (resetAccount) {
    if (!accountToken) throw new Error("ARBOR_RESET_ACCOUNT requires ARBOR_ACCOUNT_TOKEN");
    running.authority.resetAccountToken(resetAccount, accountToken);
    console.log(`Reset the device credential for ~${resetAccount}; remove ARBOR_RESET_ACCOUNT after recovery.`);
  }
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
    const input = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const target = browseTarget(input);
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4317;
    const running = target.remoteURL
      ? await serveArborControl({ port })
      : await serveArbor(target.path!, { port });
    const { service, server, url } = running;
    let start = "";
    if (running.mode === "workspace") {
      start = running.start;
      const descriptor = running.workspace.descriptor();
      const scope = descriptor.placement === "shared"
        ? `shared tree "${descriptor.name}"`
        : descriptor.legacy
          ? `"${descriptor.name}" needs a URL`
          : "ordinary local files";
      console.log(`Arbor is browsing ${start} (${scope})`);
    } else {
      console.log(`Arbor is browsing ${target.remoteURL}`);
    }
    console.log(url);
    const claimable = target.remoteURL ? await isReservedProfile(target) : false;
    const placedPath = target.remoteURL && !claimable ? await placedRemotePath(target, service) : null;
    const browserURL = new URL(`${url}/render${placedPath ?? start}`);
    if (target.remoteURL) {
      if (!placedPath) browserURL.searchParams.set("browse", target.remoteURL);
      if (claimable) browserURL.searchParams.set("claimable", "true");
    }
    if (!args.includes("--no-open")) await openBrowser(browserURL.toString());
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
  if (command === "sync") {
    await syncCommand(args);
    process.exit(0);
  }
  if (command === "unsync") {
    await unsyncCommand(args);
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

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
