#!/usr/bin/env bun
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { PublicationMode } from "@arbor/core";
import { ConnectionStore } from "@arbor/stores";
import { serveWireHost, WireClient } from "@arbor/wire";

function usage(): never {
  console.error(`Usage:
  arbor browse <path> [--port <number>] [--no-open]
  arbor sync <local-path> <your-canonical-url> [-private|-public-read|-public-write]
  arbor sync <canonical-url> <local-path>
  arbor serve
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
  slug: string;
  supplied: string;
}

function canonicalTarget(input: string): CanonicalTarget {
  const url = new URL(input);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) throw new Error("A canonical tree URL must contain exactly one tree name");
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { endpoint: url.origin, slug: segments[0]!, supplied: input.replace(/\/$/, "") };
  }
  if (url.protocol === "arbor:" && url.hostname !== "tree") {
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return {
      endpoint: `${local ? "http" : "https"}://${url.host}`,
      slug: segments[0]!,
      supplied: input.replace(/\/$/, ""),
    };
  }
  throw new Error("Use a named HTTP or arbor:// canonical URL");
}

function publicationMode(args: string[]): PublicationMode {
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length === 0) return "private";
  if (flags.length !== 1 || !/^--?(?:private|public-read|public-write)$/.test(flags[0]!)) {
    throw new Error("Mode must be -private, -public-read, or -public-write");
  }
  return flags[0]!.replace(/^--?/, "") as PublicationMode;
}

async function systemTrees(client: ArbordClient): Promise<Array<Record<string, unknown>>> {
  const directory = await client.node({ tree: "system", path: "/trees" });
  return Promise.all((directory.children ?? []).map(async (child) =>
    (await client.node({ tree: "system", path: child.path })).document?.frontmatter ?? {}
  ));
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

async function syncCommand(args: string[]): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== 2) usage();
  const [first, second] = positional;
  const firstIsURL = /^(?:https?|arbor):\/\//.test(first!);

  if (!firstIsURL) {
    const path = await realpath(resolve(first!));
    if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
    const target = canonicalTarget(second!);
    const mode = publicationMode(args);
    await withArbord(path, async (client) => {
      const server = await client.node({ tree: "system", path: "/server" });
      if (server.document?.frontmatter.origin !== target.endpoint) {
        const token = process.env.ARBOR_OWNER_TOKEN ?? await readSecret(`Owner token for ${target.endpoint}: `);
        if (!token) throw new Error("No owner token supplied");
        await client.mutateSystem({ op: "configureServer", origin: target.endpoint, ownerToken: token });
      }
      const existing = (await systemTrees(client)).find((record) => record.path === path);
      let tree = typeof existing?.id === "string" && existing.placement === "shared" ? existing.id : undefined;
      if (tree && existing) {
        const sameName = existing.canonical === target.supplied
          || existing.http === target.supplied
          || (typeof existing.canonical === "string" && new URL(existing.canonical).host === new URL(target.endpoint).host
            && new URL(existing.canonical).pathname === `/${target.slug}`);
        if (!sameName) throw new Error(`${path} already has a different canonical URL`);
      } else {
        const receipt = await client.mutateSystem({ op: "promoteTree", path, slug: target.slug });
        tree = receipt.effects.find((effect) => effect.tree?.startsWith("tr_"))?.tree;
        if (!tree) throw new Error("Promotion did not return a TreeID");
      }
      if (existing?.publication !== mode) {
        await client.mutateSystem({ op: "setTreePublication", tree, publication: mode });
      }
      const record = (await systemTrees(client)).find((item) => item.id === tree);
      console.log(`${record?.canonical ?? target.supplied} ↔ ${path} (${mode})`);
    });
    return;
  }

  if (args.some((arg) => arg.startsWith("-"))) {
    throw new Error("The remote sync form does not take a publication mode");
  }
  const target = canonicalTarget(first!);
  const remote = await new WireClient(target.endpoint).resolve(target.slug);
  const requestedDestination = resolve(second!);
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
    console.log(`${remote.arborURL} ↔ ${destination} (${remote.publication === "public-write" ? "write" : "read"})`);
  });
}

async function serveCommand(): Promise<void> {
  const ownerToken = process.env.ARBOR_OWNER_TOKEN;
  const publicOrigin = process.env.ARBOR_PUBLIC_ORIGIN;
  const dataRoot = process.env.ARBOR_HOST_DATA ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/data";
  if (!ownerToken) throw new Error("ARBOR_OWNER_TOKEN is required");
  if (!publicOrigin) throw new Error("ARBOR_PUBLIC_ORIGIN is required");

  const running = await serveWireHost({ dataRoot, ownerToken, publicOrigin });
  console.log(`Arbor authority listening at ${running.url}`);
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
  if (command === "sync") {
    await syncCommand(args);
    process.exit(0);
  }
  if (command === "serve") {
    if (args.length) usage();
    await serveCommand();
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
