#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { serveArborSync, serveArborSyncControl } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import {
  ConnectionStore,
  CommunityConfigStore,
  arborDataRoot,
  loadAccountConfiguration,
  parseAccountConfiguration,
  parseDeviceConfiguration,
  parseTreesConfiguration,
  saveCurrentDeviceID,
  savePlacementSyncMetadata,
} from "@arbor/stores";
import { decodeWireObject, WireClient } from "@arbor/wire";
import { parseDocument, type Document } from "yaml";
import { ARBOR_SYNC_PORT, arborDaemonSupervisor } from "./daemon.ts";

type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" }
  | { kind: "rules"; rules: Array<
      | { subject: { kind: "everyone" }; access: "read" | "write" }
      | { subject: { kind: "profile"; locator: string }; access: "read" | "write" }
    > };

function usage(): never {
  console.error(`Usage:
  arbor open <locator> [--port <number>]
  arbor daemon <install|uninstall|start|stop|restart|status|logs>
  arbor connect <community-url>
  arbor sync [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
  arbor sync <canonical-url> <local-path>
  arbor unsync <local-path> [<canonical-url>]
  arbor unsync <canonical-url> <local-path>
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

export async function attachedArborSyncURL(target: OpenTarget, port: number): Promise<URL | null> {
  const origin = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${origin}/v1/status`);
    if (!status.ok || (await status.json() as { service?: string }).service !== "arborsync") return null;
    if (target.path) {
      const client = new ArborSyncRESTClient({ baseURL: origin });
      await client.openSession(target.path);
      return new URL(`${origin}/render${target.path}`);
    }
    const browserURL = new URL(`${origin}/render`);
    if (target.remoteURL) browserURL.searchParams.set("browse", target.remoteURL);
    return browserURL;
  } catch {
    return null;
  }
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

export interface OpenTarget {
  path?: string;
  remoteURL?: string;
  profile?: { origin: string; handle: string; path: string };
}

export function openTarget(input: string, cwd = process.cwd()): OpenTarget {
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

export async function isReservedProfile(target: OpenTarget): Promise<boolean> {
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

export async function placedRemotePath(target: OpenTarget, client: ArborSyncRESTClient): Promise<string | null> {
  if (!target.remoteURL) return null;
  try {
    const canonical = canonicalTarget(target.remoteURL);
    const account = await new CommunityConfigStore().get();
    const token = account?.record.origin === canonical.endpoint ? account.accountToken : undefined;
    const remote = await new WireClient(canonical.endpoint, token).resolve(canonical.canonicalPath);
    const placement = (await client.trees()).snapshot.find((tree) => tree.id === remote.ref.tree && tree.osPath);
    if (!placement?.osPath) return null;
    return `${placement.osPath}${remote.ref.path === "/" ? "" : remote.ref.path}`;
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

async function withArborSync<T>(
  path: string,
  run: (
    client: ArborSyncRESTClient,
    service: { synchronizeNow(): Promise<void>; communityConfig: CommunityConfigStore },
  ) => Promise<T>,
): Promise<T> {
  if (!process.env.ARBOR_DATA_HOME) {
    const baseURL = process.env.ARBOR_SYNC_URL ?? `http://127.0.0.1:${ARBOR_SYNC_PORT}`;
    let client = new ArborSyncRESTClient({ baseURL });
    let compatible = await client.status().then(
      (status) => status.service === "arborsync" && status.protocolVersion === "v1",
      () => false,
    );
    if (!compatible && !process.env.ARBOR_SYNC_URL && process.platform === "darwin") {
      const supervisor = arborDaemonSupervisor();
      const status = await supervisor.status();
      if (!status.installed) throw new Error("Arbor Sync is not running; run `arbor daemon install` first");
      await supervisor.start();
      client = new ArborSyncRESTClient({ baseURL });
      compatible = true;
    }
    if (!compatible) {
      throw new Error(`A compatible Arbor Sync is not reachable at ${baseURL}; start \`arborsync --control\` with your user service manager`);
    }
    await client.openSession(path);
    return run(client, {
      communityConfig: new CommunityConfigStore(),
      async synchronizeNow() { await client.synchronizeNow(); },
    });
  }
  const running = await serveArborSync(path, { port: 0 });
  try {
    return await run(new ArborSyncRESTClient({ baseURL: running.url }), running.service);
  } finally {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  }
}

async function editConfigurationYAML(
  client: ArborSyncRESTClient,
  path: string,
  change: (document: Document) => void | Promise<void>,
): Promise<void> {
  const configuration = (await client.trees()).snapshot.find((tree) => tree.kind === "account-configuration");
  if (!configuration) throw new Error("The account-configuration tree is unavailable");
  const ref = { tree: configuration.id, path, stableKey: null } as const;
  const file = await client.file(ref);
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  await change(document);
  await client.writeText(ref, file.revision, document.toString({ lineWidth: 0 }));
}

async function configurationContext() {
  const snapshot = await loadAccountConfiguration();
  if (!snapshot.account || !snapshot.trees || !snapshot.currentDevice) {
    throw new Error("A valid account.yaml, trees.yaml, and current device file are required");
  }
  return { snapshot, devicePath: `/devices/${snapshot.currentDevice.id}.yaml` };
}

async function accessRulesFor(client: WireClient, audience: ShareAudience) {
  const raw = audience.kind === "private" ? [] : audience.kind === "everyone"
    ? [{ subject: { kind: "everyone" as const }, access: audience.access }]
    : audience.kind === "profile"
      ? [{ subject: { kind: "profile" as const, locator: audience.locator }, access: audience.access }]
      : audience.rules;
  return Promise.all(raw.map(async (rule) => rule.subject.kind === "profile"
    ? { subject: { kind: "profile" as const, tree: (await client.resolve(new URL(rule.subject.locator).pathname)).ref.tree }, access: rule.access }
    : rule));
}

async function connectCommand(args: string[]): Promise<void> {
  if (args.length !== 1) usage();
  const target = canonicalTarget(args[0]!);
  const token = process.env.ARBOR_ACCOUNT_TOKEN ?? await readSecret(`Account/device credential for ${target.endpoint}: `);
  if (!token) throw new Error("No account credential supplied");
  const store = new CommunityConfigStore();
  await store.storeProvisionalCredential(token);
  const wire = new WireClient(target.endpoint, token);
  const { account } = await wire.account();
  if (!account.device) throw new Error("The server did not identify the authenticated device");
  const configuration = await wire.currentSnapshot(account.configuration.id);
  await installConfigurationCheckout(configuration, account.device.id);
  await store.set(target.endpoint, token, {
    id: account.id,
    handle: account.handle,
    profileTree: account.profileTree,
    profileURL: account.profileURL,
    communityTree: account.community.id,
    communityURL: account.community.canonical!.locator,
    configurationTree: account.configuration.id,
    configurationRef: account.configuration.ref,
    configurationUpdate: account.configuration.update,
  });
  const record = await store.safe();
  if (!record) throw new Error("The community connection was not saved");
  console.log(`Connected as ~${record.handle} to ${record.communityURL ?? target.endpoint}`);
}

async function installConfigurationCheckout(
  current: Awaited<ReturnType<WireClient["currentSnapshot"]>>,
  deviceID: string,
): Promise<void> {
  const existing = await loadAccountConfiguration();
  if (existing.account && existing.trees && existing.currentDevice) {
    if (existing.currentDevice.id !== deviceID) throw new Error("This data home belongs to a different device");
    return;
  }
  const objects = new Map(current.snapshot.objects.map(({ hash, bytes }) => [hash, bytes]));
  const object = (hash: string, path: string) => {
    const bytes = objects.get(hash as never);
    if (!bytes) throw new Error(`Account configuration is missing ${path}`);
    return decodeWireObject(bytes);
  };
  const root = object(current.snapshot.root, "/");
  if (root.type !== "directory") throw new Error("Account configuration root must be a directory");
  const names = root.entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["account.yaml", "devices", "trees.yaml"])) {
    throw new Error("Account configuration contains unsupported root paths");
  }
  const source = (name: string): string => {
    const entry = root.entries.find((candidate) => candidate.name === name);
    if (!entry?.hash || entry.tree) throw new Error(`Account configuration requires ${name}`);
    const value = object(entry.hash, name);
    if (value.type !== "file") throw new Error(`${name} must be a file`);
    return new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
  };
  const accountSource = source("account.yaml");
  const treesSource = source("trees.yaml");
  parseAccountConfiguration(accountSource);
  parseTreesConfiguration(treesSource);
  const devicesEntry = root.entries.find((entry) => entry.name === "devices")!;
  if (!devicesEntry.hash || devicesEntry.tree) throw new Error("Account configuration requires devices/");
  const devices = object(devicesEntry.hash, "devices");
  if (devices.type !== "directory") throw new Error("devices must be a directory");
  const deviceSources = new Map<string, string>();
  for (const entry of devices.entries) {
    const match = /^(dv_[a-z2-7]+)\.yaml$/.exec(entry.name);
    if (!match || !entry.hash || entry.tree) throw new Error(`Unsupported account configuration path: devices/${entry.name}`);
    const value = object(entry.hash, `devices/${entry.name}`);
    if (value.type !== "file") throw new Error(`devices/${entry.name} must be a file`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
    parseDeviceConfiguration(text, match[1]!, `devices/${entry.name}`);
    deviceSources.set(entry.name, text);
  }
  if (!deviceSources.has(`${deviceID}.yaml`)) throw new Error("Authenticated device is absent from the account configuration");

  const home = arborDataRoot();
  let existingTrees: string | undefined;
  try {
    existingTrees = await readFile(join(home, "trees.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let legacyTrees: string | undefined;
  if (existingTrees !== undefined) {
    try {
      parseTreesConfiguration(existingTrees);
      if (existingTrees !== treesSource) throw new Error("Account configuration checkout collides with existing trees.yaml");
      try {
        legacyTrees = await readFile(join(home, ".state", "migration", "legacy-trees.yaml"), "utf8");
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code !== "ENOENT") throw backupError;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Account configuration checkout collides with existing trees.yaml") throw error;
      legacyTrees = existingTrees;
    }
  }
  const legacyMetadata: Array<{ tree: string; ref?: string; update?: string; access?: "read" | "write" }> = [];
  if (legacyTrees !== undefined) {
    const document = parseDocument(legacyTrees, { uniqueKeys: true });
    if (document.errors.length) throw new Error(`Legacy trees.yaml is invalid: ${document.errors[0]!.message}`);
    const value = document.toJS() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Legacy trees.yaml must be a path-keyed mapping");
    const declarations = parseTreesConfiguration(treesSource).trees;
    const deviceDocument = parseDocument(deviceSources.get(`${deviceID}.yaml`)!, { uniqueKeys: true, keepSourceTokens: true });
    const seen = new Set<string>();
    for (const [path, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!isAbsolute(path) || normalize(path) !== path || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Legacy tree placement is invalid: ${path}`);
      }
      const placement = raw as Record<string, unknown>;
      if (placement.source === "local") continue;
      const tree = placement.tree;
      const endpoint = placement.endpoint;
      if (typeof tree !== "string" || typeof endpoint !== "string" || !declarations[tree]) {
        throw new Error(`Legacy shared placement is not represented by the migrated server configuration: ${path}`);
      }
      if (seen.has(tree)) throw new Error(`Legacy trees.yaml places ${tree} more than once`);
      seen.add(tree);
      deviceDocument.setIn(["placements", tree], { server: new URL(endpoint).origin, path });
      legacyMetadata.push({
        tree,
        ...(typeof placement.ref === "string" ? { ref: placement.ref } : {}),
        ...(typeof placement.update === "string" ? { update: placement.update } : {}),
        ...(placement.access === "read" || placement.access === "write" ? { access: placement.access } : {}),
      });
    }
    const migratedDeviceSource = deviceDocument.toString({ lineWidth: 0 });
    parseDeviceConfiguration(migratedDeviceSource, deviceID, `devices/${deviceID}.yaml`);
    deviceSources.set(`${deviceID}.yaml`, migratedDeviceSource);
  }
  for (const name of ["account.yaml"]) {
    try {
      const existingSource = await readFile(join(home, name), "utf8");
      if (existingSource !== accountSource) throw new Error(`Account configuration checkout collides with existing ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const entries = await readdir(join(home, "devices"));
    for (const name of entries) {
      const expected = deviceSources.get(name);
      const existingSource = await readFile(join(home, "devices", name), "utf8");
      if (expected === undefined || existingSource !== expected) {
        throw new Error("Account configuration checkout collides with existing devices");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(dirname(home), ".arbor-config-bootstrap-"));
  try {
    await mkdir(join(staging, "devices"), { mode: 0o700 });
    await writeFile(join(staging, "account.yaml"), accountSource, { mode: 0o600 });
    await writeFile(join(staging, "trees.yaml"), treesSource, { mode: 0o600 });
    for (const [name, text] of deviceSources) await writeFile(join(staging, "devices", name), text, { mode: 0o600 });
    if (legacyTrees !== undefined) {
      const migration = join(home, ".state", "migration");
      await mkdir(migration, { recursive: true, mode: 0o700 });
      const backup = join(migration, "legacy-trees.yaml");
      try {
        const previous = await readFile(backup, "utf8");
        if (previous !== legacyTrees) throw new Error(`Migration backup collision: ${backup}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") await writeFile(backup, legacyTrees, { mode: 0o600, flag: "wx" });
        else throw error;
      }
    }
    await rename(join(staging, "account.yaml"), join(home, "account.yaml"));
    await rename(join(staging, "trees.yaml"), join(home, "trees.yaml"));
    await rm(join(home, "devices"), { recursive: true, force: true });
    await rename(join(staging, "devices"), join(home, "devices"));
    await saveCurrentDeviceID(deviceID);
    for (const metadata of legacyMetadata) await savePlacementSyncMetadata(metadata.tree, metadata);
  } finally {
    await rm(staging, { recursive: true, force: true });
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
  await withArborSync(path, async (client, service) => {
    // Configuration is synchronized content too. Merge it before deriving a
    // file edit so this device cannot add a placement to a stale trees.yaml.
    await service.synchronizeNow();
    const config = await configurationContext();
    if (config.snapshot.account!.community !== target.endpoint) {
      throw new Error(`Claim or activate a writable profile at ${target.endpoint} before sharing there`);
    }
    const existing = Object.entries(config.snapshot.currentDevice!.placements).find(([, placement]) => placement.path === path);
    let tree = existing?.[0];
    const isNew = !tree;
    if (tree) {
      const declaration = config.snapshot.trees!.trees[tree]!;
      const samePath = declaration.canonicalPath === target.canonicalPath;
      if (!samePath) throw new Error(`${path} already has a different canonical URL`);
    } else {
      tree = await client.treeID();
      const indexSource = await readFile(join(path, "_index.md"), "utf8").catch(() => "");
      const kind = /^type:\s*group\s*$/m.test(indexSource) ? "group-profile" : "shared-subtree";
      const configured = await service.communityConfig.get();
      if (!configured) throw new Error("The server credential is unavailable");
      const rules = await accessRulesFor(new WireClient(target.endpoint, configured.accountToken), initialAudience(audience, target));
      await editConfigurationYAML(client, "/trees.yaml", (document) => {
        document.setIn(["trees", tree!], { kind, canonicalPath: target.canonicalPath, access: rules });
      });
      await editConfigurationYAML(client, config.devicePath, (document) => {
        document.setIn(["placements", tree!], { server: target.endpoint, path });
      });
    }
    if (tree && !isNew) {
      const declaration = config.snapshot.trees!.trees[tree]!;
      let rules = [...declaration.access];
      for (const operation of audience) {
        if (operation.kind === "clear") {
          rules = [];
        } else {
          const subject = accessSubject(operation.subject, target);
          const normalized = subject.kind === "everyone" ? { kind: "everyone" as const }
            : { kind: "profile" as const, tree: (await new WireClient(target.endpoint).resolve(new URL(subject.locator).pathname)).ref.tree };
          const key = JSON.stringify(normalized);
          rules = rules.filter((rule) => JSON.stringify(rule.subject) !== key);
          if (operation.access !== "none") rules.push({ subject: normalized, access: operation.access });
        }
      }
      await editConfigurationYAML(client, "/trees.yaml", (document) => document.setIn(["trees", tree!, "access"], rules));
    }
    if (isNew && audience.length === 0) {
      console.warn(`Warning: no audience options supplied; created ${target.supplied} with private access.`);
    }
    await service.synchronizeNow();
    console.log(`${target.supplied} ↔ ${path}`);
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
  await withArborSync(dirname(destination), async (client, service) => {
    const configured = await service.communityConfig.get();
    const accountToken = configured?.record.origin === target.endpoint ? configured.accountToken : undefined;
    const remote = await new WireClient(target.endpoint, accountToken).resolve(target.canonicalPath);
    const descriptor = remote.enclosingTree;
    if (!descriptor?.canonical) throw new Error("Server resolution omitted its canonical tree");
    await service.synchronizeNow();
    const config = await configurationContext();
    const existing = config.snapshot.currentDevice!.placements[descriptor.id];
    if (!existing) {
      await editConfigurationYAML(client, config.devicePath, (document) => document.setIn(
        ["placements", descriptor.id], { server: target.endpoint, path: destination },
      ));
    }
    await service.synchronizeNow();
    console.log(`${descriptor.canonical.locator} ↔ ${destination} (${descriptor.access})`);
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
  await withArborSync(await stat(path).then((value) => value.isDirectory()).catch(() => false) ? path : dirname(path), async (client, service) => {
    await service.synchronizeNow();
    const config = await configurationContext();
    const existing = Object.entries(config.snapshot.currentDevice!.placements).find(([, placement]) => placement.path === path);
    if (!existing) throw new Error(`No shared tree placement at ${path}`);
    if (target) {
      const declaration = config.snapshot.trees!.trees[existing[0]];
      if (!declaration || declaration.canonicalPath !== target.canonicalPath || config.snapshot.account!.community !== target.endpoint) {
        throw new Error(`${path} is not synced with ${target.supplied}`);
      }
    }
    await editConfigurationYAML(client, config.devicePath, (document) => { document.deleteIn(["placements", existing[0]]); });
    console.log(`${target?.supplied ?? existing[0]} ↮ ${path}`);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "daemon") {
    if (args.length !== 1) usage();
    const supervisor = arborDaemonSupervisor();
    const [action] = args;
    if (action === "install") console.log(await supervisor.install());
    else if (action === "uninstall") console.log(await supervisor.uninstall());
    else if (action === "start") console.log(await supervisor.start());
    else if (action === "stop") console.log(await supervisor.stop());
    else if (action === "restart") console.log(await supervisor.restart());
    else if (action === "logs") console.log(await supervisor.logs());
    else if (action === "status") {
      const status = await supervisor.status();
      console.log(`Arbor Sync: ${status.state}`);
      console.log(`Supervision: ${status.installed ? "installed" : "not installed"} (${status.platform})`);
      console.log(`Origin: ${status.origin}`);
      if (status.pid) console.log(`PID: ${status.pid}`);
      console.log(status.detail);
    } else usage();
    return;
  }
  if (command === "open") {
    const portIndex = args.indexOf("--port");
    const portValue = portIndex >= 0 ? args[portIndex + 1] : undefined;
    if (portIndex >= 0 && (!portValue || portValue.startsWith("--"))) throw new Error("--port requires a number");
    const port = Number(portValue ?? ARBOR_SYNC_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Arbor Sync port must be an integer from 0 through 65535");
    const positionals = args.filter((arg, index) => !arg.startsWith("--") && index !== portIndex + 1);
    const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--port");
    if (unknown.length || positionals.length > 1) usage();
    const input = positionals[0] ?? ".";
    const target = openTarget(input);
    let attached = await attachedArborSyncURL(target, port);
    if (!attached && !process.env.ARBOR_DATA_HOME && port === ARBOR_SYNC_PORT && process.platform === "darwin") {
      const supervisor = arborDaemonSupervisor();
      const status = await supervisor.status();
      if (!status.installed) throw new Error("Arbor Sync is not running; run `arbor daemon install` first");
      await supervisor.start();
      attached = await attachedArborSyncURL(target, port);
      if (!attached) throw new Error(`Arbor Sync started but could not open ${input}`);
    }
    if (attached) {
      if (target.remoteURL && await isReservedProfile(target)) attached.searchParams.set("claimable", "true");
      console.log(`Attached to Arbor Sync at ${attached.origin}`);
      await openBrowser(attached.toString());
      return;
    }
    if (!process.env.ARBOR_DATA_HOME) {
      throw new Error(`A compatible Arbor Sync is not reachable on port ${port}; run \`arbor daemon status\` for details`);
    }
    const running = target.remoteURL
      ? await serveArborSyncControl({ port })
      : await serveArborSync(target.path!, { port });
    const { service, server, url } = running;
    let start = "";
    if (running.mode === "workspace") {
      start = running.start;
      const descriptor = running.workspace.descriptor();
      const scope = descriptor.canonical
        ? `shared tree "${descriptor.name}"`
        : "ordinary local files";
      console.log(`Arbor Sync is serving ${start} (${scope})`);
    } else {
      console.log(`Arbor Sync is opening ${target.remoteURL}`);
    }
    console.log(url);
    const claimable = target.remoteURL ? await isReservedProfile(target) : false;
    const placedPath = target.remoteURL && !claimable
      ? await placedRemotePath(target, new ArborSyncRESTClient({ baseURL: url }))
      : null;
    const browserURL = new URL(`${url}/render${placedPath ?? start}`);
    if (target.remoteURL) {
      if (!placedPath) browserURL.searchParams.set("browse", target.remoteURL);
      if (claimable) browserURL.searchParams.set("claimable", "true");
    }
    await openBrowser(browserURL.toString());
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
